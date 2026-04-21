import { describe, it, expect, vi } from 'vitest';
import { submitAgentMessage, type SubmitAgentMessagePayload, type SubmitAgentMessageDeps } from './agent-actions';
import type { Connection } from '@shared/types';

function makePayload(overrides: Partial<SubmitAgentMessagePayload> = {}): SubmitAgentMessagePayload {
  const connection: Connection = { type: 'local' } as Connection;
  return {
    tabId: 'tab-1',
    projectId: 'proj-1',
    provider: 'claude',
    cwd: '/home/user/repo',
    connection,
    text: 'hello agent',
    ...overrides,
  };
}

function makeDeps() {
  const addAgentMessage = vi.fn();
  const saveMessage = vi.fn();
  const send = vi.fn();
  const deps: SubmitAgentMessageDeps = {
    addAgentMessage,
    saveMessage,
    send,
    now: () => 1_700_000_000_000,
  };
  return Object.assign(deps, { addAgentMessage, saveMessage, send });
}

describe('submitAgentMessage', () => {
  it('adds to transcript, persists, and sends in one call — covers the queue-flush regression', () => {
    const deps = makeDeps();
    submitAgentMessage(makePayload(), deps);

    // Regression: ALL THREE side effects must fire. Queue flush previously
    // only called send(), which caused the queued user message to vanish
    // from the UI transcript. See GOTCHAS #33.
    expect(deps.addAgentMessage).toHaveBeenCalledTimes(1);
    expect(deps.saveMessage).toHaveBeenCalledTimes(1);
    expect(deps.send).toHaveBeenCalledTimes(1);
  });

  it('adds the rendered message to the correct tab with user role + text', () => {
    const deps = makeDeps();
    submitAgentMessage(makePayload({ text: 'hi there' }), deps);

    const [tabId, msg] = deps.addAgentMessage.mock.calls[0];
    expect(tabId).toBe('tab-1');
    expect(msg.role).toBe('user');
    expect(msg.type).toBe('text');
    expect(msg.content).toBe('hi there');
    expect(msg.id).toBe('msg-1700000000000');
  });

  it('persists with projectId, timestamp, and provider from the payload', () => {
    const deps = makeDeps();
    submitAgentMessage(makePayload({ text: 'persist me', provider: 'copilot' }), deps);

    expect(deps.saveMessage).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'proj-1',
      timestamp: 1_700_000_000_000,
      role: 'user',
      type: 'text',
      content: 'persist me',
      provider: 'copilot',
    }));
  });

  it('forwards attachments with file paths (not displayPaths) to IPC', () => {
    const deps = makeDeps();
    submitAgentMessage(makePayload({
      files: [
        { path: '/abs/a.txt', displayPath: 'a.txt' },
        { path: '/abs/b.txt', displayPath: 'b.txt' },
      ],
      images: ['data:image/png;base64,AAA'],
    }), deps);

    const sendArgs = deps.send.mock.calls[0];
    expect(sendArgs[6]).toEqual({
      files: ['/abs/a.txt', '/abs/b.txt'],
      images: ['data:image/png;base64,AAA'],
    });

    // The in-memory message and the persisted record keep the full
    // {path, displayPath} objects so the UI can show displayPath.
    expect(deps.addAgentMessage.mock.calls[0][1].attachments.files)
      .toEqual([
        { path: '/abs/a.txt', displayPath: 'a.txt' },
        { path: '/abs/b.txt', displayPath: 'b.txt' },
      ]);
  });

  it('omits the attachments field entirely when no files/images', () => {
    const deps = makeDeps();
    submitAgentMessage(makePayload(), deps);

    const msg = deps.addAgentMessage.mock.calls[0][1];
    const saved = deps.saveMessage.mock.calls[0][0];
    expect(msg.attachments).toBeUndefined();
    expect(saved.attachments).toBeUndefined();

    // IPC send still gets undefined (not empty arrays) so the backend
    // can distinguish "no attachments" from "empty list".
    expect(deps.send.mock.calls[0][6]).toEqual({ files: undefined, images: undefined });
  });

  it('passes cwd, connection, initScript through to send()', () => {
    const deps = makeDeps();
    const connection = { type: 'ssh', host: 'h', port: 22, user: 'u' } as unknown as Connection;
    submitAgentMessage(makePayload({
      cwd: '/srv/x',
      connection,
      initScript: 'source env.sh',
    }), deps);

    const [tabId, text, cwd, provider, conn, initScript] = deps.send.mock.calls[0];
    expect(tabId).toBe('tab-1');
    expect(text).toBe('hello agent');
    expect(cwd).toBe('/srv/x');
    expect(provider).toBe('claude');
    expect(conn).toBe(connection);
    expect(initScript).toBe('source env.sh');
  });
});
