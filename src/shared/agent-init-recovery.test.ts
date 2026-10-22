import { describe, it, expect, vi } from 'vitest';
import { AgentInitializationError, AgentInitRecoveryKind, readInitRecovery, recoveryFromError } from './agent-init-recovery';

describe('initialization recovery metadata', () => {
  it('survives JSON transport without relying on error wording', () => {
    const recovery = { kind: AgentInitRecoveryKind.CLEAR_SAVED_MODEL, model: 'retired' };
    const wire = JSON.parse(JSON.stringify({ error: 'unavailable', recovery }));
    expect(recoveryFromError(new AgentInitializationError(wire.error, readInitRecovery(wire.recovery)))).toEqual(recovery);
    expect(recoveryFromError(new Error('saved model unavailable'))).toBeUndefined();
  });
  it('rejects unknown or malformed metadata and logs it', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const value of [null, {}, { kind: 'future', model: 'x' }, { kind: AgentInitRecoveryKind.CLEAR_SAVED_MODEL }]) {
      expect(readInitRecovery(value)).toBeUndefined();
    }
    expect(warn).toHaveBeenCalledTimes(4);
    warn.mockRestore();
  });
});
