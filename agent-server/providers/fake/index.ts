import { randomUUID } from 'node:crypto';
import { formatConfigAck } from '@shared/config-ack';
import { parseSlashPrefix } from '@shared/slash-prefix';
import { FAKE_PROVIDER, type AgentProvider } from '@shared/agent-providers';
import { mdTable } from '../md-table';
import { callMain } from '../../app-tool-client';
import { FAKE_TEST_ENV } from './test-env';
import type {
  OutgoingMessage,
  PickerResolvePayload,
  ProviderCapabilities,
  QueryInput,
  SendFn,
  ServerBackend,
} from '../types';

const FAKE_AUTH_DISPLAY_NAME = 'Fake Harness';

/**
 * Fake provider for E2E — emits scripted OutgoingMessage sequences in
 * response to scenario-prefixed prompts. Gated by `SHELF_TEST_MODE=1`
 * (see `agent-server/index.ts`); never reachable in production builds
 * even though it's bundled.
 *
 * Design contract: fake provider speaks the *same* wire shapes as real
 * providers. No test-only events. Anything fake emits, a real provider
 * could also emit. This is what makes renderer specs against fake
 * provider portable as a "wire-level integration check".
 *
 * Scenario syntax (prefix-matched against `input.prompt`):
 *   text:<msg>          stream chunks then finalize as text message
 *   chunk:<msg>         stream chunks under a fresh msgId, NO finalize (copilot
 *                       boundary-split segment — settles only at turn-end idle)
 *   thinking:<msg>      thinking message
 *   tool:<name>         tool_use + tool_result success
 *   tool_err:<name>     tool_use + tool_result error
 *   subagent:<label>    outer Agent/Task tool_use card + inner steps tagged with
 *                       parentToolUseId (nested under it in the renderer) + the
 *                       outer card's completion. Emits NO task_event — mirrors a
 *                       real subagent post-filter (routeTask drops it from the
 *                       panel), so the panel stays empty. See subagent-display.
 *   permission:<tool>   permission_request, await resolve, follow-up system msg
 *   picker_single       1-prompt single-select picker (3 options)
 *   picker_combo        1-prompt picker with options AND free-text (real
 *                       AskUserQuestion shape: options + inputType together)
 *   picker_multi        3-prompt picker (single, multi+desc, free-text)
 *   picker_input        free-text only (options=[], inputType=text)
 *   picker_number       free-text only (options=[], inputType=integer)
 *   auth_required       emit auth_required
 *   env:<NAME>          echo the exec process env var <NAME> as a reply (proves
 *                       project-env injection reached the agent-server)
 *   error:<msg>         emit error
 *   delay:<ms>          sleep before next step
 *   task:<id>           emit a running background task_event (turnId-less)
 *   taskdone:<id>       emit a completed background task_event + stash its
 *                       output so read_task_output (fetchTaskOutput) returns it
 *   taskfail:<id>       emit a failed (errored) terminal background task_event
 *   plan:<markdown>     emit a plan / todo-list side-channel update (→ PlanPanel,
 *                       distinct from the background-tasks panel)
 *   serverturn:<msg>    server-initiated turn (auto-resume prose): turn_started
 *                       + reply + idle, all on a fresh turnId
 *
 * Chain steps with `|`:
 *   text:hi|delay:50|tool:Read|text:bye
 *
 * Unknown prompts fall back to a plain `text:<prompt>` echo so ad-hoc
 * manual testing still produces visible output.
 */

interface PendingPicker {
  resolve: (payload: PickerResolvePayload) => void;
}

interface PendingPermission {
  resolve: (allow: boolean, message?: string) => void;
}

