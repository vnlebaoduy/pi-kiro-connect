import { describe, expect, it } from "vitest";
import { isExternalIdpAccessToken, kiroTokenTypeHeaders } from "../src/token-type.js";

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url").replace(/=+$/, "");
  return `${encode({ alg: "RS256", kid: "test" })}.${encode(payload)}.signature`;
}

describe("isExternalIdpAccessToken", () => {
  it("recognises an external IdP token by its api://kiro audience", () => {
    const token = makeJwt({
      iss: "https://example.okta.com/oauth2/default",
      aud: "api://kiro",
      scp: ["codewhisperer:conversations", "codewhisperer:completions"],
    });
    expect(isExternalIdpAccessToken(token)).toBe(true);
  });

  it("rejects a JWT issued for a different audience", () => {
    expect(isExternalIdpAccessToken(makeJwt({ aud: "https://example.com" }))).toBe(false);
  });

  it("rejects the opaque tokens AWS SSO and Kiro desktop issue", () => {
    expect(isExternalIdpAccessToken("aoaEXAMPLEopaquessotoken")).toBe(false);
  });

  it("rejects malformed input without throwing", () => {
    expect(isExternalIdpAccessToken(undefined)).toBe(false);
    expect(isExternalIdpAccessToken("")).toBe(false);
    expect(isExternalIdpAccessToken("not.a.jwt")).toBe(false);
  });
});

describe("kiroTokenTypeHeaders", () => {
  it("adds tokentype: EXTERNAL_IDP for external IdP tokens", () => {
    expect(kiroTokenTypeHeaders(makeJwt({ aud: "api://kiro" }))).toEqual({ tokentype: "EXTERNAL_IDP" });
  });

  it("adds no header for AWS SSO and desktop tokens", () => {
    expect(kiroTokenTypeHeaders("aoaEXAMPLEopaquessotoken")).toEqual({});
    expect(kiroTokenTypeHeaders(undefined)).toEqual({});
  });
});
