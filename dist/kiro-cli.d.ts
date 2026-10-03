import type { KiroAuthMethod, KiroCredentials } from "./oauth.js";
export declare function getKiroCliDbPath(): string | undefined;
export declare function getKiroCliCredentials(): KiroCredentials | undefined;
/**
 * Like getKiroCliCredentials but returns credentials even when the access token
 * is expired, as long as a refresh token exists. Used to attempt a token refresh
 * before falling back to the full device code login flow.
 */
export declare function getKiroCliCredentialsAllowExpired(): KiroCredentials | undefined;
declare function tryKiroCliToken(dbPath: string, tokenKey: string, authMethod: KiroAuthMethod, allowExpired?: boolean): KiroCredentials | undefined;
export { tryKiroCliToken };
/**
 * Get the social token (Google/GitHub) from kiro-cli if available.
 * Returns undefined if no valid social token exists.
 * This is used to prefer social login when the user has logged in that way.
 */
export declare function getKiroCliSocialToken(): KiroCredentials | undefined;
/**
 * Like getKiroCliSocialToken but returns credentials even when the access token
 * is expired, as long as a refresh token exists.
 */
export declare function getKiroCliSocialTokenAllowExpired(): KiroCredentials | undefined;
export declare function saveKiroCliCredentials(creds: KiroCredentials): void;
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
export declare function getKiroCliIdcRegistration(region: string): KiroCliIdcRegistration | undefined;
/** The start URL and region of kiro-cli's last IAM Identity Center login. */
export declare function getKiroCliIdcLogin(): {
    startUrl: string;
    region: string;
} | undefined;
/**
 * Record a device-code IAM Identity Center login exactly where and how kiro-cli
 * records its own, so `kiro-cli` sees the session as signed in and both tools
 * keep refreshing one token family. No-op when kiro-cli is not installed.
 */
export declare function saveKiroCliIdcSession(session: {
    registration: KiroCliIdcRegistration;
    accessToken: string;
    refreshToken: string;
    /** Absolute expiry of the access token, epoch ms. */
    expiresAt: number;
    region: string;
    startUrl: string;
    scopes: readonly string[];
}): void;
/**
 * Ask kiro-cli to refresh its own tokens via `kiro-cli debug refresh-auth-token`,
 * then re-read the SQLite DB for fresh credentials.
 *
 * Returns refreshed credentials on success, or undefined if kiro-cli is not
 * installed, the command fails, or the DB still has no valid tokens afterward.
 */
export declare function refreshViaKiroCli(): KiroCredentials | undefined;