function mintId(prefix: string): string {
  return `${prefix}-${randomUUID().slice(0, 8)}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Pure: split chain string on `|`, drop empty steps. Exported for tests. */
export function parseChain(prompt: string): string[] {
  return prompt.split('|').map((s) => s.trim()).filter((s) => s.length > 0);
}

interface FakePromptOption { label: string; description?: string; preview?: string }
interface FakePrompt {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: FakePromptOption[];
  inputType?: 'text' | 'number' | 'integer';
}

/** Pure: shape the canned picker_multi prompt list. Exported for tests. */
export function pickerMultiPrompts(): FakePrompt[] {
  return [
    {
      question: 'Pick a color',
      multiSelect: false,
      options: [
        { label: 'red' },
        { label: 'green' },
        { label: 'blue' },
      ],
    },
    {
      question: 'Pick toppings',
      header: 'Toppings',
      multiSelect: true,
      options: [
        { label: 'cheese', description: 'extra fromage' },
        { label: 'mushroom' },
        { label: 'olives' },
      ],
    },
    {
      question: 'Any notes?',
      multiSelect: false,
      options: [],
      inputType: 'text' as const,
    },
  ];
}

/** Pure: shape picker_single. Exported for tests. */
export function pickerSinglePrompts(): FakePrompt[] {
  return [{
    question: 'Pick one',
    multiSelect: false,
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
  }];
}

/** Pure: shape picker_combo — options AND free-text in one prompt. This is
 *  the shape every real Claude AskUserQuestion produces (askUserQuestionToPrompts
 *  hardcodes inputType:'text' alongside the listed options), so it exercises
 *  the "type your own without picking an option" path end-to-end. Exported
 *  for tests. */
export function pickerComboPrompts(): FakePrompt[] {
  return [{
    question: 'Pick one or type your own',
    multiSelect: false,
    options: [{ label: 'A' }, { label: 'B' }, { label: 'C' }],
    inputType: 'text' as const,
  }];
}

export function createFakeBackend(_representedProvider: AgentProvider = FAKE_PROVIDER): ServerBackend {
  const pendingPickers = new Map<string, PendingPicker>();
  const pendingPermissions = new Map<string, PendingPermission>();
  // Canned output per background task id, populated by the `taskdone:` scenario
  // so `readTaskOutput` can answer the same way claude's would (without a real
  // remote output_file). Cleared on dispose.
  const taskOutputs = new Map<string, string>();
  let abortController: AbortController | null = null;
  // Most-recent turn's send — reused to emit out-of-turn task_events (the
  // 'stopped' echo from stopTask), mirroring how the claude backend routes
  // task_notifications through its persistent session. See background-tasks#2.
  let lastSend: SendFn | null = null;
  // Live device-flow login send (see startLogin/cancelLogin + the `login_ok` step).
  let fakeLoginSend: SendFn | null = null;
  let fakeLoginTimer: ReturnType<typeof setTimeout> | null = null;
  // Armed only after the deterministic login-success hook completes, so the
  // initial capabilities probe remains healthy and exactly one re-probe fails.
  let failNextPostLoginCapabilities = false;
  // The auth_required scenario makes the next successful auth probe visibly
  // different, allowing E2E to prove main published the fresh capabilities.
  let reportAuthenticatedCapabilities = false;
  // Test hook: the `reloadfail` scenario arms this so the NEXT reloadSkills
  // reports a failure (exercises the agent-view error line). Consumed once.
  let failNextReload = false;
  // Test hook: the `credit` step arms this so the NEXT post-turn
  // refreshAccountStatus emits an account-credit status (turnId-less), mirroring
  // how copilot fetches premium-request credit at turn end. Consumed once.
  let emitCreditNext = false;

  async function runStep(
    step: string,
    send: SendFn,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;

    // reloadfail — arm the next reloadSkills to fail; echo a reply so the e2e can
    // await the turn before triggering a skill change.
    if (step === 'reloadfail') {
      failNextReload = true;
      send({ type: 'message', msgId: mintId('m'), msgType: 'reply', content: 'reload armed to fail' });
      return;
    }

    // text:<msg> — streaming chunks + finalize (renderer-side: reply)
    if (step.startsWith('text:')) {
      const content = step.slice('text:'.length);
      const msgId = mintId('m');
      // Emit two stream chunks then finalize, exercising upsert pairing.
      const mid = Math.ceil(content.length / 2);
      send({ type: 'stream', msgId, streamType: 'text', content: content.slice(0, mid) });
      send({ type: 'stream', msgId, streamType: 'text', content: content.slice(mid) });
      send({ type: 'message', msgId, msgType: 'reply', content });
      return;
    }

    // chunk:<msg> — stream text chunks under a FRESH msgId with NO finalize
    // message, mirroring copilot ACP boundary-split segments (chunk-only, they
    // settle only at turn-end idle — no per-segment finalize). Lets an E2E assert
    // the single-caret invariant: chaining `chunk:A|tool:x|chunk:B` must leave the
    // caret on ONLY the live segment, not every prior one. See agent-providers#27.
    if (step.startsWith('chunk:')) {
      const content = step.slice('chunk:'.length);
      const msgId = mintId('m');
      const mid = Math.ceil(content.length / 2);
      send({ type: 'stream', msgId, streamType: 'text', content: content.slice(0, mid) });
      send({ type: 'stream', msgId, streamType: 'text', content: content.slice(mid) });
      return;
    }

    if (step.startsWith('thinking:')) {
      const content = step.slice('thinking:'.length);
      const msgId = mintId('m');
      send({
        type: 'message', msgId, msgType: 'fold_text',
        label: 'Thinking',
        body: { content, tone: 'muted' },
      });
      return;
    }

    if (step.startsWith('tool:') || step.startsWith('tool_err:')) {
      const isErr = step.startsWith('tool_err:');
      const toolName = step.slice((isErr ? 'tool_err:' : 'tool:').length);
      const toolUseId = mintId('t');
      send({
        type: 'message',
        msgId: toolUseId,
        msgType: 'fold_code',
        label: toolName,
        subtitle: '{}',
        body: { content: isErr ? `${toolName} failed` : `${toolName} ok` },
        ...(isErr ? { errorMessage: 'Tool returned an error' } : {}),
      });
      return;
    }

    // subagent:<label> — a Task/Agent subagent. The outer tool_use is a top-level
    // card; the subagent's inner activity carries parentToolUseId so the renderer
    // nests it UNDER that card. NO task_event is emitted (a real subagent is
    // dropped from the panel by routeTask before the wire). See subagent-display.
    if (step.startsWith('subagent:')) {
      const label = step.slice('subagent:'.length) || 'research';
      const outerId = mintId('t');
      // Outer Agent/Task tool_use — pending card in the message list.
      send({ type: 'message', msgId: outerId, msgType: 'fold_code', label: 'Task', subtitle: label });
      // Inner subagent step: a nested tool_use card.
      send({
        type: 'message', msgId: mintId('t'), msgType: 'fold_code',
        label: 'Read', subtitle: 'inner.ts',
        body: { content: 'inner read ok' },
        parentToolUseId: outerId,
      });
      // Inner subagent step: nested prose.
      send({ type: 'message', msgId: mintId('m'), msgType: 'reply', content: `subagent step: ${label}`, parentToolUseId: outerId });
      // Outer tool_result — completes the Agent card (same msgId upsert, top-level).
      send({
        type: 'message', msgId: outerId, msgType: 'fold_code',
        label: 'Task', subtitle: label,
        body: { content: `subagent done: ${label}` },
      });
      return;
    }

    if (step.startsWith('permission:')) {
      const toolName = step.slice('permission:'.length);
      const toolUseId = mintId('t');
      send({ type: 'permission_request', toolUseId, toolName, input: {} });
      const { allow, message } = await new Promise<{ allow: boolean; message?: string }>((resolve) => {
        pendingPermissions.set(toolUseId, {
          resolve: (allow, message) => resolve({ allow, message }),
        });
        signal.addEventListener('abort', () => resolve({ allow: false, message: 'turn aborted' }), { once: true });
      });
      pendingPermissions.delete(toolUseId);
      send({
        type: 'message',
        msgId: mintId('m'),
        msgType: 'system',
        content: allow
          ? `permission allowed: ${toolName}`
          : `permission denied: ${toolName}${message ? ` (${message})` : ''}`,
      });
      return;
    }

    // webfetch:<url> — call the real web.fetch app-tool op so the downstream
    // per-origin gate (main handleAppTool → web-permission popup) is exercised
    // E2E. The actual network fetch will fail in tests (unreachable host); we're
    // testing the gate, so the result is just echoed.
    if (step.startsWith('webfetch:')) {
      const url = step.slice('webfetch:'.length);
      const res = await callMain('web.fetch', { url, method: 'GET' });
      send({ type: 'message', msgId: mintId('m'), msgType: 'reply', content: `webfetch ${JSON.stringify(res)}` });
      return;
    }

    // browser_open:<url> — call the real web.open app-tool op so the per-call
    // Open/Deny popup (main handleAppTool → browser-open) and the open-Web-tab
    // path are exercised E2E. Echo the result for the spec to assert.
    if (step.startsWith('browser_open:')) {
      // `browser_open:<url>` or `browser_open:<url> <reason>` (optional reason,
      // space-separated — `|` can't be used, it's the chain separator). URLs
      // carry no spaces, so the first space cleanly delimits the reason.
      const rest = step.slice('browser_open:'.length);
      const sp = rest.indexOf(' ');
      const url = sp === -1 ? rest : rest.slice(0, sp);
      const reason = sp === -1 ? undefined : rest.slice(sp + 1);
      const res = await callMain('web.open', { url, reason });
      send({ type: 'message', msgId: mintId('m'), msgType: 'reply', content: `browser_open ${JSON.stringify(res)}` });
      return;
    }

    // worktree_create:<branch> [<note>] — opens the real New Worktree dialog
    // through the bridge without creating anything. The optional note path has
    // no spaces, matching feature-note filenames.
    if (step.startsWith('worktree_create:')) {
      const [branch, note] = step.slice('worktree_create:'.length).trim().split(/\s+/, 2);
      const res = await callMain('worktree.propose_create', { branch, note });
      send({ type: 'message', msgId: mintId('m'), msgType: 'reply', content: `worktree_create ${JSON.stringify(res)}` });
      return;
    }

    // worktree_finish — opens the real Finish gate only for the caller's
    // worktree. Main rejects the base project with an explanatory tool result.
    if (step === 'worktree_finish') {
      const res = await callMain('worktree.propose_finish', {});
      send({ type: 'message', msgId: mintId('m'), msgType: 'reply', content: `worktree_finish ${JSON.stringify(res)}` });
      return;
    }

    if (step === 'picker_single' || step === 'picker_combo' || step === 'picker_multi' || step === 'picker_input' || step === 'picker_number') {
      const id = mintId('p');
      const prompts =
        step === 'picker_single' ? pickerSinglePrompts() :
        step === 'picker_combo'  ? pickerComboPrompts() :
        step === 'picker_multi'  ? pickerMultiPrompts() :
        step === 'picker_input'  ? [{ question: 'Type something', multiSelect: false, options: [], inputType: 'text' as const }] :
        /* picker_number */         [{ question: 'Type a number', multiSelect: false, options: [], inputType: 'integer' as const }];
      send({ type: 'picker_request', id, prompts });
      const payload = await new Promise<PickerResolvePayload>((resolve) => {
        pendingPickers.set(id, { resolve });
        // Wire abort: stop() → resolve as cancelled so awaiting promise
        // doesn't strand the turn (otherwise the finally cleanup never
        // runs because we're stuck on this await).
        signal.addEventListener('abort', () => resolve({ cancelled: true }), { once: true });
      });
      pendingPickers.delete(id);
      // Echo result so spec can assert the renderer→provider IPC round-trip.
      const echo = 'cancelled' in payload
        ? 'picker_answers:cancelled'
        : `picker_answers:${JSON.stringify(payload.answers)}`;
      send({ type: 'message', msgId: mintId('m'), msgType: 'reply', content: echo });
      return;
    }

    // task:<id> — a running background task (turnId-less task_event lane).
    if (step.startsWith('task:')) {
      const id = step.slice('task:'.length);
      send({
        type: 'task_event',
        kind: 'started',
        task: { id, type: 'shell', label: `bg ${id}`, status: 'running', done: false },
      });
      return;
    }

    // taskdone:<id> — completed background task + stash its output for read.
    if (step.startsWith('taskdone:')) {
      const id = step.slice('taskdone:'.length);
      taskOutputs.set(id, `output of ${id}\nexit code 0`);
      send({
        type: 'task_event',
        kind: 'done',
        task: { id, type: 'shell', label: `bg ${id}`, status: 'completed', summary: `bg ${id} completed (exit 0)`, done: true },
      });
      return;
    }

    // taskfail:<id> — a failed background task (terminal, carries an error). Used
    // to assert that a failed card is NOT auto-dismissed (the user must see it).
    if (step.startsWith('taskfail:')) {
      const id = step.slice('taskfail:'.length);
      send({
        type: 'task_event',
        kind: 'done',
        task: { id, type: 'shell', label: `bg ${id}`, status: 'failed', summary: `bg ${id} failed (exit 1)`, done: true, error: 'exit 1' },
      });
      return;
    }

    // usage — emit a MID-TURN `state:'streaming'` status carrying usage/quota
    // (contextUsage + rateLimits), the way copilot piggybacks quotaSnapshots on
    // assistant.usage / session.usage_info. Lets an E2E assert the status bar
    // surfaces mid-turn quota — and guards the regression where main dropped
    // streaming-status metrics (only terminal idle must be stripped). See agent-core#10.
    if (step === 'usage') {
      send({
        type: 'status',
        state: 'streaming',
        contextUsage: { text: 'ctx: 42%', severity: 'normal' },
        rateLimits: [{ text: 'quota: 7%', severity: 'normal' }],
      });
      return;
    }

    // plan:<markdown> — emit a plan / todo-list side-channel update. Routed to
    // PlanPanel (tab.currentPlan), NOT the timeline and NOT the background-tasks
    // panel — lets an E2E assert the plan/todo surface renders independently of
    // background tasks. See agent-ui#5 (plan side-channel) / #69.
    if (step.startsWith('plan:')) {
      send({ type: 'plan', content: step.slice('plan:'.length) });
      return;
    }

    // apptool:<op> — exercise the app-tool bridge end-to-end: call main via
    // callMain(op) and render the result as a reply so an E2E can assert the
    // round-trip (agent-server → main handler → skills-store → reply).
    // `apptool:<op>` or `apptool:<op>:<jsonArgs>` — op names are `resource.verb`
    // (a dot, never a colon), so the FIRST colon after the op cleanly separates
    // optional JSON args. Args let an E2E drive ops that need input (e.g. a
    // worktree branch) without a dedicated per-op scenario.
    if (step.startsWith('apptool:')) {
      const rest = step.slice('apptool:'.length);
      const colonIdx = rest.indexOf(':');
      const op = colonIdx >= 0 ? rest.slice(0, colonIdx) : rest;
      let args: Record<string, unknown> = {};
      if (colonIdx >= 0) {
        const argStr = rest.slice(colonIdx + 1);
        try {
          args = JSON.parse(argStr) as Record<string, unknown>;
        } catch {
          send({ type: 'message', msgId: mintId('m'), msgType: 'reply', content: `apptool ${op} bad-args ${argStr}` });
          return;
        }
      }
      const res = await callMain(op, args);
      send({ type: 'message', msgId: mintId('m'), msgType: 'reply', content: `apptool ${op} ${JSON.stringify(res)}` });
      return;
    }

    // serverturn:<msg> — a server-initiated turn (auto-resume prose after a
    // background task finishes). Opens a fresh turnId via turn_started, emits
    // the prose tagged with it, then closes with that turn's idle. The renderer
    // still displays one linear timeline; turnId is lifecycle routing only.
    if (step.startsWith('serverturn:')) {
      const content = step.slice('serverturn:'.length);
      const turnId = mintId('t');
      send({ type: 'turn_started', turnId });
      send({ type: 'status', state: 'streaming', turnId });
      send({ type: 'message', msgId: mintId('m'), msgType: 'reply', content, turnId });
      send({ type: 'status', state: 'idle', turnId });
      return;
    }

    // env:<NAME> — echo the exec process's env var as a plain reply, so an E2E
    // can prove project-env injection reached the agent-server (the exec proc
    // inherits the injected map). Normal wire shape (reply), not a test-only event.
    if (step.startsWith('env:')) {
      const name = step.slice('env:'.length);
      send({ type: 'message', msgId: mintId('m'), msgType: 'reply', content: `env ${name}=${process.env[name] ?? ''}` });
      return;
    }

    // credit — arm the post-turn account-status refresh. The credit segment is
    // NOT emitted inline (it's account-level, turnId-less); refreshAccountStatus
    // fires it after the turn closes, exercising the real delivery path
    // (post-turn fire → session sink → status bar). See agent-providers#26.
    if (step === 'credit') {
      emitCreditNext = true;
      send({ type: 'message', msgId: mintId('m'), msgType: 'reply', content: 'credit armed' });
      return;
    }

    if (step === 'auth_required') {
      reportAuthenticatedCapabilities = true;
      send({ type: 'auth_required', provider: FAKE_AUTH_DISPLAY_NAME });
      return;
    }

    if (step.startsWith('error:')) {
      send({ type: 'error', error: step.slice('error:'.length) });
      return;
    }

    if (step.startsWith('delay:')) {
      const ms = Number(step.slice('delay:'.length));
      if (Number.isFinite(ms) && ms > 0) await sleep(ms, signal);
      return;
    }

    // Unknown — echo as plain reply so the user sees something during dev.
    send({
      type: 'message',
      msgId: mintId('m'),
      msgType: 'reply',
      content: `fake-echo: ${step}`,
    });
  }

  return {
    async query(input: QueryInput, send: SendFn): Promise<void> {
      abortController = new AbortController();
      const signal = abortController.signal;
      lastSend = send;

      // Config-edit turn: mirror the real providers — emit a `system` divider
      // and close the turn. No scenario chain runs (prompt is empty).
      if (input.configEdit) {
        const { key, value } = input.configEdit;
        send({ type: 'status', state: 'streaming' });
        send({ type: 'message', msgId: mintId('m'), msgType: 'system', content: formatConfigAck(key, value) });
        send({ type: 'status', state: 'idle' });
        return;
      }

      // /mcp /skills: mirror the real providers — provider-intercepted read-only
      // listing composed as canned markdown (each provider owns its own card;
      // no cross-provider result type). Emitted as a plain `reply`.
      const slash = parseSlashPrefix(input.prompt);
      if (slash && (slash.cmd === 'mcp' || slash.cmd === 'skills')) {
        send({ type: 'status', state: 'streaming' });
        const content = slash.cmd === 'mcp'
          ? `2 MCP servers:\n\n${mdTable(['Server', 'Status'], [
              ['`fake-fs`', 'connected'],
              ['`fake-db`', 'failed (down)'],
            ])}`
          : `1 skill:\n\n${mdTable(['Skill', 'Source', 'Description'], [
              ['`fake-skill`', 'app', 'a fake skill'],
            ])}`;
        send({ type: 'message', msgId: mintId('m'), msgType: 'reply', content });
        send({ type: 'status', state: 'idle' });
        return;
      }

      send({ type: 'status', state: 'streaming', sessionId: input.sessionId });

      try {
        for (const step of parseChain(input.prompt)) {
          if (signal.aborted) break;
          await runStep(step, send, signal);
        }
      } catch (err: any) {
        if (err?.message !== 'aborted') {
          send({ type: 'error', error: err?.message ?? String(err) });
        }
      } finally {
        // Resolve any dangling pickers/permissions as cancelled so awaiting
        // promises don't leak across turn boundaries.
        for (const [, p] of pendingPickers) p.resolve({ cancelled: true });
        pendingPickers.clear();
        for (const [, p] of pendingPermissions) p.resolve(false, 'turn aborted');
        pendingPermissions.clear();
        send({ type: 'status', state: 'idle' });
        abortController = null;
      }
    },

    async refreshAccountStatus(_cache, send): Promise<void> {
      // Mirror copilot: emit an account-level credit segment (turnId-less) after
      // a turn, only when the `credit` step armed it. Consumed once.
      if (!emitCreditNext) return;
      emitCreditNext = false;
      send({ type: 'status', credits: { text: 'premium: 3/10 (30%)', severity: 'normal' } });
    },

    async stop(): Promise<void> {
      abortController?.abort();
    },

    dispose(): void {
      abortController?.abort();
      if (fakeLoginTimer) clearTimeout(fakeLoginTimer);
      fakeLoginTimer = null;
      fakeLoginSend = null;
      pendingPickers.clear();
      pendingPermissions.clear();
      taskOutputs.clear();
    },

    async reloadSkills() {
      // Mirror the real providers: no-op (reloaded:false) until a turn has run
      // (lastSend captured = a "live session"), then report a re-scan so the
      // agent-server emits a `skills_reloaded` line. The `reloadfail` scenario
      // forces an ok:false outcome to exercise the error line. Drives the e2e.
      if (!lastSend) return { reloaded: false, ok: true };
      if (failNextReload) {
        failNextReload = false;
        return { reloaded: true, ok: false, error: 'fake reload failure' };
      }
      return { reloaded: true, ok: true };
    },

    async gatherCapabilities(): Promise<ProviderCapabilities> {
      // Test hook: a spec launches with SHELF_TEST_CAPS_FAIL=1 to drive the
      // init-failed path — the caps RPC throws → agent-server replies with an
      // `error` payload → remote.ts rejects → startSession marks init 'failed'.
      // Lets an E2E assert the init-readiness gate (locked input, no send, Retry
      // pane) deterministically. Scoped to that spec's own app instance, so it
      // never affects other SHELF_TEST_MODE specs.
      if (process.env[FAKE_TEST_ENV.CAPS_FAIL] === '1') {
        throw new Error('fake init failure (SHELF_TEST_CAPS_FAIL)');
      }
      if (failNextPostLoginCapabilities) {
        failNextPostLoginCapabilities = false;
        throw new Error('fake post-login capabilities failure (SHELF_TEST_POST_LOGIN_CAPS_FAIL)');
      }
      // Test hook: SHELF_TEST_CAPS_DELAY=<ms> holds init in 'starting' long
      // enough for an E2E to observe the not-ready overlay before it clears to
      // 'ready'. Same scoping as CAPS_FAIL (that spec's own app instance).
      const capsDelay = Number(process.env[FAKE_TEST_ENV.CAPS_DELAY]);
      if (Number.isFinite(capsDelay) && capsDelay > 0) await sleep(capsDelay);
      return {
        models: reportAuthenticatedCapabilities
          ? [{ value: 'fake-model-after-auth', displayName: 'fake-model-after-auth' }]
          : [{ value: 'fake-model', displayName: 'fake-model' }],
        permissionModes: [{ value: 'default', displayName: 'ask' }],
        effortLevels: [],
        // Enough entries to OVERFLOW the slash-menu fold (max-height scroll) so
        // e2e can exercise render-all + scroll-into-view. mcp/skills stay first
        // for the dispatch tests; the rest are inert autocomplete-only fillers.
        slashCommands: [
          { name: 'mcp', description: 'List loaded MCP servers' },
          { name: 'skills', description: 'List loaded skills' },
          { name: 'alpha', description: 'Filler command alpha' },
          { name: 'bravo', description: 'Filler command bravo' },
          { name: 'charlie', description: 'Filler command charlie' },
          { name: 'delta', description: 'Filler command delta' },
          { name: 'echo', description: 'Filler command echo' },
          { name: 'foxtrot', description: 'Filler command foxtrot' },
          { name: 'golf', description: 'Filler command golf' },
          { name: 'hotel', description: 'Filler command hotel' },
          { name: 'india', description: 'Filler command india' },
          { name: 'juliet', description: 'Filler command juliet' },
          { name: 'kilo', description: 'Filler command kilo' },
          { name: 'lima', description: 'Filler command lima' },
          { name: 'zulu', description: 'Filler command zulu (last)' },
        ],
        // Declare an oauth method so the AuthPane shows the interactive "Login
        // with GitHub" button (device-flow) when auth_required fires. See
        // features copilot-device-login.
        authMethod: { kind: 'oauth', instructions: [{ command: 'fake login', label: 'fake device flow' }] },
      };
    },

    // Interactive device-flow login (deterministic fake for E2E). startLogin
    // emits a verification prompt immediately. By default it stays pending until
    // cancelLogin resolves it as cancelled. The opt-in success hook completes on
    // a short timer so E2E can exercise the real post-login re-probe lifecycle.
    startLogin(_cwd, send) {
      fakeLoginSend = send;
      send({
        type: 'auth_login_prompt',
        provider: FAKE_AUTH_DISPLAY_NAME,
        verificationUri: 'https://github.com/login/device',
        userCode: 'FAKE-CODE',
        prefilledUri: 'https://github.com/login/device?user_code=FAKE-CODE',
      });
      if (process.env[FAKE_TEST_ENV.LOGIN_SUCCESS] === '1') {
        fakeLoginTimer = setTimeout(() => {
          fakeLoginTimer = null;
          if (!fakeLoginSend) return;
          failNextPostLoginCapabilities = process.env[FAKE_TEST_ENV.POST_LOGIN_CAPS_FAIL] === '1';
          fakeLoginSend({ type: 'auth_login_done', provider: FAKE_AUTH_DISPLAY_NAME, ok: true });
          fakeLoginSend = null;
        }, 25);
      }
    },

    cancelLogin() {
      if (fakeLoginTimer) clearTimeout(fakeLoginTimer);
      fakeLoginTimer = null;
      fakeLoginSend?.({ type: 'auth_login_done', provider: FAKE_AUTH_DISPLAY_NAME, ok: false, cancelled: true });
      fakeLoginSend = null;
    },

    resolvePermission(toolUseId, allow, message) {
      const p = pendingPermissions.get(toolUseId);
      if (p) p.resolve(allow, message);
    },

    resolvePicker(id, payload) {
      const p = pendingPickers.get(id);
      if (p) p.resolve(payload);
    },

    async readTaskOutput(taskId: string): Promise<string> {
      const out = taskOutputs.get(taskId);
      if (out === undefined) throw new Error(`No output for task ${taskId}`);
      return out;
    },

    // Mirror claude: stopping a task emits a terminal 'stopped' task_event on the
    // turnId-less lane (here via the last turn's send), which the panel waits for
    // before removing the card. No-op if no turn has run yet.
    async stopTask(taskId: string): Promise<void> {
      lastSend?.({
        type: 'task_event',
        kind: 'done',
        task: { id: taskId, type: 'shell', label: `bg ${taskId}`, status: 'stopped', summary: `bg ${taskId} stopped`, done: true },
      });
    },
  };
}
