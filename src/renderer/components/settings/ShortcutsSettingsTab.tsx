import React from 'react';
import { comboToLabel } from '../../hooks/useKeybindings';
import type { AppSettings, KeybindingAction } from '@shared/types';

const ACTION_LABELS: Record<KeybindingAction, string> = {
  toggleProjectList: 'Toggle Project List',
  newProject: 'New Project',
  removeProject: 'Remove Project',
  newTab: 'New Tab',
  prevProject: 'Previous Project',
  nextProject: 'Next Project',
  prevTab: 'Previous Tab',
  nextTab: 'Next Tab',
  openSettings: 'Settings',
  search: 'Search',
  toggleSplitRight: 'Split Right',
  openCommandPicker: 'Quick Commands',
  toggleDevTools: 'Dev Tools',
  toggleNotes: 'Notes',
  togglePm: 'PM Agent',
  quickNote: 'Quick Note',
};

interface Props {
  draft: AppSettings;
  recordingAction: KeybindingAction | null;
  setRecordingAction: (action: KeybindingAction | null) => void;
}

export function ShortcutsSettingsTab({ draft, recordingAction, setRecordingAction }: Props) {
  return (
    <>
      {(Object.keys(ACTION_LABELS) as KeybindingAction[]).map((action) => (
        <div className="settings-group" key={action}>
          <label className="settings-label">{ACTION_LABELS[action]}</label>
          <button
            className={`keybinding-btn ${recordingAction === action ? 'recording' : ''}`}
            onClick={() => setRecordingAction(recordingAction === action ? null : action)}
          >
            {recordingAction === action
              ? 'Press key combo...'
              : comboToLabel(draft.keybindings[action])}
          </button>
        </div>
      ))}
    </>
  );
}
