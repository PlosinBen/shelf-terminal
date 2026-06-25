---
type: architecture
title: Terminal I/O
related:
  - context/terminal-pty
  - context/file-transfer
  - context/keybindings-shell
---

# Terminal I/O

This flow describes how user input reaches a shell and how shell output reaches the screen, plus how files dropped or pasted into a terminal become readable by that shell. At the abstract level there are two interleaved tracks: a keyboard track where each keystroke is either claimed by an application shortcut or passed through to the shell, and an attachment track where pasted or dropped files are written into a project-scoped staging area so the shell can refer to them by path.

## Flow

### Keyboard → output

```
Keypress
   │
   ▼
Keybinding layer (intercept-first)
   │
   ├─ matches a registered app shortcut? ──► run app action, swallow the event
   │                                          (event never reaches the terminal view)
   │
   └─ no match ──► Terminal view
                      │
                      ▼
                   Input bridge ──► Connector ──► PTY (shell process)
                                                     │
                                                     ▼
                                                  Output stream
                                                     │
                                                     ▼
                                                  Terminal view (rendered cells)
```

- The keybinding layer listens ahead of the terminal view so that application shortcuts win even while the terminal holds focus. A matched shortcut is consumed and stops; only unmatched keys flow onward as raw shell input.
- A small set of platform-native clipboard gestures (copy/paste on non-mac) are not application shortcuts; the terminal view explicitly lets the platform handle them rather than forwarding them to the shell.
- Input the user types is what arms idle-completion notification; output the shell generates on its own does not.
- Output from the shell process is streamed back through the connector and painted by the terminal view. A background tab that produces sustained output marks itself unread.

### Paste / drag-drop files → shell

```
Paste or drop carrying file(s)
   │
   ▼
Attachment interceptor (in the terminal view)
   │  paste: intercept ahead of the terminal so the gesture isn't swallowed
   │  drop:  intercept after, since the terminal ignores drops
   │
   ├─ payload is text only ──► fall through to normal paste-as-text
   │
   └─ payload carries file(s)
            │
            ▼
       Size / policy check
            │
            ▼
       Connector.upload ──► project-scoped staging dir under the working tree
            │                 (one shared upload entry point across every transport)
            ▼
       Resulting path(s) inserted as shell input
```

- All uploads land in a staging area inside the project's working tree (not a global system temp location) so that sandboxed tools can read them by path.
- Every transport uses one symmetric upload mechanism: create the directory and stream the bytes in a single remote shell step, with the destination path quoted once.
- Staged files are named with a time-encoded prefix; a session-scoped cleanup removes entries older than the current process start, and a manual clear empties the area on demand. Files without the recognized prefix are left untouched.

## Boundaries

Inside this flow:
- The keyboard path from a keypress through shortcut arbitration into the shell and back out as rendered output.
- The attachment path from a paste/drop gesture through policy checks and upload into shell-visible paths.
- The split of responsibility between the intercept-first keybinding layer and the terminal view that owns shell I/O and rendering.

Outside this flow:
- Which specific shortcuts exist, their default bindings, and how they are registered — that is the keybinding configuration concern, not the I/O path.
- How a shell process is spawned, isolated, and torn down; native-module and renderer-engine pitfalls — covered by the terminal/PTY context.
- Transport-specific upload mechanics, prefix parsing rules, and cleanup edge cases — covered by the file-transfer context.
- The connector's per-connection details (local, remote, container, subsystem) — covered by the connector context.
- Anything an agent backend sends or receives; this flow is only about the human-facing shell terminal.
