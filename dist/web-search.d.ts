export interface KiroWebSearchResult {
    title: string;
    url: string;
    snippet: string;
    publishedDate: number | null;
    domain: string;
    [key: string]: unknown;
}
/** Kiro returns up to ten results; keep all of them, but strip the payload. */
export declare const KIRO_WEB_SEARCH_MAX_RESULTS = 10;
export declare const KIRO_WEB_SEARCH_MAX_SNIPPET_CHARS = 300;
export interface KiroWebSearchDigest {
    title: string;
    url: string;
    domain: string;
    snippet: string;
}
/**
 * Bound what a search adds to the agent context: five results, short snippets,
 * and no provider-specific extras. Callers that need the raw payload should use
 * `invokeKiroWebSearch` directly.
 */
export declare function digestKiroWebSearchResults(results: readonly KiroWebSearchResult[]): KiroWebSearchDigest[];
export interface KiroWebSearchAuth {
    accessToken: string;
    region: string;
    profileArn: string;
}
/** Thrown for an InvokeMCP JSON-RPC error (HTTP 200, `error` set) or an HTTP-level failure. */
export declare class KiroWebSearchError extends Error {
    readonly code?: number | undefined;
    constructor(message: string, code?: number | undefined);
}
/** Kiro rejects a longer `query` in `tools/call`; check before spending a request. */
export declare const KIRO_WEB_SEARCH_MAX_QUERY_LENGTH = 200;
/** Kiro answers in a few seconds; a hung connection must not pin the agent turn. */
export declare const KIRO_WEB_SEARCH_TIMEOUT_MS = 20000;
/**
 * Note: the `user-agent`/`x-amz-user-agent` strings are required — Kiro
 * answers 403 without them, even with a valid token.
 */
export declare function invokeKiroWebSearch(auth: KiroWebSearchAuth, query: string, signal?: AbortSignal): Promise<KiroWebSearchResult[]>;
