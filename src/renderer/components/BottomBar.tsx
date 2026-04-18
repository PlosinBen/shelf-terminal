import React, { useState, useEffect, useRef } from 'react';
import { useStore, setActiveProject } from '../store';
import { emit, Events } from '../events';
import type { Connection, GitBranchInfo } from '@shared/types';

function connectionLabel(conn: Connection): string {
  switch (conn.type) {
    case 'local': return 'local';
    case 'ssh': return `${conn.user}@${conn.host}:${conn.port}`;
    case 'wsl': return `wsl: ${conn.distro}`;
    case 'docker': return `docker: ${conn.container}`;
  }
}

export const SWITCH_BRANCH_EVENT = 'switch-branch';

export function BottomBar() {
  const { projects, activeProjectIndex } = useStore();
  const proj = projects[activeProjectIndex] ?? null;
  const [branches, setBranches] = useState<GitBranchInfo[]>([]);
  const [currentBranch, setCurrentBranch] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [switching, setSwitching] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const isWorktree = !!proj?.config.worktreeBranch;
  const connected = proj ? proj.tabs.length > 0 : false;

  const fetchBranch = () => {
    if (!proj || !connected) {
      setCurrentBranch(null);
      setBranches([]);
      return;
    }
    if (isWorktree) {
      setCurrentBranch(proj.config.worktreeBranch!);
      return;
    }
    window.shelfApi.git.branchList(proj.config.connection, proj.config.cwd).then((list) => {
      setBranches(list);
      const cur = list.find((b) => b.current);
      setCurrentBranch(cur?.name ?? null);
    }).catch(() => {
      setCurrentBranch(null);
    });
  };

  useEffect(() => {
    fetchBranch();
  }, [proj?.config.id, connected]);

  // Close dropdown on outside click
  useEffect(() => {
    if (!dropdownOpen) return;
    const handler = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [dropdownOpen]);

  if (!proj) return null;

  const handleBranchClick = () => {
    if (isWorktree || !connected) return;
    if (!dropdownOpen) {
      window.shelfApi.git.branchList(proj.config.connection, proj.config.cwd).then((list) => {
        setBranches(list);
        const cur = list.find((b) => b.current);
        setCurrentBranch(cur?.name ?? null);
      }).catch(() => {});
    }
    setDropdownOpen(!dropdownOpen);
  };

  const handleBranchItemClick = async (branch: GitBranchInfo) => {
    if (branch.name === currentBranch || !proj) return;
    setDropdownOpen(false);

    // Branch is checked out in a worktree — navigate to that project or create one
    if (branch.worktreePath) {
      const existingIndex = projects.findIndex((p) => p.config.cwd === branch.worktreePath);
      if (existingIndex !== -1) {
        setActiveProject(existingIndex);
        if (projects[existingIndex].tabs.length === 0) {
          emit(Events.CONNECT_PROJECT, existingIndex);
        }
      } else {
        const parentId = proj.config.parentProjectId || proj.config.id;
        const config = {
          id: `proj-${Date.now()}`,
          name: proj.config.name,
          cwd: branch.worktreePath,
          connection: proj.config.connection,
          maxTabs: proj.config.maxTabs,
          parentProjectId: parentId,
          worktreeBranch: branch.name,
        };
        emit(Events.ADD_PROJECT, config);
        // Connect after adding — new project will be last in the list
        setTimeout(() => emit(Events.CONNECT_PROJECT, projects.length), 0);
      }
      return;
    }

    // Normal branch switch
    setSwitching(true);
    try {
      const dirty = await window.shelfApi.git.checkDirty(proj.config.connection, proj.config.cwd);
      if (dirty) {
        const confirmed = await window.shelfApi.dialog.confirm(
          'Uncommitted changes',
          'There are uncommitted changes. Switching branches may fail.\n\nContinue anyway?',
          'Switch',
        );
        if (!confirmed) {
          setSwitching(false);
          return;
        }
      }
    } catch {
      // proceed anyway
    }

    emit(SWITCH_BRANCH_EVENT, activeProjectIndex, branch.name, (success: boolean, newBranch?: string) => {
      setSwitching(false);
      if (success && newBranch) {
        setCurrentBranch(newBranch);
      } else {
        fetchBranch();
      }
    });
  };

  return (
    <div className="bottom-bar">
      <div className="bottom-bar-left">
        <span className="bottom-bar-connection">{connectionLabel(proj.config.connection)}</span>
        <span className="bottom-bar-separator">|</span>
        <span className="bottom-bar-path" title={proj.config.cwd}>{proj.config.cwd}</span>
      </div>
      <div className="bottom-bar-right">
        {connected && currentBranch && (
          <div className="bottom-bar-branch-wrapper" ref={dropdownRef}>
            <button
              className={`bottom-bar-branch ${isWorktree ? 'disabled' : ''} ${switching ? 'switching' : ''}`}
              onClick={handleBranchClick}
              disabled={isWorktree || switching}
              title={isWorktree ? 'Worktree is locked to this branch' : 'Switch branch'}
            >
              <span className="bottom-bar-branch-icon">&#9741;</span>
              {switching ? 'switching...' : currentBranch}
            </button>
            {dropdownOpen && (
              <div className="bottom-bar-branch-dropdown">
                {branches.length === 0 ? (
                  <div className="bottom-bar-branch-empty">No branches</div>
                ) : (
                  branches.map((b) => (
                    <button
                      key={b.name}
                      className={`bottom-bar-branch-item ${b.current ? 'current' : ''} ${b.worktreePath ? 'worktree' : ''}`}
                      onClick={() => !b.current && handleBranchItemClick(b)}
                      disabled={b.current}
                    >
                      {b.name}
                      {b.current && <span className="bottom-bar-branch-worktree-hint">current</span>}
                      {!b.current && b.worktreePath && <span className="bottom-bar-branch-worktree-hint">worktree</span>}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
