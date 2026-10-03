// ABOUTME: Opt-in usage tracking config for Kiro dollar-value and cache-usage estimates.
// ABOUTME: Converts metering credits to USD and configures conservative cache-read estimation.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Kiro's published add-on credit rate (https://kiro.dev/pricing/). Used as the
 * conversion default so an enabled config needs no rate at all.
 */
export const DEFAULT_USD_PER_CREDIT = 0.04;

/** Match Pi's prompt-cache TTL and Anthropic's default cache lifetime. */
export const DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS = 5 * 60 * 1000;

/** Resolved estimation policy. Both estimates are independently opt-in. */
export interface KiroUsageTracking {
  estimateDollarValue: boolean;
  usdPerCredit: number;
  estimateCacheUsage: boolean;
  estimatedCacheTimeout: number;
}

const DISABLED: KiroUsageTracking = Object.freeze({
  estimateDollarValue: false,
  usdPerCredit: DEFAULT_USD_PER_CREDIT,
  estimateCacheUsage: false,
  estimatedCacheTimeout: DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS,
});

/** `MeteringEvent.unit` values that denote credits. The service has emitted both. */
const CREDIT_UNITS = new Set(["credit", "credits"]);
let warnedLegacyEnabled = false;

/**
 * Load estimation policy from pi's settings file.
 *
 * Each estimate fails closed independently on malformed input. Settings contents
 * are never logged because the file may contain credentials for other providers.
 */
export function loadKiroUsageTracking(agentDir = getPiAgentDir()): KiroUsageTracking {
  const raw = readSettings(join(agentDir, "settings.json"));
  const tracking = asRecord(asRecord(raw)?.["pi-kiro-connect"])?.usageTracking;
  const section = asRecord(tracking);
  if (!section) return { ...DISABLED };

  const legacyEnabled = section.enabled === true;
  if (legacyEnabled && !warnedLegacyEnabled) {
    warnedLegacyEnabled = true;
    console.warn(
      "[pi-kiro-connect] usageTracking.enabled is deprecated; use usageTracking.estimateDollarValue instead.",
    );
  }

  const estimateDollarValue = section.estimateDollarValue === true || legacyEnabled;
  const estimateCacheUsage = section.estimateCacheUsage === true;
  let usdPerCredit = DEFAULT_USD_PER_CREDIT;
  let estimatedCacheTimeout = DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS;

  if (estimateDollarValue) {
    const rate = resolveNonNegativeNumber(section.usdPerCredit, DEFAULT_USD_PER_CREDIT);
    if (rate === undefined) {
      console.warn(
        "[pi-kiro-connect] Ignoring usageTracking.estimateDollarValue: usdPerCredit must be a finite number >= 0.",
      );
    } else {
      usdPerCredit = rate;
    }
  }

  let cacheEnabled = estimateCacheUsage;
  if (estimateCacheUsage) {
    const timeout = resolveNonNegativeNumber(section.estimatedCacheTimeout, DEFAULT_ESTIMATED_CACHE_TIMEOUT_MS);
    if (timeout === undefined) {
      console.warn(
        "[pi-kiro-connect] Ignoring usageTracking.estimateCacheUsage: estimatedCacheTimeout must be a finite number >= 0.",
      );
      cacheEnabled = false;
    } else {
      estimatedCacheTimeout = timeout;
    }
  }

  return {
    estimateDollarValue:
      estimateDollarValue && resolveNonNegativeNumber(section.usdPerCredit, DEFAULT_USD_PER_CREDIT) !== undefined,
    usdPerCredit,
    estimateCacheUsage: cacheEnabled,
    estimatedCacheTimeout,
  };
}

/**
 * Estimated USD-equivalent value of one turn's credits, or `undefined` when the
 * record cannot be trusted.
 *
 * This is a conversion of Kiro's own credit count, NOT a billed amount: credits
 * included in a subscription may carry no marginal charge at all.
 */
export function estimateKiroCreditCost(
  tracking: KiroUsageTracking,
  metering: { credits?: number; unit?: string } | null | undefined,
): number | undefined {
  if (!tracking.estimateDollarValue || !metering) return undefined;
  if (typeof metering.unit !== "string" || !CREDIT_UNITS.has(metering.unit.toLowerCase())) return undefined;
  const { credits } = metering;
  if (typeof credits !== "number" || !Number.isFinite(credits) || credits < 0) return undefined;
  return credits * tracking.usdPerCredit;
}

/** pi's agent directory, honoring the same override pi itself reads. */
export function getPiAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function readSettings(path: string): unknown {
  let contents: string;
  try {
    contents = readFileSync(path, "utf-8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(contents);
  } catch {
    console.warn(`[pi-kiro-connect] Could not parse ${path}; Kiro usage tracking stays disabled.`);
    return undefined;
  }
}

function resolveNonNegativeNumber(value: unknown, defaultValue: number): number | undefined {
  if (value === undefined) return defaultValue;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
