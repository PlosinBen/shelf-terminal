# Shelf — Architecture at a Glance

> A high-level, abstract tour of how Shelf is put together. It's meant to be
> *readable*, not exhaustive — no file names, no class names, just the big pieces
> and how they talk to each other. All diagrams render directly on GitHub.

Shelf is a **project-based terminal manager**: open many terminals across many
projects and environments without paying a housekeeping tax. Everything below
hangs off that one idea — the terminal is the core; the agent view and the PM
supervisor are comfortable add-ons layered on top.

**Colour legend** (used throughout):

| 🟩 Terminal / core | 🟪 Agent | 🟨 PM supervisor | ⬜ Plumbing | 🟦 You / environments |
|---|---|---|---|---|

---

## 1. The big picture

You drive a UI; Shelf owns your data and drives every connection; each
environment — local, SSH, Docker, or WSL — hosts a runtime that Shelf spawns and
keeps alive. The same shape holds everywhere.

```mermaid
flowchart TD
    You(["👤 You"]):::user

    subgraph App["🖥️ Shelf App — on your machine"]
        UI["UI<br/>projects · tabs · terminals · agent view"]:::core
        Coord["Coordinator<br/>owns your source-of-truth data<br/>drives every connection"]:::infra
    end

    You --> UI --> Coord
    Coord ==>|one uniform connection path| Envs

    subgraph Envs["🌐 Environments — all first-class citizens"]
        direction LR
        Local["💻 Local"]:::env
        SSH["🔐 SSH"]:::env
        Docker["🐳 Docker"]:::env
        WSL["🪟 WSL"]:::env
    end

    Envs ==> Runtime["📦 Per-host runtime<br/>spawned and kept alive by Shelf"]:::infra
    Runtime --> Shell["⌨️ Shell sessions"]:::core
    Runtime --> Agent["🤖 Agent CLIs<br/>Claude Code · Copilot"]:::agent

    classDef user fill:#dbeafe,stroke:#3b82f6,color:#1e3a5f;
    classDef core fill:#d1fae5,stroke:#10b981,color:#064e3b;
    classDef agent fill:#ede9fe,stroke:#8b5cf6,color:#4c1d95;
    classDef infra fill:#f1f5f9,stroke:#64748b,color:#1e293b;
    classDef env fill:#e0f2fe,stroke:#0ea5e9,color:#075985;
```

The rule that keeps this simple: **Shelf owns the canonical data; each host only
holds a disposable copy** that can be rebuilt at any time. Data always flows
*out* from the app to the host — the app never reaches into a host's filesystem.

---

## 2. Connecting a project — one path, every environment

Whether the work runs on your own machine or a box on the other side of the
world, it goes through **one uniform pathway**. Only the lowest layer that
actually moves bytes differs per environment, and that difference is hidden
behind a single "connector" role — so nothing above ever has to care *where* the
work runs.

```mermaid
flowchart TD
    Open["Open a project<br/>on any target"]:::core --> Conn

    subgraph Conn["🔌 Connector — one abstraction per environment kind"]
        direction LR
        S1["interactive<br/>shell channel"]:::infra
        S2["one-shot<br/>command channel"]:::infra
        S3["file upload"]:::infra
        S4["deploy runtime"]:::infra
    end

    Conn --> RT["📦 Runtime on the target<br/>one per connection"]:::infra
    RT <-->|"💓 heartbeat"| HB["Health and keep-alive<br/>· round-trip health light<br/>· liveness lease<br/>· idle self-shutdown (remote only)"]:::infra

    classDef core fill:#d1fae5,stroke:#10b981,color:#064e3b;
    classDef infra fill:#f1f5f9,stroke:#64748b,color:#1e293b;
```

- **Adding a new environment kind = adding one connector**, not editing every
  call site.
- A steady **heartbeat** does triple duty: it powers the per-project health
  light, refreshes a keep-alive lease so unused runtimes get reclaimed later, and
  lets an idle *remote* host shut itself down instead of burning resources while
  you sleep.

---

## 3. How the terminal moves bytes

Two interleaved tracks. Keystrokes are either claimed by an app shortcut or
passed straight through to the shell; pasted/dropped files are staged inside the
project so the shell can refer to them by path.

```mermaid
flowchart LR
    Key["⌨️ Keypress"]:::core --> KB{"App shortcut?"}:::infra
    KB -->|yes| Act["Run app action<br/>(swallow the key)"]:::infra
    KB -->|no| PTY["Shell process"]:::core
    PTY --> Out["Rendered output<br/>in the terminal view"]:::core

    Drop["📎 Paste / drop a file"]:::core --> Stage["Stage inside the project"]:::infra
    Stage --> Path["Insert the path<br/>as shell input"]:::core

    classDef core fill:#d1fae5,stroke:#10b981,color:#064e3b;
    classDef infra fill:#f1f5f9,stroke:#64748b,color:#1e293b;
```

---

## 4. The agent view, end to end

### 4a. One message → one rendered turn

You own drafting and display; the backend owns ordering and turn boundaries.
What crosses the wire back to the UI is always **render primitives** (a reply, a
foldable card, a note, an error) — never raw provider vocabulary. So the UI never
needs to know a tool name or a slash-command grammar.

