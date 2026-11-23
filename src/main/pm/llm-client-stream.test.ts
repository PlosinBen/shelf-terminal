import { afterEach, describe, expect, it, vi } from 'vitest';
import { streamChat, type StreamEvent } from './llm-client';
import type { PmProviderConfig } from '@shared/types';

afterEach(() => vi.unstubAllGlobals());

const config: PmProviderConfig = { provider: 'ollama', apiKey: '', model: 'fixture', baseURL: 'http://localhost:12345/v1' };
const schema = { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] };
const tools = [{ type: 'function' as const, function: { name: 'inspect', description: 'Inspect value', parameters: schema } }];
const messages = [{ role: 'user' as const, content: 'Inspect' }];
const chunk = (delta: unknown, finish_reason: string | null = null) =>
  `data: ${JSON.stringify({ id: 'fixture', object: 'chat.completion.chunk', created: 1, model: 'fixture', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const response = (body = chunk({ content: 'Hello' }) + chunk({}, 'stop')) =>
  new Response(body + 'data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
async function collect(signal?: AbortSignal) {
  const events: StreamEvent[] = [];
  for await (const event of streamChat(config, messages, tools, signal)) events.push(event);
  return events;
}

describe('PM real SDK request and stream contract', () => {
  it.each(['openai', 'gemini', 'ollama'] as const)('uses chat completions and preserves tool schema for %s', async provider => {
    const fetch = vi.fn().mockResolvedValue(response());
    vi.stubGlobal('fetch', fetch);
    const events = [];
    for await (const event of streamChat({ ...config, provider }, messages, tools)) events.push(event);
    const [url, init] = fetch.mock.calls[0];
    const body = JSON.parse(init.body);
    expect(String(url)).toBe(config.baseURL + '/chat/completions');
    expect(body.tools[0].function.parameters).toMatchObject(schema);
    expect(events).toEqual([{ type: 'text', text: 'Hello' }, { type: 'done' }]);
  });

  it('preserves required tool parameters on the wire independently of endpoint selection', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'fixture' } }), { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    await collect().catch(() => {});
    const tool = JSON.parse(fetch.mock.calls[0][1].body).tools[0];
    expect((tool.function ?? tool).parameters).toMatchObject(schema);
  });

  it('throws HTTP errors with their status and never yields a successful done', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ error: { message: 'fixture rejection' } }), { status: 400 })));
    await expect(collect()).rejects.toThrow(/400.*fixture rejection/);
  });

  it('rejects cancellation before sending a request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const controller = new AbortController();
    controller.abort();
    await expect(collect(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('propagates an error after partial text without emitting done', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(chunk({ content: 'Partial' }) +
      'data: {"error":{"message":"stream failed","type":"server_error","code":"failed"}}\n\n')));
    const events: StreamEvent[] = [];
    await expect((async () => {
      for await (const event of streamChat(config, messages, tools)) events.push(event);
    })()).rejects.toThrow('stream failed');
    expect(events).toEqual([{ type: 'text', text: 'Partial' }]);
  });

  it('aborts during streaming without emitting done or a tool call', async () => {
    const controller = new AbortController();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(stream) { stream.enqueue(new TextEncoder().encode(chunk({ content: 'Partial' }))); },
    }), { headers: { 'content-type': 'text/event-stream' } })));
    const events: StreamEvent[] = [];
    await expect((async () => {
      for await (const event of streamChat(config, messages, tools, controller.signal)) {
        events.push(event);
        controller.abort();
      }
    })()).rejects.toMatchObject({ name: 'AbortError' });
    expect(events).toEqual([{ type: 'text', text: 'Partial' }]);
  });

  it('does not perform hidden SDK retries for an HTTP 503', async () => {
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ error: { message: 'busy' } }), { status: 503 })));
    vi.stubGlobal('fetch', fetch);
    await expect(collect()).rejects.toThrow(/503.*busy/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed tool arguments before handing a tool to the executor', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response(chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'inspect', arguments: 'invalid-json' } }] }) + chunk({}, 'tool_calls'))));
    await expect(collect()).rejects.toThrow();
  });

  it('forwards complete tool arguments and paired tool history', async () => {
    const fetch = vi.fn().mockResolvedValue(response(chunk({ tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'inspect', arguments: '{"value":"ok"}' } }] }) + chunk({}, 'tool_calls')));
    vi.stubGlobal('fetch', fetch);
    expect(await collect()).toEqual([
      { type: 'tool_call_start', toolCallId: 'c1', toolName: 'inspect' },
      { type: 'tool_call_args', toolCallId: 'c1', argsChunk: '{"value":"ok"}' },
      { type: 'done' },
    ]);
    fetch.mockResolvedValue(response());
    for await (const _ of streamChat(config, [
      { role: 'system', content: 'You are PM' }, ...messages,
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'inspect', arguments: '{"value":"ok"}' } }] },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
    ], tools)) { /* consume real SDK stream */ }
    const body = JSON.parse(fetch.mock.calls[1][1].body);
    expect(body.messages).toEqual([
      { role: 'system', content: 'You are PM' }, ...messages,
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'inspect', arguments: '{"value":"ok"}' } }] },
      { role: 'tool', content: 'result', tool_call_id: 'c1' },
    ]);
  });
});
