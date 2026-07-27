import { Codex, type CodexOptions, type Input, type ThreadEvent, type ThreadOptions } from '@openai/codex-sdk';

export const CODEX_SDK_PROBE_MAX_TIMEOUT_MS = 120_000;

export type CodexSdkProbeOutcome =
  | 'completed'
  | 'turn_failed'
  | 'stream_error'
  | 'non_zero'
  | 'parse_error'
  | 'timeout';

export interface CodexSdkProbeRequest {
  codexPathOverride: string;
  codexHome: string;
  workingDirectory: string;
  input: Input;
  timeoutMs: number;
  threadId?: string;
  threadOptions?: ThreadOptions;
  config?: CodexOptions['config'];
  env?: Record<string, string>;
  redactValues?: string[];
  includeRedactedEventJson?: boolean;
}

export interface CodexSdkProbeEventSummary {
  type: string;
  itemType?: string;
  itemId?: string;
  itemStatus?: string;
  usageKeys?: string[];
  redactedJson?: string;
}

export interface CodexSdkProbeSummary {
  ok: boolean;
  outcome: CodexSdkProbeOutcome;
  elapsedMs: number;
  inputKind: 'text' | 'structured' | 'image_only';
  eventCount: number;
  events: CodexSdkProbeEventSummary[];
  threadId?: string;
  error?: string;
}

export interface CodexSdkProbeDeps {
  now?: () => number;
  createEventStream?: (
    request: CodexSdkProbeRequest,
    signal: AbortSignal,
  ) => Promise<AsyncIterable<ThreadEvent | unknown>>;
}

export class CodexSdkProbeError extends Error {
  constructor(
    readonly outcome: Extract<CodexSdkProbeOutcome, 'non_zero' | 'parse_error' | 'stream_error'>,
    message: string,
  ) {
    super(message);
    this.name = 'CodexSdkProbeError';
  }
}

export async function runCodexSdkProbe(
  request: CodexSdkProbeRequest,
  deps: CodexSdkProbeDeps = {},
): Promise<CodexSdkProbeSummary> {
  validateProbeRequest(request);

  const now = deps.now ?? Date.now;
  const startedAt = now();
  const controller = new AbortController();
  let timedOut = false;
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const events: CodexSdkProbeEventSummary[] = [];
  let threadId: string | undefined;
  let terminalFailure: { outcome: CodexSdkProbeOutcome; error: string } | undefined;
  let iterator: AsyncIterator<ThreadEvent | unknown> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`Codex SDK probe timed out after ${request.timeoutMs}ms`));
    }, request.timeoutMs);
  });

  try {
    const createEventStream = deps.createEventStream ?? createCodexSdkEventStream;
    iterator = (await createEventStream(request, controller.signal))[Symbol.asyncIterator]();

    while (true) {
      const next = await Promise.race([iterator.next(), timeout]);
      if (next.done) break;

      const event = next.value;
      const summary = summarizeProbeEvent(event, request);
      events.push(summary);

      if (isObjectRecord(event) && event.type === 'thread.started' && typeof event.thread_id === 'string') {
        threadId = event.thread_id;
      }
      if (isObjectRecord(event) && event.type === 'turn.failed') {
        terminalFailure = { outcome: 'turn_failed', error: extractEventError(event) };
      } else if (isObjectRecord(event) && event.type === 'error') {
        terminalFailure = { outcome: 'stream_error', error: extractEventError(event) };
      }
    }

    return buildSummary(request, startedAt, now(), events, threadId, terminalFailure);
  } catch (error) {
    if (timedOut) {
      return buildSummary(request, startedAt, now(), events, threadId, {
        outcome: 'timeout',
        error: `Codex SDK probe timed out after ${request.timeoutMs}ms`,
      });
    }
    const classified = classifyProbeError(error);
    return buildSummary(request, startedAt, now(), events, threadId, classified);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
    if (timedOut && iterator?.return) {
      void iterator.return().catch(() => undefined);
    }
  }
}

