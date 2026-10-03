// ABOUTME: Derives the `tokentype` request header Kiro requires for external IdP bearer tokens.
// ABOUTME: Kiro rejects an external IdP access token with 403 unless the header is present.

/**
 * Audience claim Kiro's external IdP integration issues tokens for. kiro-cli
 * configures the customer's OIDC app with this audience, so it is the reliable
 * signal that a bearer token came from an external IdP rather than AWS SSO.
 */
const EXTERNAL_IDP_AUDIENCE = "api://kiro";

/**
 * True when the access token is an external IdP (enterprise OIDC) JWT.
 *
 * AWS SSO / Builder ID and Kiro desktop tokens are opaque strings, so a
 * three-segment JWT carrying `aud: "api://kiro"` identifies the external IdP
 * case without needing the auth method threaded through every call site.
 */
export function isExternalIdpAccessToken(accessToken: string | undefined): boolean {
  if (typeof accessToken !== "string") return false;
  const segments = accessToken.split(".");
  if (segments.length !== 3) return false;
  const payloadSegment = segments[1];
  if (!payloadSegment) return false;
  try {
    const payload = JSON.parse(
      Buffer.from(payloadSegment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf-8"),
    ) as { aud?: unknown };
    return payload.aud === EXTERNAL_IDP_AUDIENCE;
  } catch {
    return false;
  }
}

/**
 * Extra headers Kiro's management and runtime APIs require for the given token.
 *
 * kiro-cli sends `tokentype: EXTERNAL_IDP` on every request made with an
 * external IdP token (its `TokenTypeInterceptor`); without it both
 * `management.*.kiro.dev` and `runtime.*.kiro.dev` answer 403 "Invalid token".
 * Returns an empty object for AWS SSO and desktop tokens, which must not carry
 * the header.
 */
export function kiroTokenTypeHeaders(accessToken: string | undefined): Record<string, string> {
  return isExternalIdpAccessToken(accessToken) ? { tokentype: "EXTERNAL_IDP" } : {};
}
