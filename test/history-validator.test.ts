import { describe, expect, it } from "vitest";
import {
  isKiroToolStructureRule,
  KIRO_TOOL_STRUCTURE_RULES,
  KiroValidationRule,
  kiroConversationEntries,
  repairKiroConversation,
  SYNTHETIC_FAILED_TOOL_RESULT_TEXT,
  validateKiroConversation,
  validateKiroToolStructure,
} from "../src/history-validator.js";
import {
  EMPTY_CONTENT_PLACEHOLDER,
  type KiroHistoryEntry,
  type KiroToolResult,
  type KiroToolUse,
} from "../src/transform.js";

const userEntry = (content: string, toolResults?: KiroToolResult[]): KiroHistoryEntry => ({
  userInputMessage: {
    content,
    modelId: "M",
    origin: "KIRO_CLI",
    ...(toolResults ? { userInputMessageContext: { toolResults } } : {}),
  },
});

const assistantEntry = (content: string, toolUses?: KiroToolUse[]): KiroHistoryEntry => ({
  assistantResponseMessage: { content, ...(toolUses ? { toolUses } : {}) },
});

const use = (id: string): KiroToolUse => ({ name: "bash", toolUseId: id, input: {} });
const result = (id: string): KiroToolResult => ({ toolUseId: id, content: [{ text: "ok" }], status: "success" });

const rulesOf = (entries: KiroHistoryEntry[]) => validateKiroConversation(entries).errors.map((e) => e.rule);

