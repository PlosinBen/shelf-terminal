import { expect, it, vi } from 'vitest';
import { collectUnusedAgentViews } from './agent-view-cleanup';
import type { ProjectView } from './store-projects';

function fixture() {
  const project = { id: 'p', agentViews: { saved: {}, live: {}, unused: {} },
    defaultTabs: [{ kind: 'agent', sessionId: 'saved' }],
    tabs: [{ type: 'agent', sessionId: 'live' }] } as unknown as ProjectView;
  const clear = vi.fn(async (_id: string) => {});
  const forget = vi.fn(async (_projectId: string, id: string) => { delete (project.agentViews as Record<string, unknown>)[id]; });
  return { project, clear, forget, getProject: () => project, settle: async () => {} };
}

it('collects only candidate sessions with no Default or live references, clearing history before metadata', async () => {
  const f = fixture();
  await collectUnusedAgentViews('p', ['saved', 'live', 'unused', 'missing'], f);
  expect(f.clear).toHaveBeenCalledExactlyOnceWith('unused');
  expect(f.forget).toHaveBeenCalledExactlyOnceWith('p', 'unused');
  expect(f.clear.mock.invocationCallOrder[0]).toBeLessThan(f.forget.mock.invocationCallOrder[0]);
  expect(f.project.agentViews).toHaveProperty('saved');
  expect(f.project.agentViews).toHaveProperty('live');
});

it('retains ownership after clear failure and can retry without scanning unknown history', async () => {
  const f = fixture();
  f.clear.mockRejectedValueOnce(new Error('IDB unavailable'));
  await expect(collectUnusedAgentViews('p', ['unused'], f)).rejects.toThrow('IDB unavailable');
  expect(f.forget).not.toHaveBeenCalled();
  expect(f.project.agentViews).toHaveProperty('unused');
  await collectUnusedAgentViews('p', ['unused'], f);
  expect(f.project.agentViews).not.toHaveProperty('unused');
});

it('retains retry inventory when history was cleared but config removal failed', async () => {
  const f = fixture();
  f.forget.mockRejectedValueOnce(new Error('config unavailable'));
  await expect(collectUnusedAgentViews('p', ['unused'], f)).rejects.toThrow('config unavailable');
  expect(f.project.agentViews).toHaveProperty('unused');
  await collectUnusedAgentViews('p', ['unused'], f);
  expect(f.project.agentViews).not.toHaveProperty('unused');
});

it('rechecks current references rather than an editor or close-time snapshot', async () => {
  const f = fixture();
  f.project = { ...f.project, defaultTabs: [...f.project.defaultTabs, { kind: 'agent', provider: 'claude', name: 'saved later', sessionId: 'unused' }] };
  await collectUnusedAgentViews('p', ['unused'], { ...f, getProject: () => f.project });
  expect(f.clear).not.toHaveBeenCalled();
});

it('does not delete history while another close path is still settling its writer', async () => {
  const f = fixture();
  let finish!: () => void;
  const closing = collectUnusedAgentViews('p', ['unused'], { ...f, settle: () => new Promise<void>(resolve => { finish = resolve; }) });
  await Promise.resolve();
  expect(f.clear).not.toHaveBeenCalled();
  finish();
  await closing;
  expect(f.clear).toHaveBeenCalledOnce();
});
