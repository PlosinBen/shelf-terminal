import { randomUUID } from 'node:crypto';
import { formatConfigAck } from '@shared/config-ack';
import type {
  OutgoingMessage,
  PickerResolvePayload,
  ProviderCapabilities,
  QueryInput,
  SendFn,
  ServerBackend,
} from '../types';

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
 *   thinking:<msg>      thinking message
 *   tool:<name>         tool_use + tool_result success
 *   tool_err:<name>     tool_use + tool_result error
 *   permission:<tool>   permission_request, await resolve, follow-up system msg
 *   picker_single       1-prompt single-select picker (3 options)
 *   picker_combo        1-prompt picker with options AND free-text (real
 *                       AskUserQuestion shape: options + inputType together)
 *   picker_multi        3-prompt picker (single, multi+desc, free-text)
 *   picker_input        free-text only (options=[], inputType=text)
 *   picker_number       free-text only (options=[], inputType=integer)
 *   auth_required       emit auth_required
 *   error:<msg>         emit error
 *   delay:<ms>          sleep before next step
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

export function createFakeBackend(): ServerBackend {
  const pendingPickers = new Map<string, PendingPicker>();
  const pendingPermissions = new Map<string, PendingPermission>();
  let abortController: AbortController | null = null;

  async function runStep(
    step: string,
    send: SendFn,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return;

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

    if (step === 'auth_required') {
      send({ type: 'auth_required', provider: 'fake' });
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

      // Config-edit turn: mirror the real providers — emit a `system` divider
      // and close the turn. No scenario chain runs (prompt is empty).
      if (input.configEdit) {
        const { key, value } = input.configEdit;
        send({ type: 'status', state: 'streaming' });
        send({ type: 'message', msgId: mintId('m'), msgType: 'system', content: formatConfigAck(key, value) });
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

    async stop(): Promise<void> {
      abortController?.abort();
    },

    dispose(): void {
      abortController?.abort();
      pendingPickers.clear();
      pendingPermissions.clear();
    },

    async gatherCapabilities(): Promise<ProviderCapabilities> {
      return {
        models: [{ value: 'fake-model', displayName: 'fake-model' }],
        permissionModes: [{ value: 'default', displayName: 'ask' }],
        effortLevels: [],
        slashCommands: [],
      };
    },

    resolvePermission(toolUseId, allow, message) {
      const p = pendingPermissions.get(toolUseId);
      if (p) p.resolve(allow, message);
    },

    resolvePicker(id, payload) {
      const p = pendingPickers.get(id);
      if (p) p.resolve(payload);
    },
  };
}
