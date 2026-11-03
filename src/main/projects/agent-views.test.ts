import { expect, it, vi } from 'vitest';
import { createMainProjectsRepository } from './projects-repository';
import { PROJECT_MUTATION as M } from '@shared/project-mutations';
import { formatProjectsDocument, loadProjectsDocument } from './project-config-codec';
import { applyProjectMutation } from './project-mutation';

it('forgets unused metadata idempotently but refuses to forget a Default session', async () => {
  const result = createMainProjectsRepository({ load: () => ({ ok: true, value: [] }), save: async () => ({ ok: true }) }, () => 'p', { cleanup: async () => {} });
  if (!result.ok) throw new Error('fixture');
  const repo = result.repository;
  await repo.add({ name: 'p', cwd: '/p', maxTabs: 5, connection: { type: 'local' } });
  const created = await repo.mutate('p', { kind: M.CREATE_AGENT_VIEW, provider: 'claude' });
  if (!created.ok || !created.sessionId) throw new Error('fixture');
  const sessionId = created.sessionId;
  await repo.mutate('p', { kind: M.APPEND_DEFAULT_TAB, tab: { kind: 'agent', provider: 'claude', name: 'A', sessionId } });
  await expect(repo.mutate('p', { kind: M.FORGET_AGENT_VIEW, sessionId })).rejects.toThrow('Default');
  const before = repo.get('p')!.defaultTabs;
  await repo.mutate('p', { kind: M.EDIT, edits: [{ field: 'defaultTabs', before, value: [{ name: 'Terminal' }] }] });
  await repo.save({ ...repo.get('p')!, worktreeState: { availability: 'missing', identity: null } });
  await repo.mutate('p', { kind: M.FORGET_AGENT_VIEW, sessionId });
  expect(repo.get('p')!.agentViews).not.toHaveProperty(sessionId);
  await expect(repo.mutate('p', { kind: M.FORGET_AGENT_VIEW, sessionId })).resolves.toEqual({ ok: true });
});

it('keeps same-provider Views independent and saves references without copying preferences', async () => {
  const result = createMainProjectsRepository({ load: () => ({ ok: true, value: [] }), save: vi.fn(async () => ({ ok: true as const })) }, () => 'p', { cleanup: async () => {} });
  if (!result.ok) throw new Error('repository unavailable');
  const repo = result.repository;
  await repo.add({ name: 'p', cwd: '/p', maxTabs: 5, connection: { type: 'local' } });
  const create = () => repo.mutate('p', { kind: M.CREATE_AGENT_VIEW, provider: 'claude' });
  const a = await create();
  const b = await create();
  if (!a.ok || !b.ok || !a.sessionId || !b.sessionId) throw new Error('Missing created sessions');
  expect(a.sessionId).toBeTruthy();
  expect(b.sessionId).not.toBe(a.sessionId);
  await repo.mutate('p', { kind: M.AGENT_REPORT, sessionId: a.sessionId, report: { confirmedPrefs: { model: 'only-a' } } });
  for (const sessionId of [a.sessionId, b.sessionId, b.sessionId]) {
    await repo.mutate('p', { kind: M.APPEND_DEFAULT_TAB, tab: { kind: 'agent', provider: 'claude', name: sessionId, sessionId } });
  }
  const project = repo.get('p')!;
  expect(project.defaultTabs).toHaveLength(3);
  expect(project.agentViews[a.sessionId].prefs).toEqual({ model: 'only-a' });
  expect(project.agentViews[b.sessionId].prefs).toEqual({});
  const formatted = formatProjectsDocument([project]);
  expect(formatted.ok).toBe(true);
  if (formatted.ok) expect(loadProjectsDocument(formatted.data)).toEqual({ ok: true, value: [project] });
});

it('preserves latest View prefs through layout edits and creates a fresh identity for a provider change', async () => {
  const result = createMainProjectsRepository({ load: () => ({ ok: true, value: [] }), save: async () => ({ ok: true }) }, () => 'p', { cleanup: async () => {} });
  if (!result.ok) throw new Error('fixture');
  const repo = result.repository;
  const project = await repo.add({ name: 'p', cwd: '/p', maxTabs: 5, connection: { type: 'local' }, defaultTabs: [{ kind: 'agent', provider: 'claude', name: 'A' }] });
  const tab = project.defaultTabs[0];
  if (tab.kind !== 'agent' || !tab.sessionId) throw new Error('fixture');
  await repo.mutate('p', { kind: M.AGENT_REPORT, sessionId: tab.sessionId, report: { confirmedPrefs: { model: 'latest' } } });
  await repo.mutate('p', { kind: M.EDIT, edits: [{ field: 'defaultTabs', before: project.defaultTabs, value: [{ ...tab, name: 'renamed' }] }] });
  expect(repo.get('p')!.agentViews[tab.sessionId].prefs).toEqual({ model: 'latest' });
  const before = repo.get('p')!;
  await repo.mutate('p', { kind: M.EDIT, edits: [{ field: 'defaultTabs', before: before.defaultTabs, value: [{ ...tab, provider: 'codex' }] }] });
  const after = repo.get('p')!;
  const next = after.defaultTabs[0];
  if (next.kind !== 'agent' || !next.sessionId) throw new Error('fixture');
  expect(next.sessionId).not.toBe(tab.sessionId);
  expect(after.agentViews[next.sessionId]).toEqual({ provider: 'codex', prefs: {} });
  expect(after.agentViews[tab.sessionId].prefs).toEqual({ model: 'latest' });
  expect(() => applyProjectMutation(after, { kind: M.APPEND_DEFAULT_TAB, tab: { kind: 'agent', provider: 'claude', sessionId: 'missing', name: 'bad' } })).toThrow('binding');
  expect(formatProjectsDocument([after, { ...after, id: 'other' }]).ok).toBe(false);
});

it('migrates all legacy provider data, including records not in Default, without changing history keys', () => {
  const legacy = { id: 'p', name: 'p', cwd: '/p', maxTabs: 5, connection: { type: 'local' },
    initScript: null, envPlain: {}, quickCommands: [], featureNoteDir: null,
    parentProjectId: null, worktreeBranch: null, baseBranch: null,
    defaultTabs: [{ name: 'A', kind: 'agent', provider: 'claude' }],
    agentSessionIds: { claude: 'history-a', retired: 'history-retired' },
    agentPrefs: { claude: { model: 'saved' }, retired: { effort: 'high' } } };
  const loaded = loadProjectsDocument(JSON.stringify({ schemaVersion: 3, projects: [legacy] }));
  expect(loaded).toMatchObject({ ok: true, value: [{ agentViews: {
    'history-a': { provider: 'claude', prefs: { model: 'saved' } },
    'history-retired': { provider: 'retired', prefs: { effort: 'high' } },
  } }] });
});
