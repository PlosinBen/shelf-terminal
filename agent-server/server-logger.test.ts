import { describe, it, expect, beforeEach } from 'vitest';
import { serverLog, setLogSink, type ServerLogMessage } from './server-logger';

describe('serverLog', () => {
  let sent: ServerLogMessage[];
  beforeEach(() => {
    sent = [];
    setLogSink((m) => sent.push(m));
  });

  it('routes a plain message to the sink with level + tag', () => {
    serverLog('info', 'claude', 'hello');
    expect(sent).toEqual([{ type: 'log', level: 'info', tag: 'claude', msg: 'hello' }]);
  });

  it('flattens a string arg into the message', () => {
    serverLog('warn', 'send-queue', 'cancel-unknown clientMsgId=abc');
    expect(sent[0].msg).toBe('cancel-unknown clientMsgId=abc');
  });

  it('formats an Error arg to its stack/message (not {} as JSON would)', () => {
    serverLog('error', 'ctx', 'load failed', new Error('boom'));
    expect(sent[0].level).toBe('error');
    expect(sent[0].msg).toContain('load failed');
    expect(sent[0].msg).toContain('boom');
  });

  it('JSON-stringifies object args', () => {
    serverLog('debug', 'claude', 'dropped', { task_id: 't1' });
    expect(sent[0].msg).toBe('dropped {"task_id":"t1"}');
  });
});