function validateProbeRequest(request: CodexSdkProbeRequest): void {
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new RangeError('Codex SDK probe timeoutMs must be a finite positive number.');
  }
  if (request.timeoutMs > CODEX_SDK_PROBE_MAX_TIMEOUT_MS) {
    throw new RangeError(`Codex SDK probe timeoutMs must be <= ${CODEX_SDK_PROBE_MAX_TIMEOUT_MS}.`);
  }
  if (!request.codexPathOverride) throw new Error('Codex SDK probe requires codexPathOverride.');
  if (!request.codexHome) throw new Error('Codex SDK probe requires codexHome.');
  if (!request.workingDirectory) throw new Error('Codex SDK probe requires workingDirectory.');
}

async function createCodexSdkEventStream(
  request: CodexSdkProbeRequest,
  signal: AbortSignal,
): Promise<AsyncIterable<ThreadEvent>> {
  const codex = new Codex({
    codexPathOverride: request.codexPathOverride,
    config: request.config,
    env: {
      ...(request.env ?? {}),
      CODEX_HOME: request.codexHome,
    },
  });
  const threadOptions = {
    ...(request.threadOptions ?? {}),
    workingDirectory: request.workingDirectory,
  };
  const thread = request.threadId
    ? codex.resumeThread(request.threadId, threadOptions)
    : codex.startThread(threadOptions);
  const streamed = await thread.runStreamed(request.input, { signal });
  return streamed.events;
}

function buildSummary(
  request: CodexSdkProbeRequest,
  startedAt: number,
  endedAt: number,
  events: CodexSdkProbeEventSummary[],
  threadId: string | undefined,
  failure: { outcome: CodexSdkProbeOutcome; error: string } | undefined,
): CodexSdkProbeSummary {
  return {
    ok: !failure,
    outcome: failure?.outcome ?? 'completed',
    elapsedMs: Math.max(0, endedAt - startedAt),
    inputKind: summarizeInputKind(request.input),
    eventCount: events.length,
    events,
    threadId,
    error: failure ? redactText(failure.error, request.redactValues ?? []) : undefined,
  };
}

function summarizeInputKind(input: Input): CodexSdkProbeSummary['inputKind'] {
  if (typeof input === 'string') return 'text';
  if (input.length > 0 && input.every((part) => part.type === 'local_image')) return 'image_only';
  return 'structured';
}

function summarizeProbeEvent(event: unknown, request: CodexSdkProbeRequest): CodexSdkProbeEventSummary {
  if (!isObjectRecord(event)) {
    return {
      type: typeof event,
      redactedJson: request.includeRedactedEventJson ? redactJson(event, request.redactValues ?? []) : undefined,
    };
  }

  const item = isObjectRecord(event.item) ? event.item : undefined;
  const summary: CodexSdkProbeEventSummary = {
    type: typeof event.type === 'string' ? event.type : 'unknown',
    itemType: typeof item?.type === 'string' ? item.type : undefined,
    itemId: typeof item?.id === 'string' ? item.id : undefined,
    itemStatus: typeof item?.status === 'string' ? item.status : undefined,
    usageKeys: isObjectRecord(event.usage) ? Object.keys(event.usage).sort() : undefined,
  };
  if (request.includeRedactedEventJson) {
    summary.redactedJson = redactJson(event, request.redactValues ?? []);
  }
  return summary;
}

function classifyProbeError(error: unknown): { outcome: CodexSdkProbeOutcome; error: string } {
  if (error instanceof CodexSdkProbeError) {
    return { outcome: error.outcome, error: error.message };
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/\b(parse|jsonl|json)\b/i.test(message)) return { outcome: 'parse_error', error: message };
  if (/\b(non-zero|status code|exited? with code|code \d+)\b/i.test(message)) {
    return { outcome: 'non_zero', error: message };
  }
  return { outcome: 'stream_error', error: message };
}

function extractEventError(event: Record<string, unknown>): string {
  if (typeof event.message === 'string') return event.message;
  if (isObjectRecord(event.error) && typeof event.error.message === 'string') return event.error.message;
  return redactJson(event, []);
}

function redactJson(value: unknown, secrets: string[]): string {
  return redactText(JSON.stringify(value), secrets);
}

function redactText(text: string, secrets: string[]): string {
  let redacted = text;
  for (const secret of secrets) {
    if (!secret) continue;
    redacted = redacted.split(secret).join('[REDACTED]');
  }
  return redacted;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
