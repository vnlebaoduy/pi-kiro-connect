// Feature 11: Conversation History Validation
//
// The seven invariants first-party Kiro Agent enforces on a conversation before
// sending it, ported to this provider's request shape.
//
// Reference: `packages/kiro-agent/src/utils/message-history-sanitizer/`
// (`errors.ts` for the rule set, `validator.ts` for the checks, `sanitizer.ts`
// for the repairs). Only the validation is ported — kiro-agent's sanitizer is
// coupled to LangChain message types this provider does not use.
//
// This provider previously enforced none of these, relying instead on
// structural merging in `buildHistory` plus the salvage passes in `history.ts`.
// Repair, not rejection, is the default: failing closed on a history a caller
// has already built would be a behavior change for existing consumers, so
// `repairKiroConversation` returns a corrected conversation plus diagnostics
// and callers decide whether to care.

import { EMPTY_CONTENT_PLACEHOLDER, type KiroHistoryEntry, type KiroToolResult } from "./transform.js";

/** Identifiers for the seven invariants. Names match kiro-agent's
 *  `ValidationRule` enum so diagnostics are greppable across both codebases. */
export enum KiroValidationRule {
  STARTS_WITH_USER_MESSAGE = "STARTS_WITH_USER_MESSAGE",
  ENDS_WITH_USER_MESSAGE = "ENDS_WITH_USER_MESSAGE",
  ALTERNATING_MESSAGES = "ALTERNATING_MESSAGES",
  TOOL_USES_AND_RESULTS = "TOOL_USES_AND_RESULTS",
  TOOL_RESULTS_AND_NO_USES = "TOOL_RESULTS_AND_NO_USES",
  TOOL_RESULTS_ORPHAN_IDS = "TOOL_RESULTS_ORPHAN_IDS",
  NON_EMPTY_USER_MESSAGE = "NON_EMPTY_USER_MESSAGE",
}

export const KIRO_VALIDATION_MESSAGES: Record<KiroValidationRule, string> = {
  [KiroValidationRule.STARTS_WITH_USER_MESSAGE]: "Conversation must start with a user message",
  [KiroValidationRule.ENDS_WITH_USER_MESSAGE]: "Conversation must end with a user message",
  [KiroValidationRule.ALTERNATING_MESSAGES]: "Between every two user messages there must be an assistant message",
  [KiroValidationRule.TOOL_USES_AND_RESULTS]:
    "If an assistant message has tool uses, the next message must be a user message with corresponding tool results",
  [KiroValidationRule.TOOL_RESULTS_AND_NO_USES]:
    "If there is a message with tool result, there has to be a corresponding message with tool use.",
  [KiroValidationRule.NON_EMPTY_USER_MESSAGE]: "User messages must have either content or tool results",
  [KiroValidationRule.TOOL_RESULTS_ORPHAN_IDS]:
    "User message has toolResults whose toolUseIds do not match any toolUse in the preceding assistant message.",
};

export interface KiroValidationError {
  /** The invariant that was violated. */
  rule: KiroValidationRule;
  /** Human-readable description. */
  message: string;
  /** Index into the validated conversation where the violation was found. */
  index: number;
}

export interface KiroValidationResult {
  valid: boolean;
  errors: KiroValidationError[];
}

/** The subset describing an unbalanced toolUse/toolResult turn — the shape the
 *  backend rejects as `TOOL_USE_RESULT_MISMATCH`. Probed 2026-08-11: a history
 *  whose final assistant `toolUse` has no matching `toolResult` returns
 *  `400 {"reason":"TOOL_USE_RESULT_MISMATCH"}`. */
export const KIRO_TOOL_STRUCTURE_RULES = [
  KiroValidationRule.TOOL_USES_AND_RESULTS,
  KiroValidationRule.TOOL_RESULTS_AND_NO_USES,
  KiroValidationRule.TOOL_RESULTS_ORPHAN_IDS,
] as const;

