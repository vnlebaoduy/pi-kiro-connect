# AGENTS.md — pi-kiro-connect

> Context file for AI coding assistants working on this codebase.

## Project Overview

pi / Oh My Pi extension that connects the coding agent to the Kiro API (AWS CodeWhisperer/Q). The model list is fetched live per region/profile (`src/models.ts`); auth covers Builder ID, IAM Identity Center, Google, GitHub, external IdP and `ksk_` API keys. Forked from `mikeyobrien/pi-provider-kiro` — see `NOTICE`.

## Directory Structure

```
pi-kiro-connect/
├── src/                    # TypeScript source (9 files, one feature each)
│   ├── index.ts            # F1: Extension registration entry point
│   ├── models.ts           # F2: Model catalog + ID resolution
│   ├── oauth.ts            # F3: Multi-provider OAuth (Builder ID / Google / GitHub)
│   ├── kiro-cli.ts         # F4: kiro-cli SQLite credential sharing
│   ├── transform.ts        # F5: pi ↔ Kiro message transformation
│   ├── history.ts          # F6: History truncation + sanitization
│   ├── thinking-parser.ts  # F7: Streaming <thinking> tag parser
│   ├── event-parser.ts     # F8: Kiro stream JSON event parser
│   ├── stream.ts           # F9: Main streaming orchestrator
│   ├── login.ts            # F10: Interactive login (Builder ID / IdC / social)
│   └── history-validator.ts # F11: Conversation invariant validation + repair
├── test/                   # 1:1 test files for each source file
├── dist/                   # Compiled output (tsc)
├── scripts/install.sh      # pi + omp installer (attached to every GitHub Release)
├── package.json            # Extension config: pi.extensions → dist/index.js
├── tsconfig.json           # ES2022, ESNext modules, strict
└── vitest.config.ts        # Test config
```

## Key Patterns

### Feature-per-file
Each `src/` file owns exactly one numbered feature (F1–F11). When modifying a feature, the relevant file is obvious. Each has a matching test file. The numbered set is not the whole tree — `src/` also holds unnumbered support modules (`endpoints.ts`, `retry.ts`, `debug.ts`, and others).

### Model ID Convention
pi uses dashes (`claude-sonnet-4-6`), Kiro API uses dots (`claude-sonnet-4.6`). Conversion in `resolveKiroModel()` via regex: `(\d)-(\d)` → `$1.$2`. The `KIRO_MODEL_IDS` Set is the source of truth for valid model IDs.

### Kiro History Format
Kiro requires strict alternating `userInputMessage` / `assistantResponseMessage` entries. Tool results must be wrapped in synthetic user messages. `buildHistory()` in transform.ts handles this; `history.ts` sanitizes and truncates.

A tool-result turn carries its payload in `userInputMessageContext.toolResults` and ships `content: ""`. Kiro's rule is content **or** tool results (`NON_EMPTY_USER_MESSAGE` in first-party Kiro Agent), so no carrier text is needed — and inventing some puts a sentence the user never wrote into the conversation as a user utterance. `EMPTY_CONTENT_PLACEHOLDER` is only for a turn with neither: image-only, empty-text, or an out-of-union role.

`history-validator.ts` (F11) owns the seven invariants. `streamKiro` calls `repairKiroConversation` on the whole conversation (history plus the current message) immediately before building the request and sends the repaired entries. It never throws; a violation that survives repair is warned about, not fatal. `prepareHistory` still runs first and still owns image stripping, truncation, and its own salvage passes — but its pairing test is positional, so a mismatched tool-use/tool-result pair reaches repair as the shape that actually needs fixing.

A tool result that arrived behind a later assistant turn than the one that called it is relocated back behind its issuing turn, matched by id, before anything positional runs (`relocateDisplacedToolResults`). That preserves the real tool output which positional sanitization would otherwise discard, and for the interleaved-transcript shape it also makes `ALTERNATING_MESSAGES` hold — the interjection merges into the relocated carrier instead of forming a second consecutive user entry. The cost is wire chronology: a user turn that interrupted between a call and its result now appears after that result. Pinned by tests in `test/stream.test.ts` and `test/transform.test.ts`; see the CHANGELOG entry.

Historical assistant reasoning is **not** serialized into `assistantResponseMessage.content`. First-party Kiro Agent's `extractTextContent` type-filters to `text`, and flattening reasoning to `<thinking>…</thinking>` fabricated an XML dialect into the model's own remembered speech. A reasoning-only assistant turn is retained with `content: ""` so alternation survives.

