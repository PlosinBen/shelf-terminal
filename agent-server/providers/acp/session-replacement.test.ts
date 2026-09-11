import { describe, expect, it } from 'vitest';
import { replaceSession } from './session-replacement';

describe('replaceSession', () => {
  it('sequences opaque state capture, invalidation, reset, replacement, and initialization', async () => {
    const calls: string[] = [];

    const replacement = await replaceSession({
      capture: () => {
        calls.push('capture');
        return { model: 'confirmed-model' };
      },
      invalidate: () => { calls.push('invalidate'); },
      reset: () => { calls.push('reset'); },
      establish: async () => {
        calls.push('establish');
        return { id: 'replacement' };
      },
      initialize: async (session, snapshot) => {
        calls.push(`initialize:${session.id}:${snapshot.model}`);
      },
    });

    expect(replacement).toEqual({ id: 'replacement' });
    expect(calls).toEqual([
      'capture',
      'invalidate',
      'reset',
      'establish',
      'initialize:replacement:confirmed-model',
    ]);
  });

  it('fails without establishing a replacement when reset fails', async () => {
    const calls: string[] = [];

    await expect(replaceSession({
      capture: () => 'snapshot',
      invalidate: () => { calls.push('invalidate'); },
      reset: () => { throw new Error('reset failed'); },
      establish: async () => {
        calls.push('establish');
        return 'replacement';
      },
      initialize: async () => { calls.push('initialize'); },
    })).rejects.toThrow('reset failed');

    expect(calls).toEqual(['invalidate']);
  });
});
