---
type: contract
title: External URL Intent
related:
  - architecture/terminal-io
  - contracts/ipc-channels
  - context/external-url-intent
---

# External URL Intent

The app-wide contract for validated external-app requests and cooperative terminal launcher frames. Authoritative types and limits live in `src/shared/external-url-intent.ts`; the terminal frame source is `src/shared/external-url-osc.ts`.

## Intent input and request

```ts
type ExternalUrlIntentSource =
  | { kind: 'project-tab'; projectId: string; tabId: string }
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

The string prefix is `\x1b]6973;external-url;1;`. `ST` (`ESC \\`) is accepted as an alternate terminator. Payload is unpadded canonical base64url and bounded from the 8192-character URL limit. The streaming parser may receive fragmented or multiple frames; it preserves all unrelated terminal output and removes every recognized Shelf frame.

| Parser anomaly | Meaning |
|---|---|
| `invalid-payload` | non-canonical base64url, invalid UTF-8, empty payload, or decoded URL beyond the limit |
| `frame-too-long` | frame exceeded the bounded maximum before or at termination |
| `unterminated-frame` | PTY stream ended with a partial Shelf frame |

The parser returns extracted URL strings to main for normal intent validation. An anomaly value never includes payload bytes.
