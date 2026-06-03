import React from 'react';
import { useStore, toggleProjectList, toggleRightSidebar } from '../store';
import { tooltipWithShortcut } from '../utils/format-keybinding';
import { isMac } from '../hooks/useKeybindings';
import { PanelLeftIcon, MessageIcon, NoteIcon, CodeIcon } from './icons';
import type { Connection } from '@shared/types';

const version = __APP_VERSION__;

// Dormant: the git-branch widget (display + switch/worktree-jump dropdown) was
// removed in the footer redesign because its refresh timing was unreliable
// (every read shelled out to the connector). The side-effect handler still
// lives in App.tsx listening for this event, so a future branch UX can re-wire
// by emitting SWITCH_BRANCH_EVENT again — no need to rebuild the switch logic.
export const SWITCH_BRANCH_EVENT = 'switch-branch';

function connectionLabel(conn: Connection): string {
  switch (conn.type) {
    case 'local': return 'local';
    case 'ssh': return `${conn.user}@${conn.host}:${conn.port}`;
    case 'wsl': return `wsl: ${conn.distro}`;
    case 'docker': return `docker: ${conn.container}`;
  }
}

export function BottomBar() {
  const {
    projects,
    activeProjectIndex,
    sidebarVisible,
    pmVisible,
    notesVisible,
    devToolsVisible,
    awayMode,
    updateStatus,
    settings,
  } = useStore();
  const kb = settings.keybindings;
  const proj = projects[activeProjectIndex] ?? null;

  return (
    <div className="bottom-bar">
      <div className="bottom-bar-left">
        {proj && (
          <>
            <span className="bottom-bar-connection">{connectionLabel(proj.config.connection)}</span>
            <span className="bottom-bar-separator">|</span>
            <span className="bottom-bar-path" title={proj.config.cwd}>{proj.config.cwd}</span>
          </>
        )}
      </div>
      <div className="bottom-bar-right">
        <span className="bottom-bar-version">v{version}</span>
        {updateStatus.state === 'idle' && (
          <button
            className="bottom-bar-update-btn"
            tabIndex={-1}
            title="Check for updates"
            onClick={() => window.shelfApi.updater.check()}
          >
            &#x21BB;
          </button>
        )}
        {updateStatus.state === 'available' && (
          <button
            className="bottom-bar-update-btn"
            tabIndex={-1}
            title={`Download v${updateStatus.version}`}
            onClick={() => window.shelfApi.updater.download()}
          >
            &#x21E9;
          </button>
        )}
        {updateStatus.state === 'downloading' && (
          <div
            className="bottom-bar-update-progress"
            title={`Downloading v${updateStatus.version} — ${Math.round(updateStatus.percent)}%`}
          >
            <div
              className="bottom-bar-update-progress-bar"
              style={{ width: `${Math.max(0, Math.min(100, updateStatus.percent))}%` }}
            />
          </div>
        )}
        {updateStatus.state === 'downloaded' && (
          <button
            className="bottom-bar-update-btn ready"
            tabIndex={-1}
            title={`Install v${updateStatus.version}`}
            onClick={() => window.shelfApi.updater.install()}
          >
            &#x21BB;
          </button>
        )}

        <span className="bottom-bar-toggles">
          <button
            className={`right-tab-btn${sidebarVisible ? ' active' : ''}`}
            tabIndex={-1}
            onClick={toggleProjectList}
            title={tooltipWithShortcut('Projects', kb.toggleProjectList, isMac)}
          >
            <PanelLeftIcon />
            <span className="sr-only">Projects</span>
          </button>
          <button
            className={`right-tab-btn${pmVisible ? ' active' : ''}`}
            tabIndex={-1}
            onClick={() => toggleRightSidebar('pm')}
            title={tooltipWithShortcut('PM Agent', kb.togglePm, isMac)}
          >
            <span className={`pm-tab-dot ${awayMode ? 'pm-dot-away' : 'pm-dot'}`} />
            <MessageIcon />
            <span className="sr-only">PM</span>
          </button>
          <button
            className={`right-tab-btn${notesVisible ? ' active' : ''}`}
            tabIndex={-1}
            onClick={() => toggleRightSidebar('notes')}
            title={tooltipWithShortcut('Notes', kb.toggleNotes, isMac)}
          >
            <NoteIcon />
            <span className="sr-only">Notes</span>
          </button>
          <button
            className={`right-tab-btn${devToolsVisible ? ' active' : ''}`}
            tabIndex={-1}
            onClick={() => toggleRightSidebar('devtools')}
            title={tooltipWithShortcut('Dev Tools', kb.toggleDevTools, isMac)}
          >
            <CodeIcon />
            <span className="sr-only">Dev Tools</span>
          </button>
        </span>
      </div>
    </div>
  );
}