describe("Feature 11: History Validation", () => {
  // Each invariant gets an accepting and a rejecting case. The rule names are
  // the contract — they match kiro-agent's ValidationRule enum, so a rename
  // here silently breaks cross-codebase grep.

  describe("STARTS_WITH_USER_MESSAGE", () => {
    it("accepts a conversation whose first entry is a user message", () => {
      const entries = [userEntry("hi"), assistantEntry("hello"), userEntry("more")];
      expect(rulesOf(entries)).not.toContain(KiroValidationRule.STARTS_WITH_USER_MESSAGE);
    });

    it("rejects a conversation opening on an assistant message", () => {
      const entries = [assistantEntry("hello"), userEntry("hi")];
      const errors = validateKiroConversation(entries).errors;
      expect(errors.map((e) => e.rule)).toContain(KiroValidationRule.STARTS_WITH_USER_MESSAGE);
      expect(errors.find((e) => e.rule === KiroValidationRule.STARTS_WITH_USER_MESSAGE)?.index).toBe(0);
    });

    it("rejects an empty conversation", () => {
      expect(rulesOf([])).toContain(KiroValidationRule.STARTS_WITH_USER_MESSAGE);
    });
  });

  describe("ENDS_WITH_USER_MESSAGE", () => {
    it("accepts a conversation whose last entry is a user message", () => {
      expect(rulesOf([userEntry("hi"), assistantEntry("yo"), userEntry("bye")])).not.toContain(
        KiroValidationRule.ENDS_WITH_USER_MESSAGE,
      );
    });

    it("rejects a conversation ending on an assistant message", () => {
      const errors = validateKiroConversation([userEntry("hi"), assistantEntry("yo")]).errors;
      expect(errors.map((e) => e.rule)).toContain(KiroValidationRule.ENDS_WITH_USER_MESSAGE);
      expect(errors.find((e) => e.rule === KiroValidationRule.ENDS_WITH_USER_MESSAGE)?.index).toBe(1);
    });
  });

  describe("ALTERNATING_MESSAGES", () => {
    it("accepts strict user/assistant alternation", () => {
      expect(
        rulesOf([userEntry("a"), assistantEntry("b"), userEntry("c"), assistantEntry("d"), userEntry("e")]),
      ).not.toContain(KiroValidationRule.ALTERNATING_MESSAGES);
    });

    it("rejects two consecutive user messages", () => {
      const errors = validateKiroConversation([userEntry("a"), userEntry("b")]).errors;
      const alt = errors.find((e) => e.rule === KiroValidationRule.ALTERNATING_MESSAGES);
      expect(alt?.message).toBe("Between every two user messages there must be an assistant message");
      expect(alt?.index).toBe(1);
    });

    it("rejects two consecutive assistant messages", () => {
      const errors = validateKiroConversation([
        userEntry("a"),
        assistantEntry("b"),
        assistantEntry("c"),
        userEntry("d"),
      ]).errors;
      const alt = errors.find((e) => e.rule === KiroValidationRule.ALTERNATING_MESSAGES);
      expect(alt?.message).toBe("Between every two assistant messages there must be a user message");
      expect(alt?.index).toBe(2);
    });
  });

  describe("TOOL_USES_AND_RESULTS", () => {
    it("accepts an assistant toolUse answered by the next user message", () => {
      expect(
        rulesOf([userEntry("go"), assistantEntry("", [use("tc1")]), userEntry("", [result("tc1")])]),
      ).not.toContain(KiroValidationRule.TOOL_USES_AND_RESULTS);
    });

    it("rejects an assistant toolUse the next message does not answer", () => {
      const errors = validateKiroConversation([
        userEntry("go"),
        assistantEntry("", [use("tc1")]),
        userEntry("unrelated"),
      ]).errors;
      const err = errors.find((e) => e.rule === KiroValidationRule.TOOL_USES_AND_RESULTS);
      expect(err?.index).toBe(2);
    });

    it("rejects a partially answered multi-toolUse turn", () => {
      expect(
        rulesOf([userEntry("go"), assistantEntry("", [use("tc1"), use("tc2")]), userEntry("", [result("tc1")])]),
      ).toContain(KiroValidationRule.TOOL_USES_AND_RESULTS);
    });
  });

  describe("TOOL_RESULTS_AND_NO_USES", () => {
    it("accepts tool results whose preceding assistant message has toolUses", () => {
      expect(
        rulesOf([userEntry("go"), assistantEntry("", [use("tc1")]), userEntry("", [result("tc1")])]),
      ).not.toContain(KiroValidationRule.TOOL_RESULTS_AND_NO_USES);
    });

    it("rejects tool results after an assistant message with no toolUses", () => {
      const errors = validateKiroConversation([
        userEntry("go"),
        assistantEntry("plain text"),
        userEntry("", [result("tc1")]),
      ]).errors;
      const err = errors.find((e) => e.rule === KiroValidationRule.TOOL_RESULTS_AND_NO_USES);
      expect(err?.index).toBe(1);
    });

    // The pairwise walk only inspects a carrier that follows an assistant entry,
    // so a carrier with no assistant predecessor at all needs its own pass.
    // Reachable as the current message: `prepareHistory` guarantees every carrier
    // inside `history` is preceded by an assistant with toolUses, but the current
    // message is assembled after that pass.
    it("rejects a lone tool-result carrier with no toolUse anywhere", () => {
      const errors = validateKiroConversation([userEntry("", [result("tcZ")])]).errors;
      const err = errors.find((e) => e.rule === KiroValidationRule.TOOL_RESULTS_AND_NO_USES);
      expect(err?.index).toBe(0);
    });

    it("rejects a tool-result carrier preceded by another user message", () => {
      const errors = validateKiroConversation([userEntry("go"), userEntry("", [result("tcZ")])]).errors;
      const err = errors.find((e) => e.rule === KiroValidationRule.TOOL_RESULTS_AND_NO_USES);
      expect(err?.index).toBe(1);
    });

    it("reports the unpaired carrier as a tool-structure rule so the send path warns", () => {
      const subset = validateKiroToolStructure([userEntry("", [result("tcZ")])]);
      expect(subset.valid).toBe(false);
      expect(subset.errors.every((e) => isKiroToolStructureRule(e.rule))).toBe(true);
    });
  });

  describe("TOOL_RESULTS_ORPHAN_IDS", () => {
    it("accepts results whose ids all match the preceding toolUses", () => {
      expect(
        rulesOf([
          userEntry("go"),
          assistantEntry("", [use("tc1"), use("tc2")]),
          userEntry("", [result("tc1"), result("tc2")]),
        ]),
      ).not.toContain(KiroValidationRule.TOOL_RESULTS_ORPHAN_IDS);
    });

    it("rejects a result whose toolUseId matches no preceding toolUse", () => {
      const entries = [
        userEntry("go"),
        assistantEntry("", [use("tc1")]),
        userEntry("", [result("tc1"), result("ghost")]),
      ];
      expect(rulesOf(entries)).toContain(KiroValidationRule.TOOL_RESULTS_ORPHAN_IDS);
    });

    it("rejects duplicate toolUseIds in one message", () => {
      const entries = [
        userEntry("go"),
        assistantEntry("", [use("tc1")]),
        userEntry("", [result("tc1"), result("tc1")]),
      ];
      expect(rulesOf(entries)).toContain(KiroValidationRule.TOOL_RESULTS_ORPHAN_IDS);
    });
  });

  describe("NON_EMPTY_USER_MESSAGE", () => {
    it("accepts an empty-content user message that carries tool results", () => {
      // The load-bearing case: content OR toolResults. A tool turn needs no text.
      expect(
        rulesOf([userEntry("go"), assistantEntry("", [use("tc1")]), userEntry("", [result("tc1")])]),
      ).not.toContain(KiroValidationRule.NON_EMPTY_USER_MESSAGE);
    });

    it("accepts a user message with text and no tool results", () => {
      expect(rulesOf([userEntry("hello")])).not.toContain(KiroValidationRule.NON_EMPTY_USER_MESSAGE);
    });

    it("rejects a user message with neither text nor tool results", () => {
      const errors = validateKiroConversation([userEntry("")]).errors;
      expect(errors.find((e) => e.rule === KiroValidationRule.NON_EMPTY_USER_MESSAGE)?.index).toBe(0);
    });

    it("treats whitespace-only content as empty", () => {
      expect(rulesOf([userEntry("   \n\t ")])).toContain(KiroValidationRule.NON_EMPTY_USER_MESSAGE);
    });
  });

  describe("validateKiroToolStructure", () => {
    it("reports only the three tool-structure rules", () => {
      // This conversation violates STARTS_WITH_USER_MESSAGE too; the subset check
      // must not report it.
      const entries = [assistantEntry("", [use("tc1")]), userEntry("nope")];
      const subset = validateKiroToolStructure(entries);
      expect(subset.errors.map((e) => e.rule)).toEqual([KiroValidationRule.TOOL_USES_AND_RESULTS]);
      expect(rulesOf(entries)).toContain(KiroValidationRule.STARTS_WITH_USER_MESSAGE);
    });

    it("agrees with the full pass on rule and index for tool-structure rules", () => {
      const entries = [userEntry("go"), assistantEntry("", [use("tc1")]), userEntry("unrelated")];
      const subset = validateKiroToolStructure(entries).errors;
      const full = validateKiroConversation(entries).errors.filter((e) => isKiroToolStructureRule(e.rule));
      expect(subset).toEqual(full);
    });

    it("classifies exactly the three tool-structure rule names", () => {
      expect(KIRO_TOOL_STRUCTURE_RULES.every((r) => isKiroToolStructureRule(r))).toBe(true);
      expect(isKiroToolStructureRule(KiroValidationRule.ALTERNATING_MESSAGES)).toBe(false);
      expect(isKiroToolStructureRule(KiroValidationRule.NON_EMPTY_USER_MESSAGE)).toBe(false);
    });
  });

  describe("kiroConversationEntries", () => {
    it("appends the current user message so a tool-answering history validates", () => {
      // History alone ends on the assistant toolUse turn. Validating it in
      // isolation reports ENDS_WITH_USER_MESSAGE — and note that the pairing
      // check cannot see a trailing toolUse at all (its loop stops at
      // length - 1, matching kiro-agent), so ENDS_WITH_USER_MESSAGE is the only
      // rule that catches an unanswered final tool turn.
      const history = [userEntry("go"), assistantEntry("", [use("tc1")])];
      expect(rulesOf(history)).toEqual([KiroValidationRule.ENDS_WITH_USER_MESSAGE]);

      const full = kiroConversationEntries(history, {
        content: "",
        modelId: "M",
        origin: "KIRO_CLI",
        userInputMessageContext: { toolResults: [result("tc1")] },
      });
      expect(validateKiroConversation(full).valid).toBe(true);
    });

    it("returns history unchanged when there is no current message", () => {
      const history = [userEntry("go")];
      expect(kiroConversationEntries(history, undefined)).toEqual(history);
    });
  });

  describe("repairKiroConversation", () => {
    it("returns a valid conversation untouched with no diagnostics", () => {
      const entries = [userEntry("go"), assistantEntry("", [use("tc1")]), userEntry("", [result("tc1")])];
      const repaired = repairKiroConversation(entries);
      expect(repaired.diagnostics).toEqual([]);
      expect(repaired.entries).toBe(entries);
      expect(repaired.remaining).toEqual([]);
    });

    it("drops leading entries until the conversation opens on a real user message", () => {
      const entries = [assistantEntry("stray"), userEntry("go"), assistantEntry("ok"), userEntry("more")];
      const repaired = repairKiroConversation(entries);
      expect(repaired.entries[0].userInputMessage?.content).toBe("go");
      expect(repaired.remaining).toEqual([]);
    });

    it("drops a leading bare tool-result carrier", () => {
      const entries = [userEntry("", [result("tc1")]), userEntry("go"), assistantEntry("ok"), userEntry("more")];
      const repaired = repairKiroConversation(entries);
      expect(repaired.entries[0].userInputMessage?.content).toBe("go");
    });

    it("synthesizes an error result for an unanswered toolUse", () => {
      const entries = [userEntry("go"), assistantEntry("", [use("tc1"), use("tc2")]), userEntry("", [result("tc1")])];
      const repaired = repairKiroConversation(entries);
      const carrier = repaired.entries[repaired.entries.length - 1].userInputMessage;
      const ids = carrier?.userInputMessageContext?.toolResults?.map((tr) => tr.toolUseId);

      expect(ids).toEqual(["tc1", "tc2"]);
      const synthetic = carrier?.userInputMessageContext?.toolResults?.find((tr) => tr.toolUseId === "tc2");
      expect(synthetic?.status).toBe("error");
      expect(synthetic?.content[0].text).toBe(SYNTHETIC_FAILED_TOOL_RESULT_TEXT);
      expect(repaired.remaining).toEqual([]);
    });

    it("ships the synthetic tool-result turn with empty content, like kiro-agent", () => {
      // An assistant toolUse with no following user turn at all.
      const entries = [userEntry("go"), assistantEntry("", [use("tc1")])];
      const repaired = repairKiroConversation(entries);
      const inserted = repaired.entries[repaired.entries.length - 1].userInputMessage;

      expect(inserted?.content).toBe("");
      expect(inserted?.userInputMessageContext?.toolResults?.[0].toolUseId).toBe("tc1");
      expect(inserted?.modelId).toBe("M");
      expect(JSON.stringify(repaired.entries)).not.toContain("Tool results provided");
    });

    it("strips orphaned and duplicate tool results", () => {
      const entries = [
        userEntry("go"),
        assistantEntry("", [use("tc1")]),
        userEntry("", [result("tc1"), result("tc1"), result("ghost")]),
      ];
      const repaired = repairKiroConversation(entries);
      const kept = repaired.entries[2].userInputMessage?.userInputMessageContext?.toolResults;

      expect(kept?.map((tr) => tr.toolUseId)).toEqual(["tc1"]);
      expect(repaired.remaining).toEqual([]);
    });

    it("consolidates a run of adjacent tool-result-only user messages", () => {
      const entries = [
        userEntry("go"),
        assistantEntry("", [use("tc1"), use("tc2")]),
        userEntry("", [{ toolUseId: "tc1", content: [{ text: "real one" }], status: "success" }]),
        userEntry("", [{ toolUseId: "tc2", content: [{ text: "real two" }], status: "success" }]),
      ];
      const repaired = repairKiroConversation(entries);
      const carriers = repaired.entries.filter((e) => e.userInputMessage?.userInputMessageContext?.toolResults);

      expect(carriers).toHaveLength(1);
      const kept = carriers[0].userInputMessage?.userInputMessageContext?.toolResults;
      expect(kept?.map((tr) => tr.toolUseId)).toEqual(["tc1", "tc2"]);
      // Regression: the real tool output must survive. Consolidation used to run
      // after orphan-stripping, so the second carrier — preceded by a user entry
      // rather than the assistant that issued the tool uses — had its genuine
      // result deleted as orphaned and replaced by synthetic failure text.
      expect(kept?.map((tr) => tr.content[0].text)).toEqual(["real one", "real two"]);
      expect(kept?.every((tr) => tr.status === "success")).toBe(true);
      expect(JSON.stringify(repaired.entries)).not.toContain(SYNTHETIC_FAILED_TOOL_RESULT_TEXT);
      expect(repaired.remaining).toEqual([]);
    });

    it("keeps real output when a run of carriers is also missing one result", () => {
      // Consolidation and synthesis both apply: tc1/tc2 have real output in
      // separate carriers, tc3 has none at all.
      const entries = [
        userEntry("go"),
        assistantEntry("", [use("tc1"), use("tc2"), use("tc3")]),
        userEntry("", [{ toolUseId: "tc1", content: [{ text: "real one" }], status: "success" }]),
        userEntry("", [{ toolUseId: "tc2", content: [{ text: "real two" }], status: "success" }]),
      ];
      const repaired = repairKiroConversation(entries);
      const kept = repaired.entries[2].userInputMessage?.userInputMessageContext?.toolResults;

      expect(kept?.map((tr) => tr.toolUseId)).toEqual(["tc1", "tc2", "tc3"]);
      expect(kept?.find((tr) => tr.toolUseId === "tc1")?.content[0].text).toBe("real one");
      expect(kept?.find((tr) => tr.toolUseId === "tc2")?.content[0].text).toBe("real two");
      const synthetic = kept?.find((tr) => tr.toolUseId === "tc3");
      expect(synthetic?.status).toBe("error");
      expect(synthetic?.content[0].text).toBe(SYNTHETIC_FAILED_TOOL_RESULT_TEXT);
      expect(repaired.remaining).toEqual([]);
    });

    it("gives the neutral placeholder to a user message with no payload at all", () => {
      const entries = [userEntry("go"), assistantEntry("ok"), userEntry("")];
      const repaired = repairKiroConversation(entries);

      expect(repaired.entries[2].userInputMessage?.content).toBe(EMPTY_CONTENT_PLACEHOLDER);
      expect(repaired.diagnostics.map((e) => e.rule)).toContain(KiroValidationRule.NON_EMPTY_USER_MESSAGE);
      expect(repaired.remaining).toEqual([]);
    });

    it("never fabricates carrier prose for a tool turn it repairs", () => {
      const entries = [
        assistantEntry("stray"),
        userEntry("go"),
        assistantEntry("", [use("tc1"), use("tc2")]),
        userEntry("", [result("tc1"), result("ghost")]),
      ];
      const repaired = repairKiroConversation(entries);
      expect(JSON.stringify(repaired.entries)).not.toContain("Tool results provided");
    });

    it("reports what it cannot repair in `remaining` rather than throwing", () => {
      // Consecutive assistant messages are outside the five repair shapes.
      const entries = [userEntry("go"), assistantEntry("one"), assistantEntry("two"), userEntry("next")];
      const repaired = repairKiroConversation(entries);
      expect(repaired.remaining.map((e) => e.rule)).toContain(KiroValidationRule.ALTERNATING_MESSAGES);
    });

    it("is idempotent — repairing a repaired conversation changes nothing", () => {
      const entries = [
        assistantEntry("stray"),
        userEntry("go"),
        assistantEntry("", [use("tc1"), use("tc2")]),
        userEntry("", [result("tc1")]),
      ];
      const once = repairKiroConversation(entries);
      const twice = repairKiroConversation(once.entries);
      expect(twice.entries).toEqual(once.entries);
      expect(twice.diagnostics).toEqual([]);
    });
  });
});