### Streaming Pipeline
Raw bytes → `parseKiroEvents()` → typed `KiroStreamEvent` → `ThinkingTagParser` (if reasoning) → pi `AssistantMessageEventStream` events.

### Retry with Reduction
On 413/too-large: error propagated immediately to the caller (no retry). The caller is responsible for handling context overflow (e.g., compaction or history trimming), matching kiro-cli behavior.

HTTP 429 is provider-retried only when its JSON `reason` is exactly `USER_REQUEST_RATE_EXCEEDED`; server wait hints and the 10-second fallback/cap are owned by `src/retry.ts`. Other generic 429/5xx responses remain owned by Pi's outer retry layer.

### Credential Cascade
1. kiro-cli SQLite DB — checks social token first (`kirocli:social:token`), then IDC token, then external IdP token (`kirocli:external-idp:token`)
2. OAuth device code flow (interactive, opens browser)

### Auth Methods
- `idc`: AWS Builder ID or IAM Identity Center (SSO). Refresh via SSO OIDC endpoint. Token format: `refreshToken|clientId|clientSecret|idc`. Preferred — has clientId/clientSecret for refresh.
- `desktop`: Google/GitHub social login via Kiro auth service. Refresh via `prod.{region}.auth.desktop.kiro.dev`. Token format: `refreshToken|desktop`
- `external-idp`: Enterprise OIDC IdP (e.g. Okta) configured by the org, established by `kiro-cli login`. Refresh is a public-client `refresh_token` grant against the tenant's own `token_endpoint` (form-encoded, snake_case response, no client secret). Token format: `refreshToken|clientId|tokenEndpoint|external-idp`. Requests **must** carry `tokentype: EXTERNAL_IDP` or Kiro answers 403 "Invalid token" — see `src/token-type.ts`.

### Login Methods
Users can authenticate via:
- **Builder ID / IAM Identity Center**: Native device code flow (works in SSH/remote). Reuses kiro-cli's OIDC client for the region (`getKiroCliIdcRegistration`) and records the session where kiro-cli keeps its own (`saveKiroCliIdcSession`), so both tools share one token family. `SSO_SCOPES` must stay identical to kiro-cli's registration scopes.
- **Google**: Social login (delegates to `kiro-cli login`, requires local browser or SSH port forwarding)
- **GitHub**: Social login (delegates to `kiro-cli login`, requires local browser or SSH port forwarding)

## Development

```bash
npm run build     # tsc → dist/
npm run check     # tsc --noEmit (type check only)
npm test          # vitest run
npm run test:watch # vitest (watch mode)
```

## Testing Patterns

- All tests use Vitest
- External calls (`fetch`, `execSync`, `existsSync`) are mocked via `vi.fn()` / `vi.stubGlobal()`
- Stream tests mock `fetch` to return a `ReadableStream`-like reader with `read()` returning encoded JSON chunks
- No integration tests — all unit tests with mocks
- Test file naming: `test/<source-name>.test.ts`

## Adding a New Model

Usually nothing to do: the catalog comes from `ListAvailableModels` at runtime. The static `bootstrapKiroModels` list in `src/models.ts` only matters before the first successful discovery; edit it (and `KIRO_MODEL_IDS`) only to change that fallback, then update counts in `test/models.test.ts` and `test/registration.test.ts`.

## Releasing

Tag `vX.Y.Z` matching `package.json`. `.github/workflows/release.yml` verifies, pushes `release/vX.Y.Z` (tag + built `dist/`, which pi git installs need), moves `release/latest` there when it is the highest version (pi's default install source, so `pi update` follows it), and creates the GitHub Release. omp is pointed at the newest exact tag instead: Bun caches git branch heads, so `omp plugin upgrade` never advances a branch install. Run tests with `KIRO_PROFILE_ARN` unset — `test/setup.ts` clears it.

## Common Gotchas

- `ZERO_COST` is a frozen shared object — don't try to mutate model costs
- The `as any` cast in `index.ts` is intentional — `ProviderConfig.oauth` doesn't type `getCliCredentials`
- `kiro-cli.ts` reads/writes kiro-cli's SQLite DB via `node:sqlite`, falling back to the `sqlite3` CLI
- Output token count is estimated (`content.length / 4`), not from the API
- `contextUsagePercentage` is the only usage metric Kiro provides; input tokens are back-calculated
- Social login (Google/GitHub) requires `kiro-cli` to be installed — pi delegates the auth flow to it

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
