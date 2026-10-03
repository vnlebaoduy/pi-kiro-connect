// ABOUTME: Conservative in-memory cache-read estimation for Kiro usage records.
// ABOUTME: Reclassifies repeated prompt input without changing total tokens or dollar cost.

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { KiroUsageData } from "./event-parser.js";
import type { KiroUsageTracking } from "./usage-tracking.js";

interface CacheEstimateState {
  promptTokens: number;
  turnTimestamp: number;
}

type Usage = AssistantMessage["usage"] & { cacheEstimated?: boolean };

const stateByConversation = new Map<string, CacheEstimateState>();
const MAX_TRACKED_CONVERSATIONS = 128;
let warnedWireCacheCounters = false;

/**
 * Estimate repeated prompt tokens as cache reads, then record the successful
 * turn as the next baseline. Mutates `usage` only when every conservative guard
 * passes. Real wire cache counters always win.
 */
export function applyCacheEstimate(
  conversationId: string,
  usage: Usage,
  wireUsage: KiroUsageData | null,
  config: KiroUsageTracking,
  now = Date.now(),
): number {
  const previous = stateByConversation.get(conversationId);
  const promptTokens = usage.input + usage.cacheRead + usage.cacheWrite + usage.output;
  const wireReportedCache =
    wireUsage?.cacheReadInputTokens !== undefined || wireUsage?.cacheWriteInputTokens !== undefined;

  if (wireReportedCache) {
    if (config.estimateCacheUsage && !warnedWireCacheCounters) {
      warnedWireCacheCounters = true;
      console.warn(
        "[pi-kiro-connect] Kiro now reports cache token counters; cache estimation was skipped and may be disabled.",
      );
    }
    noteSuccessfulTurn(conversationId, promptTokens, usage.input, now);
    return 0;
  }

  if (!config.estimateCacheUsage || usage.input <= 0) return 0;

  if (!previous) {
    noteSuccessfulTurn(conversationId, promptTokens, usage.input, now);
    return 0;
  }

  const expired = config.estimatedCacheTimeout > 0 && now - previous.turnTimestamp > config.estimatedCacheTimeout;
  const contextShrank = usage.input < previous.promptTokens * 0.6;
  if (expired || contextShrank) {
    noteSuccessfulTurn(conversationId, promptTokens, usage.input, now);
    return 0;
  }

  const estimatedRead = Math.min(previous.promptTokens, usage.input);
  if (estimatedRead > 0) {
    usage.input -= estimatedRead;
    usage.cacheRead += estimatedRead;
    usage.cacheEstimated = true;
  }

  noteSuccessfulTurn(conversationId, promptTokens, promptTokens, now);
  return estimatedRead;
}

function noteSuccessfulTurn(conversationId: string, promptTokens: number, input: number, now: number): void {
  if (input <= 0 || promptTokens <= 0) return;
  // Refresh insertion order so the map is a bounded least-recently-used set.
  stateByConversation.delete(conversationId);
  stateByConversation.set(conversationId, { promptTokens, turnTimestamp: now });
  if (stateByConversation.size > MAX_TRACKED_CONVERSATIONS) {
    const oldest = stateByConversation.keys().next().value;
    if (oldest !== undefined) stateByConversation.delete(oldest);
  }
}

/** Clear estimator state between tests. */
export function resetCacheEstimatorForTests(): void {
  stateByConversation.clear();
  warnedWireCacheCounters = false;
}