export type KiroToolStructureRule = (typeof KIRO_TOOL_STRUCTURE_RULES)[number];

export function isKiroToolStructureRule(rule: string): boolean {
  return (KIRO_TOOL_STRUCTURE_RULES as readonly string[]).includes(rule);
}

/** Text of the synthetic result substituted for a tool result the caller never
 *  supplied. A pure function of nothing — same bytes every time, so a repaired
 *  conversation is byte-stable across retries. */
export const SYNTHETIC_FAILED_TOOL_RESULT_TEXT = "Tool use was interrupted and did not produce a result.";

function error(rule: KiroValidationRule, index: number, message?: string): KiroValidationError {
  return { rule, message: message ?? KIRO_VALIDATION_MESSAGES[rule], index };
}

function isUserEntry(entry: KiroHistoryEntry | undefined): boolean {
  return !!entry?.userInputMessage;
}

function isAssistantEntry(entry: KiroHistoryEntry | undefined): boolean {
  return !!entry?.assistantResponseMessage;
}

function toolResultsOf(entry: KiroHistoryEntry | undefined): KiroToolResult[] {
  return entry?.userInputMessage?.userInputMessageContext?.toolResults ?? [];
}

function hasToolResults(entry: KiroHistoryEntry | undefined): boolean {
  return toolResultsOf(entry).length > 0;
}

function toolUseIdsOf(entry: KiroHistoryEntry | undefined): string[] {
  return (entry?.assistantResponseMessage?.toolUses ?? []).map((tu) => tu.toolUseId).filter(Boolean);
}

function hasToolUses(entry: KiroHistoryEntry | undefined): boolean {
  return toolUseIdsOf(entry).length > 0;
}

function hasText(entry: KiroHistoryEntry | undefined): boolean {
  return (entry?.userInputMessage?.content ?? "").trim() !== "";
}

/** True when every toolUse has a result and every result has a toolUse. */
function toolResultsMatch(toolUseIds: string[], toolResults: KiroToolResult[]): boolean {
  if (toolUseIds.length === 0) return true;
  if (toolResults.length === 0) return false;
  const resultIds = new Set(toolResults.map((tr) => tr.toolUseId));
  const useIds = new Set(toolUseIds);
  return toolUseIds.every((id) => resultIds.has(id)) && toolResults.every((tr) => useIds.has(tr.toolUseId));
}

// ---------------------------------------------------------------------------
// Individual rule checks. Each returns the first violation it finds, or null.
// ---------------------------------------------------------------------------

export function validateStartsWithUserMessage(entries: KiroHistoryEntry[]): KiroValidationError | null {
  if (entries.length === 0 || !isUserEntry(entries[0])) {
    return error(KiroValidationRule.STARTS_WITH_USER_MESSAGE, 0);
  }
  return null;
}

export function validateEndsWithUserMessage(entries: KiroHistoryEntry[]): KiroValidationError | null {
  if (entries.length === 0 || !isUserEntry(entries[entries.length - 1])) {
    return error(KiroValidationRule.ENDS_WITH_USER_MESSAGE, entries.length - 1);
  }
  return null;
}

export function validateAlternatingMessages(entries: KiroHistoryEntry[]): KiroValidationError | null {
  for (let i = 1; i < entries.length; i++) {
    if (isUserEntry(entries[i - 1]) && isUserEntry(entries[i])) {
      return error(
        KiroValidationRule.ALTERNATING_MESSAGES,
        i,
        "Between every two user messages there must be an assistant message",
      );
    }
    if (isAssistantEntry(entries[i - 1]) && isAssistantEntry(entries[i])) {
      return error(
        KiroValidationRule.ALTERNATING_MESSAGES,
        i,
        "Between every two assistant messages there must be a user message",
      );
    }
  }
  return null;
}

