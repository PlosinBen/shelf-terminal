import { describe, expect, it, vi } from 'vitest';
import { CodexNativeControls, CODEX_NATIVE_RPC } from './native-controls';

async function setup() {
  const controls = new CodexNativeControls();
  const settings = { model: 'm', effort: 'ultra', approvalPolicy: { granular: { rules: true } },
    activePermissionProfile: null, sandboxPolicy: { type: 'readOnly' }, collaborationMode: { mode: 'default' } };
  const request = vi.fn(async (method: string, params?: any): Promise<any> => {
    if (method === CODEX_NATIVE_RPC.PROFILES) return { data: [{ id: ':workspace', allowed: true }, { id: 'blocked', allowed: false }] };
    if (method === CODEX_NATIVE_RPC.MODES) {
      expect(params).toEqual({});
      return { data: [{ mode: 'default', name: 'Default' }, { mode: 'plan', name: 'Plan', reasoning_effort: 'medium' }] };
    }
    if (method === CODEX_NATIVE_RPC.REQUIREMENTS) return { requirements: { allowedApprovalPolicies: ['on-request', 'never'] } };
    if (method === CODEX_NATIVE_RPC.UPDATE) {
      if (params.collaborationMode) settings.collaborationMode = params.collaborationMode;
      if (params.effort) settings.effort = params.effort;
      controls.observe({ threadId: 't', threadSettings: { ...settings } });
      return {};
    }
    throw new Error('unexpected method');
  });
  const client = { request };
  await controls.load(client, '/repo', [{ value: 'other', displayName: 'Other', effortLevels: [{ value: 'low', displayName: 'Low' }] }, { value: 'm', displayName: 'M', effortLevels: [{ value: 'ultra', displayName: 'Ultra' }, { value: 'max', displayName: 'Max' }] }]);
  controls.seed('t', { ...settings, sandbox: settings.sandboxPolicy, reasoningEffort: settings.effort });
  return { controls, client, settings };
}

describe('native Codex controls', () => {
  it('uses native effort, filters managed options, and displays granular without making it selectable', async () => {
    const { controls } = await setup();
    expect(controls.capabilities()).toMatchObject({ effortLevels: [{ value: 'ultra' }, { value: 'max' }],
      permissionControl: { approval: { currentDisplayName: 'Custom', options: [{ value: 'on-request' }, { value: 'never' }] },
        permission: { options: [{ value: ':workspace' }] } } });
  });
  it('changes mode independently and accepts notification before RPC completion', async () => {
    const { controls, client, settings } = await setup();
    await controls.apply(client, 'nativeMode', 'plan');
    expect(client.request).toHaveBeenLastCalledWith(CODEX_NATIVE_RPC.UPDATE, { threadId: 't', collaborationMode: {
      mode: 'plan', settings: { model: 'm', reasoning_effort: 'ultra', developer_instructions: null },
    } });
    expect(settings.approvalPolicy).toEqual({ granular: { rules: true } });
    const count = client.request.mock.calls.length;
    expect(await controls.apply(client, 'nativeMode', 'plan')).toBe(false);
    expect(client.request).toHaveBeenCalledTimes(count);
  });
  it('accepts a same-value initial mode acknowledgement without inventing a notification', async () => {
    const { controls, client } = await setup();
    client.request.mockResolvedValueOnce({});
    await expect(controls.apply(client, 'nativeMode', 'default')).resolves.toBe(true);
    expect(controls.value('nativeMode')).toBe('default');
  });
  it('rejects a model change that would invalidate effort without silently changing either', async () => {
    const { controls, client } = await setup();
    await expect(controls.apply(client, 'model', 'other')).rejects.toThrow('does not support current effort');
    expect(controls.value('model')).toBe('m');
    expect(controls.value('effort')).toBe('ultra');
  });
  it('rejects unsupported effort without applying a substitute', async () => {
    const { controls, client } = await setup();
    await expect(controls.apply(client, 'effort', 'invented')).rejects.toThrow('did not advertise');
    expect(client.request).not.toHaveBeenCalledWith(CODEX_NATIVE_RPC.UPDATE, expect.anything());
  });
  it('waits for a matching notification after RPC, ignoring other threads', async () => {
    const { controls, client, settings } = await setup();
    client.request.mockResolvedValueOnce({});
    let done = false;
    const applied = controls.apply(client, 'effort', 'max').then(() => { done = true; });
    await Promise.resolve();
    controls.observe({ threadId: 'other', threadSettings: { ...settings, effort: 'max' } });
    expect(done).toBe(false);
    controls.observe({ threadId: 't', threadSettings: { ...settings, effort: 'max' } });
    await applied;
    expect(controls.value('effort')).toBe('max');
  });
  it('does not confirm a rejected RPC even if a matching notification arrived', async () => {
    const { controls, client, settings } = await setup();
    client.request.mockImplementationOnce(async () => {
      controls.observe({ threadId: 't', threadSettings: { ...settings, effort: 'max' } });
      throw new Error('failed');
    });
    await expect(controls.apply(client, 'effort', 'max')).rejects.toThrow('failed');
    expect(controls.value('effort')).toBe('ultra');
    await expect(controls.apply(client, 'effort', 'max')).rejects.toThrow('reconnect');
  });
  it('times out instead of persisting an unconfirmed update', async () => {
    vi.useFakeTimers();
    try {
      const { controls, client } = await setup();
      client.request.mockResolvedValueOnce({});
      const result = expect(controls.apply(client, 'effort', 'max')).rejects.toThrow('timed out');
      await vi.advanceTimersByTimeAsync(10_000);
      await result;
      expect(controls.value('effort')).toBe('ultra');
    } finally { vi.useRealTimers(); }
  });
});
