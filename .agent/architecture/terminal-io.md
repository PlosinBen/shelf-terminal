---
type: architecture
title: Terminal I/O
related:
  - context/terminal-pty
  - context/file-transfer
  - context/keybindings-shell
  - context/external-url-intent
---

# Terminal I/O

This flow describes how a terminal selects and initializes its first command interpreter, how user input reaches that shell and output reaches the screen, how files become readable by that shell, and how a cooperative terminal program can request an app-level external URL action.

## Flow

### Terminal request → interactive shell

```
Terminal request
   │
   ▼
Live connection generation ──► lazy target-facts resolution
   │                              │
   │                              ├─ positive shell path ──► shell-specific runner
   │                              └─ unavailable facts ────► native compatibility runner
   ▼
Immutable launch plan ──► PTY process
                            │
                            ▼
                     Main-owned initialization session
                            │
                            ├─ runner setup (hidden, input blocked)
                            ├─ project init script (visible; interrupt only when controlled)
                            ├─ tab command submission
                            └─ ready (normal input/output)
```

- The connection generation owns shared target facts; individual tabs only wait for the result. Replacing the generation invalidates the facts.
- The runner controls only the first interpreter Shelf launches. Zsh and Bash can establish target-local project history; other interpreters keep native history without becoming unsupported terminals.
- Main owns every phase gate and consumes only nonce- and phase-valid control frames. Renderer state is a presentation projection, not lifecycle authority.
- Automatic project setup is visible after runner initialization. Supported runners execute it internally so environment changes survive without adding the setup source to interactive history; the tab command remains ordinary shell input.

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

### Terminal program → external URL decision

```
Browser-aware terminal program
   │
   ▼
Shelf-required launcher on the shell host
   │  one bounded intent frame written to the controlling terminal
   ▼
PTY output stream
   │
   ├─ ordinary output ──► terminal rendering and output observers
   │
   └─ URL intent frame ──► strip from visible output
                           retain owning project/tab
                           validate and queue in the app-level URL gate
                                      │
                                      ▼
                          Copy URL / Open default app / Cancel
```

- The launcher is cooperative: it mediates programs that honor the shell's browser-launcher contract. Programs that call an operating-system browser API directly remain outside Shelf's boundary.
- The signal is one-way. The launcher exits after writing a valid frame; the originating command does not wait for the popup decision and Cancel does not terminate it.
- Remote shells emit the frame through their PTY, but the decision and any default-app launch happen in the local Shelf app.

## Boundaries

Inside this flow:
- Selection, launch, and initialization of the first Shelf-managed command interpreter.
- The keyboard path from a keypress through shortcut arbitration into the shell and back out as rendered output.
- The attachment path from a paste/drop gesture through policy checks and upload into shell-visible paths.
- The cooperative browser-launcher path from a terminal program through a stripped PTY control frame to an app-level user decision.
- The split of responsibility between the intercept-first keybinding layer and the terminal view that owns shell I/O and rendering.

Outside this flow:
- Command interpreters the user starts after the first shell becomes interactive, including nested shells, tmux, SSH, and containers.
- Which specific shortcuts exist, their default bindings, and how they are registered — that is the keybinding configuration concern, not the I/O path.
- How a shell process is spawned, isolated, and torn down; native-module and renderer-engine pitfalls — covered by the terminal/PTY context.
- Transport-specific upload mechanics, prefix parsing rules, and cleanup edge cases — covered by the file-transfer context.
- The connector's per-connection details (local, remote, container, subsystem) — covered by the connector context.
- Anything an agent backend sends or receives; this flow is only about the human-facing shell terminal.
