import { describe, expect, it } from 'vitest';
import {
  CODEX_SDK_PROBE_MAX_TIMEOUT_MS,
  CodexSdkProbeError,
  type CodexSdkProbeRequest,
  runCodexSdkProbe,
} from './probe-harness';

const BASE_REQUEST: CodexSdkProbeRequest = {
  codexPathOverride: '/opt/shelf/codex',
  codexHome: '/tmp/shelf-codex-home',
  workingDirectory: '/tmp/workspace',
  input: 'prompt body must not appear in summaries',
  timeoutMs: 1_000,
};

describe('runCodexSdkProbe', () => {
  it('rejects unbounded timeout values', async () => {
    await expect(
      runCodexSdkProbe({
        ...BASE_REQUEST,
        timeoutMs: CODEX_SDK_PROBE_MAX_TIMEOUT_MS + 1,
      }),
    ).rejects.toThrow(/timeoutMs must be <=/);
  });

  it('summarizes streamed events without persisting prompt bodies', async () => {
    const summary = await runCodexSdkProbe(BASE_REQUEST, {
      now: fixedClock(),
      createEventStream: async () =>
        asyncGenerator([
          { type: 'thread.started', thread_id: 'thread-123' },
          { type: 'item.completed', item: { id: 'item-1', type: 'agent_message', text: 'done' } },
          {
            type: 'turn.completed',
            usage: {
              input_tokens: 1,
              cached_input_tokens: 0,
              cache_write_input_tokens: 0,
              output_tokens: 1,
              reasoning_output_tokens: 0,
            },
          },
        ]),
    });

    expect(summary).toMatchObject({
      ok: true,
      outcome: 'completed',
      inputKind: 'text',
      eventCount: 3,
      threadId: 'thread-123',
      events: [
        { type: 'thread.started' },
        { type: 'item.completed', itemType: 'agent_message', itemId: 'item-1' },
        { type: 'turn.completed' },
      ],
    });
    expect(JSON.stringify(summary)).not.toContain('prompt body must not appear');
  });

  it('redacts configured secrets from event and error details', async () => {
    const summary = await runCodexSdkProbe(
      {
        ...BASE_REQUEST,
        redactValues: ['secret-token'],
        includeRedactedEventJson: true,
      },
      {
        now: fixedClock(),
        createEventStream: async () =>
          asyncGenerator([
            {
              type: 'item.completed',
              item: {
                id: 'item-1',
                type: 'mcp_tool_call',
                server: 'private',
                tool: 'fetch',
                status: 'failed',
                error: { message: 'secret-token rejected' },
              },
            },
            { type: 'error', message: 'secret-token in stderr' },
          ]),
      },
    );

    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain('secret-token');
    expect(serialized).toContain('[REDACTED]');
    expect(summary).toMatchObject({
      ok: false,
      outcome: 'stream_error',
      error: '[REDACTED] in stderr',
    });
  });

  it('reports non-zero and parse failures distinctly', async () => {
    const nonZero = await runCodexSdkProbe(BASE_REQUEST, {
      now: fixedClock(),
      createEventStream: async () => {
        throw new CodexSdkProbeError('non_zero', 'child exited with status code 1');
      },
    });
    const parse = await runCodexSdkProbe(BASE_REQUEST, {
      now: fixedClock(),
      createEventStream: async () => {
        throw new CodexSdkProbeError('parse_error', 'invalid JSONL');
      },
    });

    expect(nonZero).toMatchObject({ ok: false, outcome: 'non_zero' });
    expect(parse).toMatchObject({ ok: false, outcome: 'parse_error' });
  });

  it('times out and aborts the active probe', async () => {
    let aborted = false;
    const summary = await runCodexSdkProbe(
      { ...BASE_REQUEST, timeoutMs: 1 },
      {
        now: fixedClock(),
        createEventStream: async (_request, signal) => {
          signal.addEventListener('abort', () => {
            aborted = true;
          });
          return asyncGenerator([new Promise(() => undefined)]);
        },
      },
    );

    expect(summary).toMatchObject({ ok: false, outcome: 'timeout' });
    expect(aborted).toBe(true);
  });

  it('classifies image-only structured input without exposing image paths', async () => {
    const summary = await runCodexSdkProbe(
      {
        ...BASE_REQUEST,
        input: [{ type: 'local_image', path: '/private/screenshot.png' }],
      },
      {
        now: fixedClock(),
        createEventStream: async () => asyncGenerator([{ type: 'turn.completed' }]),
      },
    );

    expect(summary.inputKind).toBe('image_only');
    expect(JSON.stringify(summary)).not.toContain('/private/screenshot.png');
  });
});

function fixedClock(): () => number {
  let value = 1_000;
  return () => value++;
}

async function* asyncGenerator(values: Array<unknown | Promise<unknown>>): AsyncGenerator<unknown> {
  for (const value of values) {
    yield await value;
  }
}
