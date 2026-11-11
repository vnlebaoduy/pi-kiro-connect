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
export declare function resolveKiroAccountIdentity(credential: Pick<KiroCredentials, "access"> & Partial<Pick<KiroCredentials, "region" | "profileArn">>): Promise<KiroAccountIdentity | undefined>;
/**
 * Whether `candidate` — a kiro-cli or Kiro IDE credential — is the same sign-in
 * as `current`. An equal refresh token is the same session. Otherwise the stored
 * account id decides; only when that is unknown does this ask Kiro. Adopting a
 * candidate from another account is what collapsed two accounts into whichever
 * one refreshed last.
 */
export declare function isSameKiroSession(current: KiroCredentials, candidate: KiroCredentials): Promise<boolean>;
/**
 * Stamp `credential` with its account. A credential still on the same refresh
 * token is the same sign-in session, so it keeps the identity it carried. A
 * different refresh token — a new login, or a kiro-cli session that switched
 * user — is looked up again, so a stale identity never outlives the account.
 */
export declare function withKiroAccountIdentity<T extends KiroCredentials>(credential: T, previous?: Partial<KiroAccountIdentity> & {
    refresh?: string;
}): Promise<T>;
