import type { AssistantMessage } from "@earendil-works/pi-ai";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { applyCacheEstimate, resetCacheEstimatorForTests } from "../src/cache-estimator.js";
import type { KiroUsageData } from "../src/event-parser.js";
import type { KiroUsageTracking } from "../src/usage-tracking.js";

const config: KiroUsageTracking = {
  estimateDollarValue: false,
  usdPerCredit: 0.04,
  estimateCacheUsage: true,
  estimatedCacheTimeout: 300_000,
};

function usage(input: number, output = 100): AssistantMessage["usage"] & { cacheEstimated?: boolean } {
  return {
    input,
    output,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: input + output,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

describe("cache estimator", () => {
  beforeEach(() => resetCacheEstimatorForTests());

  it("leaves the first turn untouched, then splits repeated context", () => {
    const first = usage(10_000, 500);
    expect(applyCacheEstimate("s", first, null, config, 1_000)).toBe(0);
    expect(first.cacheEstimated).toBeUndefined();

    const second = usage(12_000, 200);
    expect(applyCacheEstimate("s", second, null, config, 2_000)).toBe(10_500);
    expect(second).toMatchObject({ input: 1_500, cacheRead: 10_500, cacheEstimated: true });
    expect(second.totalTokens).toBe(12_200);
  });

  it("does nothing when estimation is disabled", () => {
    const off = { ...config, estimateCacheUsage: false };
    expect(applyCacheEstimate("s", usage(10_000), null, off, 1_000)).toBe(0);
    const next = usage(12_000);
    expect(applyCacheEstimate("s", next, null, off, 2_000)).toBe(0);
    expect(next.cacheRead).toBe(0);
  });

  it("never overwrites real wire cache counters, including zero", () => {
    const wire: KiroUsageData = { cacheReadInputTokens: 0 };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    applyCacheEstimate("s", usage(10_000), wire, config, 1_000);
    const next = usage(12_000);
    applyCacheEstimate("s", next, wire, config, 2_000);
    expect(next.cacheRead).toBe(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("ignores degenerate zero-input turns without poisoning state", () => {
    applyCacheEstimate("s", usage(10_000), null, config, 1_000);
    applyCacheEstimate("s", usage(0, 0), null, config, 2_000);
    const next = usage(12_000);
    expect(applyCacheEstimate("s", next, null, config, 3_000)).toBe(10_100);
  });

  it("resets after a large context shrink", () => {
    applyCacheEstimate("s", usage(10_000), null, config, 1_000);
    const compacted = usage(5_000);
    expect(applyCacheEstimate("s", compacted, null, config, 2_000)).toBe(0);
    const next = usage(6_000);
    expect(applyCacheEstimate("s", next, null, config, 3_000)).toBe(5_100);
  });

  it("resets after timeout", () => {
    applyCacheEstimate("s", usage(10_000), null, config, 1_000);
    const expired = usage(12_000);
    expect(applyCacheEstimate("s", expired, null, config, 400_001)).toBe(0);
    const next = usage(13_000);
    expect(applyCacheEstimate("s", next, null, config, 401_000)).toBe(12_100);
  });

  it("disables timeout when configured as zero", () => {
    const noTimeout = { ...config, estimatedCacheTimeout: 0 };
    applyCacheEstimate("s", usage(10_000), null, noTimeout, 1_000);
    expect(applyCacheEstimate("s", usage(12_000), null, noTimeout, 10_000_000)).toBe(10_100);
  });
});
