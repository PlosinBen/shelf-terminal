---
type: contract
title: External URL Intent
related:
  - architecture/terminal-io
  - contracts/ipc-channels
  - contracts/terminal-control
  - context/external-url-intent
---

# External URL Intent

## Link Open entry

`src/shared/link-open-intent.ts` defines `LinkOpenInput`, `LinkOpenResult`, DOM source attributes and the `link-open:submit` channel. `shelfApi.linkOpen` routes direct user clicks through main validation. The original `url` is preserved; `destination` defaults to `shelf`, with `external` explicit. Source is `project-tab`, `project-note` (projectId/noteId), `skills-preview` (skillName/filePath), `pm-reply`, or `app-window`; capture reads the owning DOM surface and original href rather than resolved `anchor.href`.

- Project HTTP(S) returns a validated Web-tab action; renderer checks tab availability and activates the owning project. Missing projects or full tabs show an error. Agent `browser_open` still uses its separate per-call approval.
- Project file references resolve against canonical project cwd. Absolute paths, file URLs and `#L12` / `:12:3` suffixes are supported. Preview accepts only regular UTF-8 files up to 1 MiB; content is rendered as text, with a selected line. Local files use host file reads; remote files use only their owning ConnectorRuntime, POSIX path resolution and a bounded worker process (`sh`/`head` required). Remote file URLs allow empty/localhost authority, never a different host. Readers check connectivity and runtime generation without calling connect, cap stdout/stderr and enforce a 15-second total probe/read deadline. Random framing rejects shell startup noise. Missing files, permissions, disconnected/stale workers, missing commands, timeout, binary content, invalid encodings and unknown schemes report errors without host-local or external-app fallback.
- Default mailto displays `Shelf cannot preview email links`, the complete original value, Copy and Close. There is no external-open action.
- Explicit external requests delegate to the existing validated FIFO gate. The named external compatibility adapter pins this destination for device login, terminal BROWSER and navigation defenses. AuthPane marks its login anchor explicitly external.
- Skills Preview and PM reply HTTP(S) use a separate `destinationProjectId`, captured from active project at click time. Skills source remains the actual skill name and preview file, including auxiliary Markdown files; PM source remains `pm-reply`, for both displayed history and streaming reply Markdown. Main validates the captured destination and renderer opens that project even if active project changes while awaiting the response. Without an active project, show a missing-destination error with the original URL and Copy; do not choose or create a project. `destinationProjectId` is accepted only for these two app-scoped sources and does not authorize reading project files from their links.
- Other app-window HTTP/file requests require destination/source ownership and currently report an error.

The app-wide contract for validated external-app requests and cooperative terminal launcher frames. Authoritative types and limits live in `src/shared/external-url-intent.ts`; the terminal frame source is `src/shared/external-url-osc.ts`.

## Intent input and request

```ts
type ExternalUrlIntentSource =
  | { kind: 'pm-reply' }
  | { kind: 'skills-preview'; skillName: string; filePath: string }
  | { kind: 'project-tab'; projectId: string; tabId: string }
  | { kind: 'project-note'; projectId: string; noteId: string }
  | { kind: 'app-window' };

interface ExternalUrlIntentInput {
  url: string;
  reason: string;
  source: ExternalUrlIntentSource;
}

interface ExternalUrlIntentRequest extends ExternalUrlIntentInput {
  requestId: string;
  destination:
    | { kind: 'web-origin'; origin: string }
    | { kind: 'mail-address'; address: string };
}

type ExternalUrlIntentDecision = 'copy' | 'open' | 'cancel';
```

| Constraint | Contract |
|---|---|
| Schemes | `http:`, `https:`, `mailto:` only |
| URL | non-empty, trimmed, at most 8192 UTF-16 code units; HTTP(S) embedded credentials rejected |
| Reason | non-empty, trimmed, at most 512 code units |
| Source IDs | non-empty, trimmed, at most 256 code units each |
| Decision | resolves exactly once; Copy is initial keyboard selection; Escape is Cancel |
| Diagnostics | validation code or parsed destination only; never persist/log the exact URL |

## Renderer/main round-trip

```text
renderer producer --external-url-intent:submit(input)--> main gate
main gate --external-url-intent:request(request)--------> renderer popup
renderer --external-url-intent:resolve({requestId, decision})--> main gate
main gate --external-url-intent:close({requestId})------> renderer popup
```

`submit` is available to renderer producers; main-owned producers call the same gate directly. Main queues one active request at a time, fails closed when the renderer is unavailable or the request times out, and alone performs clipboard/default-app effects.

## Cooperative terminal frame

```text
ESC ] 6973 ; external-url ; 1 ; <base64url(UTF-8 exact URL)> BEL
```

The string prefix is `\x1b]6973;external-url;1;`. `ST` (`ESC \\`) is accepted as an alternate terminator. Payload is unpadded canonical base64url and bounded from the 8192-character URL limit. One shared Shelf OSC router receives fragmented or multiple frames and dispatches by route; the external-url handler consumes only a supported valid frame. Unrelated output, unknown routes/versions, and frames no phase-aware handler owns remain visible. See `contracts/terminal-control` for the shared envelope and terminal-init route.

| Parser anomaly | Meaning |
|---|---|
| `invalid-payload` | non-canonical base64url, invalid UTF-8, empty payload, or decoded URL beyond the limit |
| `frame-too-long` | frame exceeded the bounded maximum before or at termination |
| `unterminated-frame` | PTY stream ended with a partial Shelf frame |

The parser returns extracted URL strings to main for normal intent validation. An anomaly value never includes payload bytes.
