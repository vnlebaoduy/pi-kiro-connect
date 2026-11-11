import { afterEach, describe, expect, it, vi } from "vitest";
import {
  digestKiroWebSearchResults,
  invokeKiroWebSearch,
  KIRO_WEB_SEARCH_MAX_QUERY_LENGTH,
  KIRO_WEB_SEARCH_MAX_RESULTS,
  KIRO_WEB_SEARCH_MAX_SNIPPET_CHARS,
  KiroWebSearchError,
} from "../src/web-search.js";

const auth = {
  accessToken: "test-access-token",
  region: "us-east-1",
  profileArn: "arn:aws:codewhisperer:us-east-1:123456789012:profile/test",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Kiro web_search (InvokeMCP)", () => {
  it("posts a tools/call JSON-RPC request to the /mcp endpoint with the required UA headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          error: null,
          id: "x",
          jsonrpc: "2.0",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  results: [
                    { title: "A", url: "https://a.example", snippet: "s", publishedDate: 1, domain: "a.example" },
                  ],
                }),
              },
            ],
          },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const results = await invokeKiroWebSearch(auth, "today's top tech news");

    expect(results).toEqual([
      { title: "A", url: "https://a.example", snippet: "s", publishedDate: 1, domain: "a.example" },
    ]);
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, request] = fetchMock.mock.calls[0];
    expect(url).toBe("https://runtime.us-east-1.kiro.dev/mcp");
    expect(request.method).toBe("POST");
    expect(request.headers.Authorization).toBe("Bearer test-access-token");
    expect(request.headers["user-agent"]).toMatch(/^aws-sdk-rust\/1\.0\.0/);
    expect(request.headers["x-amz-user-agent"]).toBe(request.headers["user-agent"]);
    expect(request.headers["x-amzn-codewhisperer-optout"]).toBe("true");
    const body = JSON.parse(request.body);
    expect(body).toMatchObject({
      jsonrpc: "2.0",
      method: "tools/call",
      profileArn: auth.profileArn,
      params: { name: "web_search", arguments: { query: "today's top tech news" } },
    });
  });

  it("throws KiroWebSearchError on a JSON-RPC error envelope (HTTP 200)", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({ error: { code: -32602, message: "Tool not found" }, id: "x", jsonrpc: "2.0", result: null }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(invokeKiroWebSearch(auth, "q")).rejects.toThrow(KiroWebSearchError);
    await expect(invokeKiroWebSearch(auth, "q")).rejects.toThrow("Tool not found");
  });

  it("throws KiroWebSearchError on an HTTP-level failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 403, statusText: "Forbidden" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(invokeKiroWebSearch(auth, "q")).rejects.toThrow(/403/);
  });

  it("throws KiroWebSearchError when the result has no content", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: null, id: "x", jsonrpc: "2.0", result: { content: [] } }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(invokeKiroWebSearch(auth, "q")).rejects.toThrow(KiroWebSearchError);
  });

  it("rejects a query Kiro would refuse before spending a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(invokeKiroWebSearch(auth, "x".repeat(KIRO_WEB_SEARCH_MAX_QUERY_LENGTH + 1))).rejects.toThrow(
      /200 characters or fewer/,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("trims the query it sends", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          error: null,
          result: { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await invokeKiroWebSearch(auth, "  kiro news  ");

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).params.arguments.query).toBe("kiro news");
  });

  it("cancels before sending when the caller's signal is already aborted", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    controller.abort();

    await expect(invokeKiroWebSearch(auth, "q", controller.signal)).rejects.toThrow(/cancelled/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("gives fetch a signal so the request dies with the agent turn", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          error: null,
          result: { content: [{ type: "text", text: JSON.stringify({ results: [] }) }] },
        }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await invokeKiroWebSearch(auth, "q", new AbortController().signal);

    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });
});

describe("digestKiroWebSearchResults", () => {
  const result = (index: number, snippet = `snippet ${index}`) => ({
    title: `Title ${index}`,
    url: `https://example.com/${index}`,
    snippet,
    publishedDate: index,
    domain: "example.com",
    providerPayload: { big: "x".repeat(1000) },
  });

  it("returns at most five results with only the fields the model needs", () => {
    const digest = digestKiroWebSearchResults(Array.from({ length: 8 }, (_, index) => result(index)));

    expect(digest).toHaveLength(KIRO_WEB_SEARCH_MAX_RESULTS);
    expect(digest[0]).toEqual({
      title: "Title 0",
      url: "https://example.com/0",
      domain: "example.com",
      snippet: "snippet 0",
    });
    expect(digest[0]).not.toHaveProperty("providerPayload");
  });

  it("clips long snippets so one search cannot flood the context", () => {
    const [digest] = digestKiroWebSearchResults([result(0, "y".repeat(KIRO_WEB_SEARCH_MAX_SNIPPET_CHARS + 500))]);

    expect(digest.snippet).toHaveLength(KIRO_WEB_SEARCH_MAX_SNIPPET_CHARS);
    expect(digest.snippet.endsWith("…")).toBe(true);
  });
});
