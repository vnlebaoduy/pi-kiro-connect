import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS,
  DEFAULT_USD_PER_CREDIT,
  estimateKiroCreditCost,
  getPiAgentDir,
  type KiroUsageTracking,
  loadKiroUsageTracking,
} from "../src/usage-tracking.js";

const disabled: KiroUsageTracking = {
  estimateDollarValue: false,
  usdPerCredit: DEFAULT_USD_PER_CREDIT,
  estimateCacheUsage: false,
  estimatedCacheTimeout: DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS,
};

describe("Kiro usage tracking config", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "kiro-usage-tracking-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    delete process.env.PI_CODING_AGENT_DIR;
  });

  function writeSettings(settings: unknown): void {
    writeFileSync(join(agentDir, "settings.json"), JSON.stringify(settings));
  }

  describe("loadKiroUsageTracking", () => {
    it("is disabled when no settings file exists", () => {
      expect(loadKiroUsageTracking(agentDir)).toEqual(disabled);
    });

    it("enables dollar-value estimation with the default rate", () => {
      writeSettings({ "pi-kiro-connect": { usageTracking: { estimateDollarValue: true } } });
      expect(loadKiroUsageTracking(agentDir)).toEqual({ ...disabled, estimateDollarValue: true });
    });

    it("honors a custom rate including zero", () => {
      writeSettings({
        "pi-kiro-connect": { usageTracking: { estimateDollarValue: true, usdPerCredit: 0 } },
      });
      expect(loadKiroUsageTracking(agentDir)).toEqual({ ...disabled, estimateDollarValue: true, usdPerCredit: 0 });
    });

    it("accepts legacy enabled with a deprecation warning", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      writeSettings({ "pi-kiro-connect": { usageTracking: { enabled: true } } });

      expect(loadKiroUsageTracking(agentDir)).toEqual({ ...disabled, estimateDollarValue: true });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("deprecated"));
    });

    it("enables cache estimation independently", () => {
      writeSettings({ "pi-kiro-connect": { usageTracking: { estimateCacheUsage: true } } });
      expect(loadKiroUsageTracking(agentDir)).toEqual({ ...disabled, estimateCacheUsage: true });
    });

    it("honors a custom cache timeout including zero", () => {
      writeSettings({
        "pi-kiro-connect": { usageTracking: { estimateCacheUsage: true, estimatedCacheTimeout: 0 } },
      });
      expect(loadKiroUsageTracking(agentDir)).toEqual({
        ...disabled,
        estimateCacheUsage: true,
        estimatedCacheTimeout: 0,
      });
    });

    it.each([
      ["a negative rate", -0.04],
      ["a non-numeric rate", "0.04"],
      ["a NaN rate", Number.NaN],
      ["an infinite rate", Number.POSITIVE_INFINITY],
    ])("fails dollar estimation closed on %s", (_label, usdPerCredit) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      writeSettings({ "pi-kiro-connect": { usageTracking: { estimateDollarValue: true, usdPerCredit } } });
      expect(loadKiroUsageTracking(agentDir)).toEqual(disabled);
    });

    it.each([
      ["a negative timeout", -1],
      ["a non-numeric timeout", "300000"],
      ["a NaN timeout", Number.NaN],
      ["an infinite timeout", Number.POSITIVE_INFINITY],
    ])("fails cache estimation closed on %s", (_label, estimatedCacheTimeout) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      writeSettings({
        "pi-kiro-connect": { usageTracking: { estimateCacheUsage: true, estimatedCacheTimeout } },
      });
      expect(loadKiroUsageTracking(agentDir)).toEqual(disabled);
    });

    it("fails closed on unparseable settings without leaking contents", () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      writeFileSync(join(agentDir, "settings.json"), '{"pi-kiro-connect": {');
      expect(loadKiroUsageTracking(agentDir)).toEqual(disabled);
      expect(warn.mock.calls[0]?.[0]).not.toContain('pi-kiro-connect":');
    });

    it("reads PI_CODING_AGENT_DIR", () => {
      writeSettings({ "pi-kiro-connect": { usageTracking: { estimateCacheUsage: true } } });
      process.env.PI_CODING_AGENT_DIR = agentDir;
      expect(getPiAgentDir()).toBe(agentDir);
      expect(loadKiroUsageTracking()).toEqual({ ...disabled, estimateCacheUsage: true });
    });
  });

  describe("estimateKiroCreditCost", () => {
    const enabled: KiroUsageTracking = { ...disabled, estimateDollarValue: true };

    it("converts credits at the configured rate", () => {
      expect(estimateKiroCreditCost(enabled, { credits: 3, unit: "credit" })).toBeCloseTo(0.12, 10);
    });

    it("accepts plural mixed-case units and zero credits", () => {
      expect(estimateKiroCreditCost(enabled, { credits: 2, unit: "Credits" })).toBeCloseTo(0.08, 10);
      expect(estimateKiroCreditCost(enabled, { credits: 0, unit: "credit" })).toBe(0);
    });

    it("returns undefined when dollar estimation is disabled", () => {
      expect(estimateKiroCreditCost(disabled, { credits: 3, unit: "credit" })).toBeUndefined();
    });

    it.each([
      ["a token unit", { credits: 3, unit: "token" }],
      ["a missing credit count", { unit: "credit" }],
      ["a negative count", { credits: -1, unit: "credit" }],
      ["a NaN count", { credits: Number.NaN, unit: "credit" }],
      ["an infinite count", { credits: Number.POSITIVE_INFINITY, unit: "credit" }],
    ])("returns undefined for %s", (_label, metering) => {
      expect(estimateKiroCreditCost(enabled, metering)).toBeUndefined();
    });
  });
});
