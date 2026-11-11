// ABOUTME: Resolves which Kiro account an OAuth credential belongs to.
// ABOUTME: Hosts key multi-account rotation and login dedupe on accountId/email.

import { resolveApiRegion } from "./endpoints.js";
import { getUsageLimits, resolveKiroProfileArn } from "./management.js";
import type { KiroCredentials } from "./oauth.js";

export interface KiroAccountIdentity {
  /** Kiro's account id, e.g. `d-<directory>.<user>` for IAM Identity Center. */
  accountId: string;
  email?: string;
}

/**
 * The account behind `credential`. Kiro access tokens are opaque — unlike Codex
 * or Anthropic JWTs a host cannot decode an identity from them — so ask the
 * management plane, which reports the signed-in user on `GetUsageLimits`.
 * Returns undefined when the lookup fails: identity is advisory, and a login or
 * refresh must never fail because of it.
 */
export async function resolveKiroAccountIdentity(
  credential: Pick<KiroCredentials, "access"> & Partial<Pick<KiroCredentials, "region" | "profileArn">>,
): Promise<KiroAccountIdentity | undefined> {
  try {
    const auth = { accessToken: credential.access, region: resolveApiRegion(credential.region) };
    const profileArn = await resolveKiroProfileArn(auth, credential.profileArn);
    const { userInfo } = await getUsageLimits<{ userInfo?: { userId?: unknown; email?: unknown } }>(auth, {
      profileArn,
      origin: "KIRO_CLI",
      resourceType: "CREDIT",
      isEmailRequired: true,
    });
    const accountId = typeof userInfo?.userId === "string" ? userInfo.userId.trim() : "";
    if (!accountId) return undefined;
    const email = typeof userInfo?.email === "string" ? userInfo.email.trim() : "";
    return email ? { accountId, email } : { accountId };
  } catch {
    return undefined;
  }
}

/**
 * Whether `candidate` — a kiro-cli or Kiro IDE credential — is the same sign-in
 * as `current`. An equal refresh token is the same session. Otherwise the stored
 * account id decides; only when that is unknown does this ask Kiro. Adopting a
 * candidate from another account is what collapsed two accounts into whichever
 * one refreshed last.
 */
export async function isSameKiroSession(current: KiroCredentials, candidate: KiroCredentials): Promise<boolean> {
  const currentToken = current.refresh.split("|")[0];
  const candidateToken = candidate.refresh.split("|")[0];
  if (currentToken && currentToken === candidateToken) return true;
  // Credentials stored before identities were recorded cannot be told apart;
  // keep the historical adoption so an upgraded host still recovers a rotated
  // CLI token. Once either side carries an account, it must match.
  if (!current.accountId && !candidate.accountId) return true;
  if (candidate.accountId) return Boolean(current.accountId) && candidate.accountId === current.accountId;
  if (!current.accountId) return false;
  const identity = await resolveKiroAccountIdentity(candidate);
  return Boolean(identity && identity.accountId === current.accountId);
}

/**
 * Stamp `credential` with its account. A credential still on the same refresh
 * token is the same sign-in session, so it keeps the identity it carried. A
 * different refresh token — a new login, or a kiro-cli session that switched
 * user — is looked up again, so a stale identity never outlives the account.
 */
export async function withKiroAccountIdentity<T extends KiroCredentials>(
  credential: T,
  previous?: Partial<KiroAccountIdentity> & { refresh?: string },
): Promise<T> {
  if (credential.authMethod === "apikey") return credential;
  const sameSession = previous?.refresh?.split("|")[0] === credential.refresh.split("|")[0];
  if (previous?.accountId && sameSession) {
    return { ...credential, accountId: previous.accountId, ...(previous.email ? { email: previous.email } : {}) };
  }
  const identity = await resolveKiroAccountIdentity(credential);
  return identity ? { ...credential, ...identity } : credential;
}
