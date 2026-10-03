import type { AssistantMessage, AssistantMessageEvent } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { ThinkingTagParser } from "../src/thinking-parser.js";

function makeOutput(): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: "kiro-api",
    provider: "kiro",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

async function run(chunks: string[]): Promise<AssistantMessageEvent[]> {
  const output = makeOutput();
  const stream = createAssistantMessageEventStream();
  const parser = new ThinkingTagParser(output, stream);
  for (const c of chunks) parser.processChunk(c);
  parser.finalize();
  stream.end();
  const events: AssistantMessageEvent[] = [];
  for await (const e of stream) events.push(e);
  return events;
}

function deltas(events: AssistantMessageEvent[], type: string): string {
  return events
    .filter((e) => e.type === type)
    .map((e) => (e as { delta?: string }).delta)
    .join("");
}

/**
 * Maps every emitted `contentIndex` to the block family that used it, failing if
 * one index is ever claimed by both the text and thinking families.
 */
function indexOwners(events: AssistantMessageEvent[]): Map<number, string> {
  const owner = new Map<number, string>();
  for (const e of events) {
    const idx = (e as { contentIndex?: number }).contentIndex;
    if (idx === undefined) continue;
    const kind = e.type.startsWith("thinking") ? "thinking" : "text";
    const existing = owner.get(idx);
    if (existing === undefined) owner.set(idx, kind);
    else expect(existing).toBe(kind);
  }
  return owner;
}

