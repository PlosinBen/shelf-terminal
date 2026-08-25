import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ExternalUrlIntentGate } from './external-url-intent-gate';
import type { ExternalUrlIntentInput, ExternalUrlIntentRequest } from '@shared/external-url-intent';

const FIRST: ExternalUrlIntentInput = {
  url: 'https://login.example.com/oauth?state=private-first',
  reason: 'Sign in',
  source: { kind: 'project-tab', projectId: 'project-a', tabId: 'agent-a' },
};
const SECOND: ExternalUrlIntentInput = {
  url: 'mailto:support@example.com?subject=private-second',
  reason: 'Contact support',
  source: { kind: 'app-window' },
};

describe('ExternalUrlIntentGate', () => {
  const requests: ExternalUrlIntentRequest[] = [];
  const closed: string[] = [];
  const copied: string[] = [];
  const opened: string[] = [];
  const errors: string[] = [];
  let hasWindow = true;

  function createGate() {
    return new ExternalUrlIntentGate({
      hasWindow: () => hasWindow,
      sendRequest: (request) => requests.push(request),
      sendClose: (requestId) => closed.push(requestId),
      copyUrl: (url) => { copied.push(url); },
      openUrl: async (url) => { opened.push(url); },
      logError: (message) => errors.push(message),
    });
  }

  beforeEach(() => {
    requests.length = 0;
    closed.length = 0;
    copied.length = 0;
    opened.length = 0;
    errors.length = 0;
    hasWindow = true;
  });

  it('delivers one request at a time and retains each exact source', async () => {
    const gate = createGate();
    const first = gate.request(FIRST);
    const second = gate.request(SECOND);

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ url: FIRST.url, source: FIRST.source });

    await gate.resolve(requests[0].requestId, 'cancel');
    await expect(first).resolves.toBe('cancel');

    expect(requests).toHaveLength(2);
    expect(requests[1]).toMatchObject({ url: SECOND.url, source: SECOND.source });
    await gate.resolve(requests[1].requestId, 'cancel');
    await expect(second).resolves.toBe('cancel');
  });

  it('copies the exact URL only after the copy decision', async () => {
    const gate = createGate();
    const result = gate.request(FIRST);

    await gate.resolve(requests[0].requestId, 'copy');

    await expect(result).resolves.toBe('copy');
    expect(copied).toEqual([FIRST.url]);
    expect(opened).toEqual([]);
    expect(closed).toEqual([requests[0].requestId]);
  });

  it('opens the exact URL only after the open decision', async () => {
    const gate = createGate();
    const result = gate.request(FIRST);

    await gate.resolve(requests[0].requestId, 'open');

    await expect(result).resolves.toBe('open');
    expect(opened).toEqual([FIRST.url]);
    expect(copied).toEqual([]);
  });

  it('cancels without executing a side effect', async () => {
    const gate = createGate();
    const result = gate.request(FIRST);

    await gate.resolve(requests[0].requestId, 'cancel');

    await expect(result).resolves.toBe('cancel');
    expect(copied).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('fails closed when no renderer window can receive the request', async () => {
    hasWindow = false;
    const gate = createGate();

    await expect(gate.request(FIRST)).resolves.toBe('cancel');
    expect(requests).toEqual([]);
    expect(errors.join('\n')).not.toContain('private-first');
    expect(errors.join('\n')).toContain('https://login.example.com');
  });

  it('times out the active request, closes it, and advances the queue', async () => {
    vi.useFakeTimers();
    try {
      const gate = createGate();
      const first = gate.request(FIRST);
      const second = gate.request(SECOND);
      vi.advanceTimersByTime(5 * 60_000 + 1);

      await expect(first).resolves.toBe('cancel');
      expect(closed).toEqual([requests[0].requestId]);
      expect(requests).toHaveLength(2);
      expect(errors.join('\n')).not.toContain('private-first');

      await gate.resolve(requests[1].requestId, 'cancel');
      await second;
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects malformed input without logging the full URL', async () => {
    const gate = createGate();
    const input = { ...FIRST, url: 'file:///private/oauth-token' };

    await expect(gate.request(input)).rejects.toThrow('unsupported-scheme');
    expect(requests).toEqual([]);
    expect(errors.join('\n')).not.toContain(input.url);
  });

  it('fails loudly on unknown, duplicate, and invalid decisions', async () => {
    const gate = createGate();
    const result = gate.request(FIRST);
    const requestId = requests[0].requestId;

    await expect(gate.resolve('https://secret.example/oauth?code=private', 'cancel')).rejects.toThrow('does not match');
    expect(errors.join('\n')).not.toContain('secret.example');
    await expect(gate.resolve(requestId, 'always')).rejects.toThrow('Invalid external URL decision');
    await gate.resolve(requestId, 'cancel');
    await result;
    await expect(gate.resolve(requestId, 'cancel')).rejects.toThrow('does not match');
  });

  it('keeps the request active when an action fails so the user can retry or cancel', async () => {
    const gate = new ExternalUrlIntentGate({
      hasWindow: () => true,
      sendRequest: (request) => requests.push(request),
      sendClose: (requestId) => closed.push(requestId),
      copyUrl: () => { throw new Error('clipboard unavailable'); },
      openUrl: async () => {},
      logError: (message) => errors.push(message),
    });
    const result = gate.request(FIRST);
    const requestId = requests[0].requestId;

    await expect(gate.resolve(requestId, 'copy')).rejects.toThrow('clipboard unavailable');
    expect(closed).toEqual([]);
    expect(errors.join('\n')).not.toContain('private-first');

    await gate.resolve(requestId, 'cancel');
    await expect(result).resolves.toBe('cancel');
  });
});
