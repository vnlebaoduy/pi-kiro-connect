import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { setExtensionContext, showLoginUI } from "../src/login-ui.js";

describe("showLoginUI", () => {
  it("requests overlay mode so pi does not restore the editor over the login dialog", async () => {
    // Issue #90: non-overlay custom() calls restoreEditor() on close, which clears
    // the container owning pi's login dialog and blanks the OAuth progress output.
    const custom = vi.fn((_factory: unknown, _options?: unknown) => Promise.resolve(null));
    setExtensionContext({ ui: { custom } } as unknown as ExtensionContext);

    await showLoginUI();

    expect(custom).toHaveBeenCalledTimes(1);
    expect(custom.mock.calls[0]?.[1]).toEqual({ overlay: true });
  });
});
