import { beforeEach, describe, expect, it, vi } from "vitest";
import { withKiroAccountIdentity } from "../src/account-identity.js";
import { getUsageLimits } from "../src/management.js";
import type { KiroCredentials } from "../src/oauth.js";

vi.mock("../src/management.js", () => ({
  getUsageLimits: vi.fn(),
  resolveKiroProfileArn: vi.fn(async () => "arn:aws:codewhisperer:us-east-1:111111111111:profile/TEST"),
}));

const usageLimits = vi.mocked(getUsageLimits);

function idcCredential(refreshToken: string, extra: Partial<KiroCredentials> = {}): KiroCredentials {
  return {
    refresh: `${refreshToken}|cid|csec|idc`,
    access: `${refreshToken}-access`,
    expires: Date.now() + 3600_000,
    clientId: "cid",
    clientSecret: "csec",
    region: "us-east-1",
    authMethod: "idc",
    ...extra,
  };
}

beforeEach(() => {
  usageLimits.mockReset();
});

describe("withKiroAccountIdentity", () => {
  it("stamps the account Kiro reports for the credential", async () => {
    usageLimits.mockResolvedValueOnce({ userInfo: { userId: " d-123.alice ", email: "alice@example.com" } });

    const stamped = await withKiroAccountIdentity(idcCredential("rt-1"));

    expect(stamped).toMatchObject({ accountId: "d-123.alice", email: "alice@example.com" });
    // The email is only returned when asked for; without it hosts fall back to the opaque id.
    expect(usageLimits.mock.calls[0][1]).toMatchObject({ isEmailRequired: true });
  });

  it("keeps the identity across a refresh of the same sign-in session", async () => {
    const previous = idcCredential("rt-1", { accountId: "d-123.alice", email: "alice@example.com" });

    const refreshed = await withKiroAccountIdentity({ ...idcCredential("rt-1"), access: "rotated-access" }, previous);

    expect(refreshed).toMatchObject({ accountId: "d-123.alice", email: "alice@example.com", access: "rotated-access" });
    expect(usageLimits).not.toHaveBeenCalled();
  });

  it("looks the account up again when the session changed underneath", async () => {
    // A refresh can return kiro-cli's session after `kiro-cli login` switched user:
    // carrying the old identity over would label Bob's credential as Alice's.
    usageLimits.mockResolvedValueOnce({ userInfo: { userId: "d-123.bob", email: "bob@example.com" } });
    const previous = idcCredential("rt-alice", { accountId: "d-123.alice", email: "alice@example.com" });

    const refreshed = await withKiroAccountIdentity(idcCredential("rt-bob"), previous);

    expect(refreshed).toMatchObject({ accountId: "d-123.bob", email: "bob@example.com" });
  });

  it("returns the credential unchanged when the lookup fails", async () => {
    usageLimits.mockRejectedValueOnce(new Error("network down"));
    const credential = idcCredential("rt-1");

    await expect(withKiroAccountIdentity(credential)).resolves.toEqual(credential);
  });

  it("does not attach an email Kiro left empty", async () => {
    usageLimits.mockResolvedValueOnce({ userInfo: { userId: "d-123.alice", email: "" } });

    const stamped = await withKiroAccountIdentity(idcCredential("rt-1"));

    expect(stamped.accountId).toBe("d-123.alice");
    expect(stamped).not.toHaveProperty("email");
  });

  it("leaves API keys alone", async () => {
    const key = { ...idcCredential("ksk_x"), authMethod: "apikey" as const };

    await expect(withKiroAccountIdentity(key)).resolves.toBe(key);
    expect(usageLimits).not.toHaveBeenCalled();
  });
});
