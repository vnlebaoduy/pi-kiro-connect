// ABOUTME: Reads and writes credentials from the kiro-cli SQLite database.
// ABOUTME: Provides fallback auth and write-back to keep kiro-cli in sync after refresh.

import { execFileSync, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { formatSafeError } from "./debug.js";
import type { KiroAuthMethod, KiroCredentials } from "./oauth.js";

const require = createRequire(import.meta.url);

/** kiro-cli's secret-store key for an enterprise external IdP (OIDC) session. */
const EXTERNAL_IDP_TOKEN_KEY = "kirocli:external-idp:token";

export function getKiroCliDbPath(): string | undefined {
  const p = platform();
  let dbPath: string;
  if (p === "win32")
    dbPath = join(process.env.APPDATA || join(homedir(), "AppData", "Roaming"), "kiro-cli", "data.sqlite3");
  else if (p === "darwin") dbPath = join(homedir(), "Library", "Application Support", "kiro-cli", "data.sqlite3");
  else dbPath = join(homedir(), ".local", "share", "kiro-cli", "data.sqlite3");
  return existsSync(dbPath) ? dbPath : undefined;
}

function getNodeSqlite(): typeof import("node:sqlite") | undefined {
  try {
    return require("node:sqlite") as typeof import("node:sqlite");
  } catch {
    return undefined;
  }
}

function queryKiroCliDb(dbPath: string, sql: string): string | undefined {
  const sqlite = getNodeSqlite();
  if (sqlite) {
    try {
      const db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare(sql).all() as unknown[];
        const result = JSON.stringify(rows);
        return result === "[]" ? undefined : result;
      } finally {
        db.close();
      }
    } catch {
      // Fall through to sqlite3 CLI fallback
    }
  }

  try {
    const result = execSync(`sqlite3 -json "${dbPath}" "${sql}"`, {
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return result || undefined;
  } catch {
    return undefined;
  }
}

function execKiroCliDb(dbPath: string, sql: string): boolean {
  const sqlite = getNodeSqlite();
  if (sqlite) {
    try {
      const db = new sqlite.DatabaseSync(dbPath);
      try {
        db.exec(sql);
        return true;
      } finally {
        db.close();
      }
    } catch {
      // Fall through to sqlite3 CLI fallback
    }
  }

  try {
    execSync(`sqlite3 "${dbPath}"`, {
      input: sql,
      encoding: "utf-8",
      timeout: 5000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

export function getKiroCliCredentials(): KiroCredentials | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;
  try {
    // Try IDC token first (preferred — has clientId/clientSecret for refresh)
    const idcCreds = tryKiroCliToken(dbPath, "kirocli:odic:token", "idc");
    if (idcCreds) return idcCreds;

    // Fall back to desktop/social token
    const desktopCreds = tryKiroCliToken(dbPath, "kirocli:social:token", "desktop");
    if (desktopCreds) return desktopCreds;

    // Enterprise external IdP (OIDC) login — refreshed against the customer's
    // own token endpoint rather than AWS SSO
    const externalIdpCreds = tryKiroCliToken(dbPath, EXTERNAL_IDP_TOKEN_KEY, "external-idp");
    if (externalIdpCreds) return externalIdpCreds;

    return undefined;
  } catch {
    return undefined;
  }
}

/**
 * Like getKiroCliCredentials but returns credentials even when the access token
 * is expired, as long as a refresh token exists. Used to attempt a token refresh
 * before falling back to the full device code login flow.
 */
export function getKiroCliCredentialsAllowExpired(): KiroCredentials | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;
  try {
    const idcCreds = tryKiroCliToken(dbPath, "kirocli:odic:token", "idc", true);
    if (idcCreds) return idcCreds;

    const desktopCreds = tryKiroCliToken(dbPath, "kirocli:social:token", "desktop", true);
    if (desktopCreds) return desktopCreds;

    const externalIdpCreds = tryKiroCliToken(dbPath, EXTERNAL_IDP_TOKEN_KEY, "external-idp", true);
    if (externalIdpCreds) return externalIdpCreds;

    return undefined;
  } catch {
    return undefined;
  }
}

function tryKiroCliToken(
  dbPath: string,
  tokenKey: string,
  authMethod: KiroAuthMethod,
  allowExpired = false,
): KiroCredentials | undefined {
  const tokenResult = queryKiroCliDb(dbPath, `SELECT value FROM auth_kv WHERE key = '${tokenKey}'`);
  if (!tokenResult) return undefined;
  const rows = JSON.parse(tokenResult) as Array<{ value: string }>;
  if (!rows[0]?.value) return undefined;
  const tokenData = JSON.parse(rows[0].value);
  if (!tokenData.access_token || !tokenData.refresh_token) return undefined;
  let expiresAt = Date.now() + 3600000;
  if (tokenData.expires_at) expiresAt = new Date(tokenData.expires_at).getTime();
  if (!allowExpired && Date.now() >= expiresAt - 2 * 60 * 1000) return undefined;
  const region = tokenData.region || "us-east-1";

  if (authMethod === "desktop") {
    return {
      refresh: `${tokenData.refresh_token}|desktop`,
      access: tokenData.access_token,
      expires: expiresAt,
      clientId: "",
      clientSecret: "",
      region,
      authMethod: "desktop",
      profileArn: tokenData.profile_arn || tokenData.profileArn,
    };
  }

  // External IdP — the customer's own OIDC app. It is a public PKCE client, so
  // there is no client secret; carry the token endpoint through the refresh
  // string because it is per-tenant and not derivable from a region.
  if (authMethod === "external-idp") {
    const idpClientId = tokenData.client_id || tokenData.clientId || "";
    const issuerUrl: string = tokenData.issuer_url || "";
    const tokenEndpoint =
      tokenData.token_endpoint ||
      tokenData.tokenEndpoint ||
      (issuerUrl ? `${issuerUrl.replace(/\/+$/, "")}/v1/token` : "");
    return {
      refresh: `${tokenData.refresh_token}|${idpClientId}|${tokenEndpoint}|external-idp`,
      access: tokenData.access_token,
      expires: expiresAt,
      clientId: idpClientId,
      clientSecret: "",
      region,
      authMethod: "external-idp",
      profileArn: tokenData.profile_arn || tokenData.profileArn,
    };
  }

  // IDC — need device registration credentials for refresh
  const { clientId, clientSecret } = readDeviceRegistration(dbPath, tokenKey) ?? { clientId: "", clientSecret: "" };
  return {
    refresh: `${tokenData.refresh_token}|${clientId}|${clientSecret}|idc`,
    access: tokenData.access_token,
    expires: expiresAt,
    clientId,
    clientSecret,
    region,
    authMethod: "idc",
    profileArn: tokenData.profile_arn || tokenData.profileArn,
  };
}

/**
 * The OIDC client kiro-cli registered for the token stored under `tokenKey`.
 * The device-registration key shares the token key's prefix ("kirocli" or
 * "codewhisperer"). An IDC refresh token is bound to the client that issued it.
 */
function readDeviceRegistration(
  dbPath: string,
  tokenKey: string,
): { clientId: string; clientSecret: string } | undefined {
  const keyPrefix = tokenKey.split(":")[0];
  const deviceResult = queryKiroCliDb(
    dbPath,
    `SELECT value FROM auth_kv WHERE key = '${keyPrefix}:odic:device-registration'`,
  );
  if (!deviceResult) return undefined;
  try {
    const d = JSON.parse(JSON.parse(deviceResult)[0]?.value);
    return { clientId: d.client_id || d.clientId || "", clientSecret: d.client_secret || d.clientSecret || "" };
  } catch {
    return undefined;
  }
}

// Re-export the internal function for use by getKiroCliSocialToken
export { tryKiroCliToken };

/**
 * Get the social token (Google/GitHub) from kiro-cli if available.
 * Returns undefined if no valid social token exists.
 * This is used to prefer social login when the user has logged in that way.
 */
export function getKiroCliSocialToken(): KiroCredentials | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;
  try {
    return tryKiroCliToken(dbPath, "kirocli:social:token", "desktop");
  } catch {
    return undefined;
  }
}

/**
 * Like getKiroCliSocialToken but returns credentials even when the access token
 * is expired, as long as a refresh token exists.
 */
export function getKiroCliSocialTokenAllowExpired(): KiroCredentials | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;
  try {
    return tryKiroCliToken(dbPath, "kirocli:social:token", "desktop", true);
  } catch {
    return undefined;
  }
}

const TOKEN_KEY_BY_AUTH_METHOD: Record<KiroAuthMethod, string[]> = {
  idc: ["kirocli:odic:token", "codewhisperer:odic:token"],
  desktop: ["kirocli:social:token"],
  "external-idp": [EXTERNAL_IDP_TOKEN_KEY],
  apikey: [],
};

export function saveKiroCliCredentials(creds: KiroCredentials): void {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return;

  const rawRefreshToken = creds.refresh.split("|")[0] ?? "";
  // Our expires has a 5-min buffer subtracted; restore approximate actual expiry for kiro-cli
  const expiresAt = new Date(creds.expires + 5 * 60 * 1000).toISOString();
  const tokenKeys = TOKEN_KEY_BY_AUTH_METHOD[creds.authMethod] ?? [];

  for (const key of tokenKeys) {
    // kiro-cli pairs whatever refresh token sits under the IDC key with its own
    // device registration. Writing a token issued to a different client (a pi
    // login that registered its own) yields a pair AWS rejects with
    // invalid_grant once the access token expires.
    if (creds.authMethod === "idc" && readDeviceRegistration(dbPath, key)?.clientId !== creds.refresh.split("|")[1]) {
      continue;
    }
    const existing = queryKiroCliDb(dbPath, `SELECT value FROM auth_kv WHERE key = '${key}'`);
    if (!existing) continue;

    try {
      const rows = JSON.parse(existing) as Array<{ value: string }>;
      if (!rows[0]?.value) continue;
      const tokenData = JSON.parse(rows[0].value);

      tokenData.access_token = creds.access;
      tokenData.refresh_token = rawRefreshToken;
      tokenData.expires_at = expiresAt;
      // kiro-cli's ExternalIdpToken record has no region/profile_arn fields;
      // don't add keys it never wrote.
      if (creds.authMethod !== "external-idp") {
        if (creds.region) tokenData.region = creds.region;
        if (creds.profileArn) tokenData.profile_arn = creds.profileArn;
      }

      const escaped = JSON.stringify(tokenData).replace(/'/g, "''");
      const sql = `UPDATE auth_kv SET value = '${escaped}' WHERE key = '${key}';`;
      if (execKiroCliDb(dbPath, sql)) return;
    } catch {}
  }
}

/** kiro-cli's OIDC client for one IAM Identity Center region, as it stores it. */
export interface KiroCliIdcRegistration {
  clientId: string;
  clientSecret: string;
  /** ISO-8601 instant after which AWS rejects the client secret. */
  clientSecretExpiresAt: string;
}

/**
 * The client kiro-cli registered for `region`, if it is still usable. Reusing it
 * means AWS sees exactly one "Kiro CLI" client per user, and a token minted by
 * either tool refreshes with the registration the other reads back.
 */
export function getKiroCliIdcRegistration(region: string): KiroCliIdcRegistration | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;
  const raw = queryKiroCliDb(dbPath, "SELECT value FROM auth_kv WHERE key = 'kirocli:odic:device-registration'");
  if (!raw) return undefined;
  try {
    const d = JSON.parse(JSON.parse(raw)[0]?.value);
    // An hour of headroom: a login started now must finish before the secret lapses.
    const usable = new Date(d.client_secret_expires_at).getTime() - 60 * 60 * 1000 > Date.now();
    if (d.region !== region || !d.client_id || !d.client_secret || !usable) return undefined;
    return { clientId: d.client_id, clientSecret: d.client_secret, clientSecretExpiresAt: d.client_secret_expires_at };
  } catch {
    return undefined;
  }
}

/** The start URL and region of kiro-cli's last IAM Identity Center login. */
export function getKiroCliIdcLogin(): { startUrl: string; region: string } | undefined {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return undefined;
  const raw = queryKiroCliDb(
    dbPath,
    "SELECT key, value FROM state WHERE key IN ('auth.idc.start-url', 'auth.idc.region')",
  );
  if (!raw) return undefined;
  try {
    const rows = JSON.parse(raw) as Array<{ key: string; value: string }>;
    const value = (key: string) => {
      const row = rows.find((r) => r.key === key);
      return row ? (JSON.parse(String(row.value)) as unknown) : undefined;
    };
    const startUrl = value("auth.idc.start-url");
    const region = value("auth.idc.region");
    return typeof startUrl === "string" && typeof region === "string" ? { startUrl, region } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Record a device-code IAM Identity Center login exactly where and how kiro-cli
 * records its own, so `kiro-cli` sees the session as signed in and both tools
 * keep refreshing one token family. No-op when kiro-cli is not installed.
 */
export function saveKiroCliIdcSession(session: {
  registration: KiroCliIdcRegistration;
  accessToken: string;
  refreshToken: string;
  /** Absolute expiry of the access token, epoch ms. */
  expiresAt: number;
  region: string;
  startUrl: string;
  scopes: readonly string[];
}): void {
  const dbPath = getKiroCliDbPath();
  if (!dbPath) return;
  const quote = (value: unknown) => `'${JSON.stringify(value).replace(/'/g, "''")}'`;
  const registration = {
    client_id: session.registration.clientId,
    client_secret: session.registration.clientSecret,
    client_secret_expires_at: session.registration.clientSecretExpiresAt,
    region: session.region,
    oauth_flow: "DeviceCode",
    scopes: session.scopes,
  };
  const token = {
    access_token: session.accessToken,
    expires_at: new Date(session.expiresAt).toISOString(),
    refresh_token: session.refreshToken,
    region: session.region,
    start_url: session.startUrl,
    oauth_flow: "DeviceCode",
    scopes: session.scopes,
  };
  execKiroCliDb(
    dbPath,
    [
      "BEGIN;",
      `INSERT OR REPLACE INTO auth_kv (key, value) VALUES ('kirocli:odic:device-registration', ${quote(registration)});`,
      `INSERT OR REPLACE INTO auth_kv (key, value) VALUES ('kirocli:odic:token', ${quote(token)});`,
      `INSERT OR REPLACE INTO state (key, value) VALUES ('auth.idc.start-url', ${quote(session.startUrl)});`,
      `INSERT OR REPLACE INTO state (key, value) VALUES ('auth.idc.region', ${quote(session.region)});`,
      "COMMIT;",
    ].join("\n"),
  );
}

/**
 * Ask kiro-cli to refresh its own tokens via `kiro-cli debug refresh-auth-token`,
 * then re-read the SQLite DB for fresh credentials.
 *
 * Returns refreshed credentials on success, or undefined if kiro-cli is not
 * installed, the command fails, or the DB still has no valid tokens afterward.
 */
export function refreshViaKiroCli(): KiroCredentials | undefined {
  try {
    execFileSync("kiro-cli", ["debug", "refresh-auth-token"], {
      timeout: 15000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return getKiroCliCredentials();
  } catch (error) {
    console.warn(`[pi-kiro-connect] kiro-cli refresh failed: ${formatSafeError(error)}`);
    return undefined;
  }
}