export function validateToolUsesAndResults(entries: KiroHistoryEntry[]): KiroValidationError | null {
  for (let i = 0; i < entries.length - 1; i++) {
    const current = entries[i];
    const next = entries[i + 1];
    if (
      isAssistantEntry(current) &&
      hasToolUses(current) &&
      (!isUserEntry(next) || !toolResultsMatch(toolUseIdsOf(current), toolResultsOf(next)))
    ) {
      return error(KiroValidationRule.TOOL_USES_AND_RESULTS, i + 1);
    }
    if (isAssistantEntry(current) && !hasToolUses(current) && isUserEntry(next) && hasToolResults(next)) {
      return error(KiroValidationRule.TOOL_RESULTS_AND_NO_USES, i);
    }
  }
  // A carrier with no assistant predecessor at all — first entry, or preceded by
  // another user entry. The pairwise walk above cannot see it: it only inspects
  // a carrier that follows an assistant entry. kiro-agent never reaches this
  // shape because its sanitizer drops leading carriers before validating, but
  // this provider can send one as the *current* message: `prepareHistory`
  // guarantees every carrier inside `history` has an assistant-with-toolUses
  // predecessor (`sanitizeHistory` drops the rest, `injectSyntheticToolCalls`
  // synthesizes uses for orphans), and the current message is assembled after
  // that pass. Probed 2026-08-11: a lone current-turn carrier reached the wire
  // with `toolResults` and no `toolUse` anywhere while this check stayed silent.
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isUserEntry(entry) || !hasToolResults(entry)) continue;
    const prev = i > 0 ? entries[i - 1] : undefined;
    if (!isAssistantEntry(prev)) return error(KiroValidationRule.TOOL_RESULTS_AND_NO_USES, i);
  }
  return null;
}

export function validateToolResultOrphanIds(entries: KiroHistoryEntry[]): KiroValidationError | null {
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const current = entries[i];
    if (!isAssistantEntry(prev) || !hasToolUses(prev) || !isUserEntry(current) || !hasToolResults(current)) continue;
    const validIds = new Set(toolUseIdsOf(prev));
    const toolResults = toolResultsOf(current);
    const hasOrphan = toolResults.some((tr) => !tr.toolUseId || !validIds.has(tr.toolUseId));
    const seen = new Set<string>();
    const hasDuplicate = toolResults.some((tr) => {
      if (!tr.toolUseId) return false;
      if (seen.has(tr.toolUseId)) return true;
      seen.add(tr.toolUseId);
      return false;
    });
    if (hasOrphan || hasDuplicate) return error(KiroValidationRule.TOOL_RESULTS_ORPHAN_IDS, i);
  }
  return null;
}

/** Content **or** tool results — not content unconditionally. This is the rule
 *  that makes an empty `content` on a tool turn correct rather than malformed. */
export function validateNonEmptyUserMessages(entries: KiroHistoryEntry[]): KiroValidationError | null {
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!isUserEntry(entry)) continue;
    if (!hasText(entry) && !hasToolResults(entry)) {
      return error(KiroValidationRule.NON_EMPTY_USER_MESSAGE, i);
    }
  }
  return null;
}

/** Only the three tool-structure rules, in the order `validateKiroConversation`
 *  reports them. Cheaper than a full pass when only pairing matters. */
export function validateKiroToolStructure(entries: KiroHistoryEntry[]): KiroValidationResult {
  const errors = [validateToolUsesAndResults(entries), validateToolResultOrphanIds(entries)].filter(
    (e): e is KiroValidationError => e !== null,
  );
  return { valid: errors.length === 0, errors };
}

/**
 * Validates a whole conversation against all seven invariants.
 *
 * `entries` is the full conversation: the outbound `history` followed by the
 * entry for `currentMessage`. Validating history alone would report a spurious
 * `ENDS_WITH_USER_MESSAGE` — this provider's history deliberately ends on the
 * assistant turn whose tool uses the current message answers. Use
 * {@link kiroConversationEntries} to build the array.
 */
