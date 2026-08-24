import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@shared/projects';
import {
  __getSnapshotForTests,
  __resetStoreForTests,
  addTab,
  addTerminalTabForSource,
  getActiveProjectId,
  listStableProjectViews,
  projectDisplayLabel,
  setActiveProjectById,
  setProjects,
} from './store';

function project(id: string, changes: Partial<Project> = {}): Project {
  return {
    id,
    name: id,
    cwd: `/repo/${id}`,
    connection: { type: 'local' },
    maxTabs: 5,
    initScript: null,
    envPlain: {},
    defaultTabs: [],
    quickCommands: [],
    featureNoteDir: null,
    parentProjectId: null,
    worktreeBranch: null,
    baseBranch: null,
    defaultAgentProvider: null,
    openAgentOnConnect: false,
    agentSessionIds: {},
    agentPrefs: {},
    ...changes,
  };
}

describe('store project reconciliation', () => {
  beforeEach(() => {
    vi.stubGlobal('window', { shelfApi: { pm: { syncState: vi.fn() } } });
    __resetStoreForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    __resetStoreForTests();
  });

  it('uses the worktree branch as the visible project label', () => {
    expect(projectDisplayLabel(project('Base'))).toBe('Base');
    expect(projectDisplayLabel(project('Child', {
      name: 'Base',
      parentProjectId: 'Base',
      worktreeBranch: 'feature/popup-focus',
    }))).toBe('feature/popup-focus');
  });

  it('adopts repository order while preserving runtime state by project id', () => {
    setProjects([project('A'), project('B'), project('C')]);
    addTab(0);
    addTab(1);
    addTab(2);
    setActiveProjectById('A');

    setProjects([project('B'), project('C'), project('A')]);

    expect(__getSnapshotForTests().projects.map((candidate) => candidate.id)).toEqual(['B', 'C', 'A']);
    expect(__getSnapshotForTests().projects.map((candidate) => candidate.tabs.length)).toEqual([1, 1, 1]);
    expect(listStableProjectViews().map((candidate) => candidate.id)).toEqual(['A', 'B', 'C']);
    expect(getActiveProjectId()).toBe('A');
  });

  it('opens a command terminal in the source agent tab project', () => {
    setProjects([project('A'), project('B')]);
    const agentTab = addTab(1, undefined, undefined, undefined, 'agent', 'claude');

    const terminal = addTerminalTabForSource(
      agentTab!.id,
      'Claude Login',
      'claude auth login',
    );

    expect(terminal).toMatchObject({
      label: 'Claude Login',
      type: 'terminal',
      cmd: 'claude auth login',
    });
    expect(__getSnapshotForTests().projects[0].tabs).toHaveLength(0);
    expect(__getSnapshotForTests().projects[1].tabs.map((tab) => tab.id))
      .toEqual([agentTab!.id, terminal!.id]);
    expect(__getSnapshotForTests().projects[1].activeTabIndex).toBe(1);
  });

  it('does not open an auth terminal when the source tab is gone', () => {
    setProjects([project('A')]);

    expect(addTerminalTabForSource('missing-tab', 'Claude Login', 'claude auth login')).toBeNull();
    expect(__getSnapshotForTests().projects[0].tabs).toHaveLength(0);
  });
});