describe("Feature 7: Thinking Tag Parser", () => {
  it("emits thinking then text for content with thinking block", async () => {
    const events = await run(["<thinking>Let me think</thinking>\n\nAnswer"]);
    const types = events.map((e) => e.type);
    expect(types).toContain("thinking_start");
    expect(types).toContain("text_start");
    expect(deltas(events, "thinking_delta")).toContain("Let me think");
    expect(deltas(events, "text_delta")).toContain("Answer");
  });

  it("emits only text when no thinking block", async () => {
    const events = await run(["Just plain text"]);
    expect(events.map((e) => e.type)).not.toContain("thinking_start");
    expect(deltas(events, "text_delta")).toBe("Just plain text");
  });

  it("flushes plain text immediately without waiting for finalize", () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);

    parser.processChunk("Hello world");

    expect(output.content[0]?.type).toBe("text");
    expect(output.content[0]?.type === "text" && output.content[0].text).toBe("Hello world");
  });

  it("retains only a trailing possible opening-tag prefix between chunks", () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);

    parser.processChunk("Hello <thin");

    expect(output.content[0]?.type).toBe("text");
    expect(output.content[0]?.type === "text" && output.content[0].text).toBe("Hello ");

    parser.processChunk("king>deep thought</thinking>");
    parser.finalize();

    // Text keeps the index it was created with; thinking is appended after it.
    expect(output.content[0]?.type === "text" && output.content[0].text).toBe("Hello ");
    expect(output.content[1]?.type).toBe("thinking");
    expect(output.content[1]?.type === "thinking" && output.content[1].thinking).toBe("deep thought");
  });

  it("detects thinking start tag split across chunks", async () => {
    const events = await run(["<thin", "king>deep thought</thinking>"]);
    expect(deltas(events, "thinking_delta")).toContain("deep thought");
  });

  it("detects thinking end tag split across chunks", async () => {
    const events = await run(["<thinking>thought</thi", "nking>\n\nAnswer"]);
    expect(events.map((e) => e.type)).toContain("thinking_end");
    expect(deltas(events, "text_delta")).toContain("Answer");
  });

  it("strips double newline between thinking and text", async () => {
    const events = await run(["<thinking>t</thinking>\n\nAnswer"]);
    expect(deltas(events, "text_delta")).toBe("Answer");
  });

  it("getTextBlockIndex returns null before text emitted", () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);
    expect(parser.getTextBlockIndex()).toBeNull();
  });

  it("getTextBlockIndex returns 0 for text-only content", () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("hello");
    parser.finalize();
    expect(parser.getTextBlockIndex()).toBe(0);
  });

  it("getTextBlockIndex returns 1 after thinking block", () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);
    parser.processChunk("<thinking>t</thinking>\n\ntext");
    parser.finalize();
    expect(parser.getTextBlockIndex()).toBe(1);
  });

  // =========================================================================
  // Additional thinking tag variants (Task 2.1)
  // =========================================================================

  it("recognizes <think> tags", async () => {
    const events = await run(["<think>Let me think</think>\n\nAnswer"]);
    const types = events.map((e) => e.type);
    expect(types).toContain("thinking_start");
    expect(types).toContain("text_start");
    expect(deltas(events, "thinking_delta")).toContain("Let me think");
    expect(deltas(events, "text_delta")).toContain("Answer");
  });

  it("recognizes <reasoning> tags", async () => {
    const events = await run(["<reasoning>Step by step</reasoning>\n\nResult"]);
    const types = events.map((e) => e.type);
    expect(types).toContain("thinking_start");
    expect(types).toContain("text_start");
    expect(deltas(events, "thinking_delta")).toContain("Step by step");
    expect(deltas(events, "text_delta")).toContain("Result");
  });

  it("recognizes <thought> tags", async () => {
    const events = await run(["<thought>Hmm</thought>\n\nDone"]);
    const types = events.map((e) => e.type);
    expect(types).toContain("thinking_start");
    expect(types).toContain("text_start");
    expect(deltas(events, "thinking_delta")).toContain("Hmm");
    expect(deltas(events, "text_delta")).toContain("Done");
  });

  it("handles <think> split across chunks", async () => {
    const events = await run(["<thi", "nk>deep thought</think>\n\nText"]);
    expect(deltas(events, "thinking_delta")).toContain("deep thought");
    expect(deltas(events, "text_delta")).toContain("Text");
  });

  it("handles <reasoning> split across chunks", async () => {
    const events = await run(["<reason", "ing>logic</reasoning>\n\nOutput"]);
    expect(deltas(events, "thinking_delta")).toContain("logic");
    expect(deltas(events, "text_delta")).toContain("Output");
  });

  it("handles close tag split across chunks for <think>", async () => {
    const events = await run(["<think>idea</th", "ink>\n\nText"]);
    expect(events.map((e) => e.type)).toContain("thinking_end");
    expect(deltas(events, "text_delta")).toContain("Text");
  });

  // =========================================================================
  // Wire order (Kiro API can send text before thinking)
  // =========================================================================

  it("keeps text that arrived before the first thinking region ahead of it", async () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);

    // Simulate Kiro API: text content arrives before thinking
    parser.processChunk("Hello world");
    parser.processChunk("<thinking>reasoning</thinking>");
    parser.finalize();
    stream.end();

    // The content array is a record of what the model emitted and when, so the
    // text the model produced first stays first. An earlier revision spliced
    // the thinking block in ahead of it to drive UI order; that made the
    // persisted order contradict the wire and invalidated already-emitted
    // content indices.
    expect(output.content.map((b) => b.type)).toEqual(["text", "thinking"]);
    expect((output.content[0] as { text: string }).text).toBe("Hello world");
    expect((output.content[1] as { thinking: string }).thinking).toBe("reasoning");
  });

  it("never reuses a contentIndex for two different blocks", async () => {
    const events = await run(["Hello world", "<thinking>reasoning</thinking>"]);

    // Each contentIndex must name exactly one block for the life of the stream.
    // Splicing a block into the middle of the array broke this: text_start@0
    // and thinking_start@0 were both emitted, so a consumer rebuilding content
    // from events wrote the thinking block over the text it had at index 0.
    const owner = indexOwners(events);
    expect(owner.get(0)).toBe("text");
    expect(owner.get(1)).toBe("thinking");
  });

  it("preserves order for a text -> thinking -> text message", async () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);

    parser.processChunk("before<thinking>mid</thinking>\n\nafter");
    parser.finalize();
    stream.end();
    const events: AssistantMessageEvent[] = [];
    for await (const e of stream) events.push(e);

    expect(output.content.map((b) => b.type)).toEqual(["text", "thinking", "text"]);
    expect((output.content[0] as { text: string }).text).toBe("before");
    expect((output.content[1] as { thinking: string }).thinking).toBe("mid");
    expect((output.content[2] as { text: string }).text).toBe("after");

    // This is the shape the splice aliased worst: it emitted text_start@0 then
    // thinking_start@0 then text_start@2, so index 0 named a text block and a
    // thinking block in the same stream while index 1 was never announced.
    // Order alone does not pin that — assert index ownership as well.
    const owner = indexOwners(events);
    expect([...owner.entries()].sort(([a], [b]) => a - b)).toEqual([
      [0, "text"],
      [1, "thinking"],
      [2, "text"],
    ]);
  });

  it("getTextBlockIndex points at the first text block when text arrives first", () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);

    parser.processChunk("Hello");
    parser.processChunk("<thinking>t</thinking>");
    parser.finalize();

    // No splice, so the text block keeps the index it was created with.
    expect(parser.getTextBlockIndex()).toBe(0);
  });

  // =========================================================================
  // Multiple thinking regions in a single streamed message
  // =========================================================================

  it("recognizes a second thinking region in the same message", async () => {
    const events = await run(["<thinking>first</thinking>\n\nmiddle<thinking>second</thinking>\n\nend"]);
    const thinking = deltas(events, "thinking_delta");
    expect(thinking).toContain("first");
    expect(thinking).toContain("second");
  });

  it("never leaks literal tag text into visible text after the first region", async () => {
    const events = await run(["<thinking>first</thinking>\n\nmiddle<thinking>second</thinking>\n\nend"]);
    const text = deltas(events, "text_delta");
    expect(text).not.toContain("<thinking>");
    expect(text).not.toContain("</thinking>");
    expect(text).toBe("middleend");
  });

  it("files each thinking region as its own thinking block", async () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);

    parser.processChunk("<thinking>first</thinking>\n\nmiddle<thinking>second</thinking>\n\nend");
    parser.finalize();

    const thinkingBlocks = output.content.filter((b) => b.type === "thinking");
    expect(thinkingBlocks.map((b) => (b as { thinking: string }).thinking)).toEqual(["first", "second"]);
  });

  it("files every region in wire order, alternating with the text between them", async () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);

    parser.processChunk("<thinking>first</thinking>\n\nmiddle<thinking>second</thinking>\n\nend");
    parser.finalize();

    expect(output.content.map((b) => b.type)).toEqual(["thinking", "text", "thinking", "text"]);
  });

  it("recognizes a second region using a different tag variant", async () => {
    const events = await run(["<think>a</think>\n\nmid<reasoning>b</reasoning>\n\nz"]);
    const thinking = deltas(events, "thinking_delta");
    expect(thinking).toContain("a");
    expect(thinking).toContain("b");
    expect(deltas(events, "text_delta")).toBe("midz");
  });

  it("detects a second region whose open tag is split across chunks", async () => {
    const events = await run(["<thinking>a</thinking>\n\nmid<thin", "king>b</thinking>\n\nz"]);
    const thinking = deltas(events, "thinking_delta");
    expect(thinking).toContain("a");
    expect(thinking).toContain("b");
    expect(deltas(events, "text_delta")).toBe("midz");
  });

  it("emits a thinking_end for every region", async () => {
    const events = await run(["<thinking>a</thinking>\n\nmid<thinking>b</thinking>\n\nz"]);
    expect(events.filter((e) => e.type === "thinking_end")).toHaveLength(2);
    expect(events.filter((e) => e.type === "thinking_start")).toHaveLength(2);
  });

  it("preserves empty first and later regions as distinct thinking blocks", () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);

    parser.processChunk("<thought></thought>mid<reasoning></reasoning>end");
    parser.finalize();
    stream.end();

    expect(output.content).toEqual([
      { type: "thinking", thinking: "" },
      { type: "text", text: "mid" },
      { type: "thinking", thinking: "" },
      { type: "text", text: "end" },
    ]);
  });

  it("emits start and end events for empty first and later regions", async () => {
    const events = await run(["<thou", "ght></thought>mid<reasoning></reasoning>end"]);
    const thinkingStarts = events.filter((event) => event.type === "thinking_start");
    const thinkingEnds = events.filter((event) => event.type === "thinking_end");

    expect(thinkingStarts.map((event) => event.contentIndex)).toEqual([0, 2]);
    expect(thinkingEnds.map((event) => event.contentIndex)).toEqual([0, 2]);
    expect(thinkingEnds.map((event) => event.content)).toEqual(["", ""]);
    expect(deltas(events, "text_delta")).toBe("midend");
  });

  it("materializes an empty region after text without moving it ahead of that text", async () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);

    // The intersection of the two guarantees: an empty region must still
    // become its own block, and it must still be appended. The close tag is
    // what materializes it, so this is the one shape where materialization and
    // wire ordering are decided by the same call.
    parser.processChunk("Hello<thinking></thinking>");
    parser.finalize();
    stream.end();

    expect(output.content).toEqual([
      { type: "text", text: "Hello" },
      { type: "thinking", thinking: "" },
    ]);
    expect(parser.getTextBlockIndex()).toBe(0);
  });

  it("keeps the text index stable when an empty region follows text", async () => {
    const events = await run(["Hello<thinking></thin", "king>"]);
    const owner = new Map<number, string>();
    for (const event of events) {
      const index = (event as { contentIndex?: number }).contentIndex;
      if (index === undefined) continue;
      const kind = event.type.startsWith("thinking") ? "thinking" : "text";
      const existing = owner.get(index);
      if (existing === undefined) owner.set(index, kind);
      else expect(existing).toBe(kind);
    }

    expect(owner.get(0)).toBe("text");
    expect(owner.get(1)).toBe("thinking");
  });

  it("getTextBlockIndex points at the last text block across regions", () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);

    parser.processChunk("<thinking>a</thinking>\n\nmid<thinking>b</thinking>\n\nz");
    parser.finalize();

    // content: [thinking a, text mid, thinking b, text z]
    expect(parser.getTextBlockIndex()).toBe(3);
    expect((output.content[3] as { text: string }).text).toBe("z");
  });

  it("keeps the last text index when back-to-back regions have no text between them", () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);

    parser.processChunk("<thinking>a</thinking>\n\nmid<thinking>b</thinking><thinking>c</thinking>");
    parser.finalize();

    // content: [thinking a, text mid, thinking b, thinking c]. Closing region c
    // must not erase the index of the "mid" text block: stream.ts relies on it
    // for text_end, bracket tool-call recovery and echo stripping.
    expect(output.content.map((b) => b.type)).toEqual(["thinking", "text", "thinking", "thinking"]);
    expect(parser.getTextBlockIndex()).toBe(1);
    expect((output.content[1] as { text: string }).text).toBe("mid");
  });

  it("handles text-before-thinking across multiple chunks", async () => {
    const output = makeOutput();
    const stream = createAssistantMessageEventStream();
    const parser = new ThinkingTagParser(output, stream);

    parser.processChunk("Hey! ");
    parser.processChunk("What can I help with?");
    parser.processChunk("<thinking>Let me think about this</thinking>");
    parser.finalize();
    stream.end();

    expect(output.content.map((b) => b.type)).toEqual(["text", "thinking"]);
    expect((output.content[0] as { text: string }).text).toBe("Hey! What can I help with?");
    expect((output.content[1] as { thinking: string }).thinking).toBe("Let me think about this");
  });
});