export function validateKiroConversation(entries: KiroHistoryEntry[]): KiroValidationResult {
  const errors = [
    validateStartsWithUserMessage(entries),
    validateEndsWithUserMessage(entries),
    validateAlternatingMessages(entries),
    ...validateKiroToolStructure(entries).errors,
    validateNonEmptyUserMessages(entries),
  ].filter((e): e is KiroValidationError => e !== null);
  return { valid: errors.length === 0, errors };
}

/** Assembles the conversation this provider actually sends: history plus the
 *  current user message. */
export function kiroConversationEntries(
  history: KiroHistoryEntry[],
  currentUserMessage: KiroHistoryEntry["userInputMessage"],
): KiroHistoryEntry[] {
  return currentUserMessage ? [...history, { userInputMessage: currentUserMessage }] : [...history];
}

export interface KiroRepairResult {
  /** The repaired conversation. */
  entries: KiroHistoryEntry[];
  /** Violations found in the input, before repair. Empty when it was valid. */
  diagnostics: KiroValidationError[];
  /** Violations still present after repair. Non-empty means a shape this
   *  repair pass cannot express — report it rather than silently sending. */
  remaining: KiroValidationError[];
}

/**
 * Validates and repairs, rather than throwing. Mirrors what kiro-agent's
 * sanitizer does, in this provider's terms:
 *
 * 1. Drop leading entries until the conversation starts with a user message
 *    that is not a bare tool-result carrier.
 * 2. Consolidate runs of adjacent tool-result-only user messages into one.
 *    This runs **before** orphan-stripping on purpose: a run's later carriers
 *    are preceded by a user entry, not the assistant that issued the tool uses,
 *    so stripping first would judge their results orphaned and discard real
 *    tool output.
 * 3. Strip orphaned and duplicate `toolResults`.
 * 4. Synthesize an ERROR tool result for every assistant `toolUse` still
 *    unanswered.
 * 5. Give a user message that has neither text nor tool results the neutral
 *    {@link EMPTY_CONTENT_PLACEHOLDER}.
 *
 * A repaired conversation is not guaranteed valid: an input that alternates
 * incorrectly for reasons outside these five shapes is reported in
 * `remaining`. Callers log it; nothing here throws.
 */
