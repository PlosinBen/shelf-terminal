import { it, expect, vi, afterEach } from 'vitest';
import { reconcileProjects, addTab, getProjectSliceSnapshot, setEditingProjectById, resetProjectStoreForTests } from './store-projects';
import type { Project } from '@shared/projects';
vi.stubGlobal('window', { shelfApi: { app: { syncState: vi.fn() } } });
afterEach(() => { resetProjectStoreForTests(); });
it('prevents tabs and editing for a restored missing worktree', () => {
  reconcileProjects([{ id: 'child', name: 'repo', cwd: '/child', parentProjectId: 'main', maxTabs: 5, worktreeState: { availability: 'missing', identity: null } } as Project]);
  expect(addTab(0)).toBeNull();
  setEditingProjectById('child');
  expect(getProjectSliceSnapshot().editingProjectId).toBeNull();
});