```mermaid
sequenceDiagram
    autonumber
    actor You
    participant UI as UI (input + timeline)
    participant Q as Send queue<br/>(ordering authority)
    participant P as Provider turn<br/>(Claude / Copilot)

    You->>UI: type a message
    UI-->>You: echo it instantly (optimistic)
    UI->>Q: send across the wire (with a correlation id)
    Q->>Q: serialize turns · emit an ordered snapshot
    Q->>P: run this turn on the native CLI
    P-->>UI: render primitives<br/>(reply · card · note · error)
    UI-->>You: painted in the timeline
```

The queue is the single source of order: queued items draw as chips, and when one
flips to *running* the optimistic bubble is promoted into a real one. Config
edits (model / effort / permission) and pop-up pickers ride the *same* machinery
rather than opening side channels.

### 4b. Where those turns actually run

One host can hold many agent sessions. A thin, provider-agnostic **dispatcher**
sits in front of them: it routes by session id, relays the token stream
untouched, and supervises the per-session execution units that actually run the
CLI.

```mermaid
flowchart TD
    App["🖥️ Shelf App<br/>addresses every session by id"]:::infra
    App ==>|one channel per host| D

    subgraph Host["🌐 One host"]
        D["🚦 Dispatcher — thin front (one per host)<br/>· routes by session id<br/>· relays the stream untouched<br/>· holds the shared model cache<br/>· supervises and reconnects sessions"]:::infra
        D --> E1["⚙️ Session A<br/>execution"]:::agent
        D --> E2["⚙️ Session B<br/>execution"]:::agent
        E1 --> C1["Claude / Copilot CLI"]:::agent
        E2 --> C2["Claude / Copilot CLI"]:::agent
    end

    classDef infra fill:#f1f5f9,stroke:#64748b,color:#1e293b;
    classDef agent fill:#ede9fe,stroke:#8b5cf6,color:#4c1d95;
```

Three ideas keep this robust:

- **The front stays dumb on purpose.** It forwards the stream verbatim and only
  peeks at the handful of messages it services itself (a health reply, a cache
  lookup). Little logic means little to crash — and a frozen front can't freeze
  the whole host.
- **Health is checked at two levels.** The app beats against the *dispatcher*
  (is the host reachable?), and the dispatcher beats against *each execution*
  (is this one session hung?). A single stuck session is severed alone; its
  siblings are untouched.
- **Recovery is fail-loud, then reconnect.** If an execution dies, the loss is
  surfaced first — your spinner unsticks, the interrupted turn is visible — and
  only then is a fresh execution brought up and the conversation *resumed* from
  its last committed boundary. Never a silent gap.

---

## 5. The PM supervisor (optional)

The PM agent is a background supervisor. It's reactive — it wakes on a message,
reasons once, and its **only lever on the world is typing into a terminal**.
Everything it accomplishes is done by the CLI agent already living in that
terminal; the PM never runs commands or touches files itself.

```mermaid
flowchart TD
    In["📥 Message<br/>(Telegram or in-app)"]:::pm --> Thread["🧵 One shared thread<br/>(both surfaces are views of it)"]:::pm
    Thread --> Turn["🧠 PM turn<br/>reasons over history + project context"]:::pm
    Turn --> Gate{"Away or active?"}:::pm
    Gate -->|"active — you're driving"| Obs["👀 Observe only<br/>(channel withheld)"]:::pm
    Gate -->|"away"| Type["⌨️ Type into a project's terminal"]:::pm
    Type --> CLI["🤖 The CLI agent does the real work"]:::agent
    CLI --> Out["📤 Terminal output"]:::core
    Out -.->|"observed as plain text"| Turn

    classDef pm fill:#fef3c7,stroke:#f59e0b,color:#78350f;
    classDef agent fill:#ede9fe,stroke:#8b5cf6,color:#4c1d95;
    classDef core fill:#d1fae5,stroke:#10b981,color:#064e3b;
```

A single global **away / active** switch gates authority: *active* means you're
at the keyboard and the PM only watches; *away* hands it the terminal channel.
The gate is enforced by physically withholding the channel, not by instruction.

---

## Design principles

The whole system is shaped by a few non-negotiables:

1. **Core stable, extras swappable.** Project-based terminal management is the
   reason Shelf exists. Agent view, PM, notes, dev tools — all bonuses that can
   grow, shrink, or change without holding the core hostage.
2. **Every environment is first-class.** Local, SSH, Docker, and WSL are treated
   identically; remote execution is the normal case, not an edge case.
3. **Zero setup for you.** Install and go — no requirement to install Node,
   Python, or extra CLIs yourself (only provider sign-in, e.g. Claude / GitHub).
   Locally, Shelf runs on the Node runtime embedded in the app itself; on a
   remote it ships its own pinned Node. The one exception is a musl-based
   remote (e.g. Alpine Linux), which must already have Node installed because
   no official musl Node build exists to ship.
4. **Native stays native.** Where Claude / Copilot support something natively
   (skills, MCP, slash commands), Shelf opens it up and follows native behaviour
   rather than shipping a degraded copy.
5. **Not an IDE.** Shelf replaces the *tmux* layer (session management), not the
   editor. No built-in code editor, file tree, or language server — on purpose.