export function repairKiroConversation(entries: KiroHistoryEntry[]): KiroRepairResult {
  const diagnostics = validateKiroConversation(entries).errors;
  if (diagnostics.length === 0) return { entries, diagnostics, remaining: [] };

  // A synthesized user turn must declare the same model as its neighbours.
  const modelId = entries.find((e) => e.userInputMessage?.modelId)?.userInputMessage?.modelId ?? "";

  // 1. Leading entries that cannot start a conversation.
  let working = [...entries];
  while (working.length > 0 && (!isUserEntry(working[0]) || hasToolResults(working[0]))) working = working.slice(1);

  // 2. Consolidate adjacent tool-result-only user messages. Must precede the
  //    orphan pass: a later carrier in such a run is preceded by a user entry,
  //    whose toolUse id set is empty, so orphan-stripping would delete its real
  //    results and leave synthesis to substitute failure text for output the
  //    caller actually had.
  const consolidated: KiroHistoryEntry[] = [];
  for (let i = 0; i < working.length; i++) {
    const entry = working[i];
    const isToolOnly = isUserEntry(entry) && hasToolResults(entry) && !hasText(entry);
    if (!isToolOnly) {
      consolidated.push(entry);
      continue;
    }
    let j = i;
    const merged: KiroToolResult[] = [];
    const seen = new Set<string>();
    while (j < working.length) {
      const candidate = working[j];
      if (!(isUserEntry(candidate) && hasToolResults(candidate) && !hasText(candidate))) break;
      for (const tr of toolResultsOf(candidate)) {
        if (tr.toolUseId && seen.has(tr.toolUseId)) continue;
        if (tr.toolUseId) seen.add(tr.toolUseId);
        merged.push(tr);
      }
      j++;
    }
    if (j - i === 1) {
      consolidated.push(entry);
    } else {
      const uim = entry.userInputMessage as NonNullable<KiroHistoryEntry["userInputMessage"]>;
      consolidated.push({
        userInputMessage: {
          ...uim,
          userInputMessageContext: { ...uim.userInputMessageContext, toolResults: merged },
        },
      });
    }
    i = j - 1;
  }
  working = consolidated;

  // 3 + 4. Walk pairs, fixing tool structure in both directions.
  const repaired: KiroHistoryEntry[] = [];
  for (let i = 0; i < working.length; i++) {
    const entry = working[i];
    if (isUserEntry(entry) && hasToolResults(entry)) {
      const prev = repaired[repaired.length - 1];
      const validIds = new Set(toolUseIdsOf(prev));
      const seen = new Set<string>();
      const kept = toolResultsOf(entry).filter((tr) => {
        if (!tr.toolUseId || !validIds.has(tr.toolUseId) || seen.has(tr.toolUseId)) return false;
        seen.add(tr.toolUseId);
        return true;
      });
      const uim = { ...entry.userInputMessage } as NonNullable<KiroHistoryEntry["userInputMessage"]>;
      if (kept.length === 0) {
        const { userInputMessageContext, ...rest } = uim;
        const tools = userInputMessageContext?.tools;
        repaired.push({
          userInputMessage: { ...rest, ...(tools ? { userInputMessageContext: { tools } } : {}) },
        });
      } else {
        repaired.push({
          userInputMessage: {
            ...uim,
            userInputMessageContext: { ...uim.userInputMessageContext, toolResults: kept },
          },
        });
      }
      continue;
    }
    repaired.push(entry);
    // 4. Assistant toolUses the next entry does not answer.
    if (isAssistantEntry(entry) && hasToolUses(entry)) {
      const next = working[i + 1];
      const answered = new Set(
        isUserEntry(next) ? toolResultsOf(next).map((tr) => tr.toolUseId) : /* c8 ignore next */ [],
      );
      const unanswered = toolUseIdsOf(entry).filter((id) => !answered.has(id));
      if (unanswered.length > 0 && !isUserEntry(next)) {
        // No user turn follows at all: insert one carrying every result.
        repaired.push(syntheticToolResultEntry(unanswered, modelId));
      } else if (unanswered.length > 0 && isUserEntry(next)) {
        // A user turn follows but under-answers: top it up in place.
        const uim = { ...next.userInputMessage } as NonNullable<KiroHistoryEntry["userInputMessage"]>;
        working[i + 1] = {
          userInputMessage: {
            ...uim,
            userInputMessageContext: {
              ...uim.userInputMessageContext,
              toolResults: [...toolResultsOf(next), ...unanswered.map(syntheticFailedToolResult)],
            },
          },
        };
      }
    }
  }

  // 5. Neither text nor tool results — give it the neutral prompt.
  const final = repaired.map((entry) => {
    if (!isUserEntry(entry) || hasText(entry) || hasToolResults(entry)) return entry;
    const uim = entry.userInputMessage as NonNullable<KiroHistoryEntry["userInputMessage"]>;
    return { userInputMessage: { ...uim, content: EMPTY_CONTENT_PLACEHOLDER } };
  });

  return { entries: final, diagnostics, remaining: validateKiroConversation(final).errors };
}

function syntheticFailedToolResult(toolUseId: string): KiroToolResult {
  return { toolUseId, content: [{ text: SYNTHETIC_FAILED_TOOL_RESULT_TEXT }], status: "error" };
}

function syntheticToolResultEntry(toolUseIds: string[], modelId: string): KiroHistoryEntry {
  return {
    userInputMessage: {
      // Empty by design: `toolResults` is the payload. Matches kiro-agent's
      // `FAILED_TOOL_USE_MESSAGE`, which also ships `content: ''`.
      content: "",
      modelId,
      origin: "KIRO_CLI",
      userInputMessageContext: { toolResults: toolUseIds.map(syntheticFailedToolResult) },
    },
  };
}
