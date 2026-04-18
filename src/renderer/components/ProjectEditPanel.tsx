import React, { useState, useEffect, useRef } from 'react';
import { useStore, setEditingProject, updateProjectConfig } from '../store';
import type { TabTemplate, QuickCommand, AgentProvider } from '@shared/types';
import { TAB_COLORS } from './TabBar';

export function ProjectEditPanel() {
  const { editingProjectIndex, projects } = useStore();
  const project = editingProjectIndex !== null ? projects[editingProjectIndex] : null;

  const [name, setName] = useState('');
  const [initScript, setInitScript] = useState('');
  const [defaultTabs, setDefaultTabs] = useState<TabTemplate[]>([]);
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const dragFromHandle = useRef(false);
  const [colorPickerIndex, setColorPickerIndex] = useState<number | null>(null);
  const [defaultAgentProvider, setDefaultAgentProvider] = useState<AgentProvider | ''>('');
  const [openAgentOnConnect, setOpenAgentOnConnect] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [remoteConnected, setRemoteConnected] = useState(true);

  useEffect(() => {
    if (project) {
      setName(project.config.name);
      setInitScript(project.config.initScript || '');
      setDefaultTabs(project.config.defaultTabs || [{ name: 'Terminal' }]);
      setQuickCommands(project.config.quickCommands || []);
      setDefaultAgentProvider(project.config.defaultAgentProvider || '');
      setOpenAgentOnConnect(project.config.openAgentOnConnect ?? true);
    }
  }, [editingProjectIndex]);

  // Probe whether the remote is currently reachable so we can enable/disable
  // the Clear button. Local connections are always considered reachable.
  useEffect(() => {
    if (!project) return;
    const conn = project.config.connection;
    if (conn.type === 'local') {
      setRemoteConnected(true);
      return;
    }
    let cancelled = false;
    window.shelfApi.connector.isConnected(conn).then((ok) => {
      if (!cancelled) setRemoteConnected(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [editingProjectIndex]);

  if (!project || editingProjectIndex === null) return null;

  const handleClose = () => setEditingProject(null);

  const handleSave = () => {
    const tabs = defaultTabs
      .filter((t) => t.name.trim())
      .map((t) => ({ ...t, color: t.color || undefined }));
    const cmds = quickCommands.filter((c) => c.label.trim() && c.command.trim());
    updateProjectConfig(editingProjectIndex, {
      name: name.trim() || project.config.name,
      initScript: initScript.trim() || undefined,
      defaultTabs: tabs.length > 0 ? tabs : undefined,
      quickCommands: cmds.length > 0 ? cmds : undefined,
      defaultAgentProvider: defaultAgentProvider || undefined,
      openAgentOnConnect,
    });
    handleClose();
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) handleClose();
  };

  const updateTab = (index: number, field: keyof TabTemplate, value: string) => {
    setDefaultTabs((tabs) =>
      tabs.map((t, i) => (i === index ? { ...t, [field]: value } : t)),
    );
  };

  const addTab = () => {
    setDefaultTabs((tabs) => [...tabs, { name: `Terminal ${tabs.length + 1}` }]);
  };

  const removeTab = (index: number) => {
    if (defaultTabs.length <= 1) return;
    setDefaultTabs((tabs) => tabs.filter((_, i) => i !== index));
  };

  const handleMouseDown = (e: React.MouseEvent) => {
    dragFromHandle.current =
      e.target instanceof HTMLElement && !!e.target.closest('.default-tab-drag');
  };

  const handleDragStart = (e: React.DragEvent, index: number) => {
    if (!dragFromHandle.current) {
      e.preventDefault();
      return;
    }
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
  };

  const handleDragOver = (e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  };

  const handleDrop = (e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== toIndex) {
      setDefaultTabs((tabs) => {
        const items = [...tabs];
        const [moved] = items.splice(dragIndex, 1);
        items.splice(toIndex, 0, moved);
        return items;
      });
    }
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleDragEnd = () => {
    setDragIndex(null);
    setDragOverIndex(null);
  };

  const handleClearUploads = async () => {
    if (!project || clearing) return;
    const ok = await window.shelfApi.dialog.confirm(
      'Clear uploaded files',
      `Delete every file in ${project.config.cwd}/.tmp/shelf/ ?\n\nThis cannot be undone.`,
      'Delete',
    );
    if (!ok) return;
    setClearing(true);
    try {
      const result = await window.shelfApi.connector.clearUploads(
        project.config.connection,
        project.config.cwd,
      );
      if (result.ok) {
        await window.shelfApi.dialog.warn(
          'Uploaded files cleared',
          result.removed === 0
            ? 'No uploaded files to remove.'
            : `Removed ${result.removed} file(s).`,
        );
      } else {
        await window.shelfApi.dialog.warn('Clear failed', result.reason);
      }
    } finally {
      setClearing(false);
    }
  };

  const isRemote = project ? project.config.connection.type !== 'local' : false;
  const clearDisabled = clearing || (isRemote && !remoteConnected);
  const clearTooltip =
    isRemote && !remoteConnected
      ? 'Will auto-clean on next connect'
      : 'Delete every file in <cwd>/.tmp/shelf/';

  return (
    <div className="settings-overlay" onClick={handleOverlayClick}>
      <div className="project-edit-panel">
        <div className="settings-header">
          <span>Edit Project</span>
          <button className="settings-close" onClick={handleClose}>×</button>
        </div>
        <div className="project-edit-body">
          <div className="settings-group">
            <label className="settings-label">Name</label>
            <input
              className="settings-input settings-input-wide"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>

          <div className="project-edit-field">
            <label className="settings-label">Init Script</label>
            <div className="project-edit-hint">
              Runs on every tab (environment setup)
            </div>
            <textarea
              className="project-edit-textarea"
              value={initScript}
              onChange={(e) => setInitScript(e.target.value)}
              placeholder="e.g. nvm use 22.22&#10;source .env"
              rows={3}
            />
          </div>

          <div className="settings-group">
            <label className="settings-label">Default Agent</label>
            <select
              className="settings-select"
              value={defaultAgentProvider}
              onChange={(e) => setDefaultAgentProvider(e.target.value as AgentProvider | '')}
            >
              <option value="">None</option>
              <option value="claude">Claude</option>
              <option value="copilot">Copilot</option>
              <option value="gemini">Gemini</option>
            </select>
          </div>

          <div className="settings-group">
            <label className="settings-checkbox-label">
              <input
                type="checkbox"
                checked={openAgentOnConnect}
                onChange={(e) => setOpenAgentOnConnect(e.target.checked)}
              />
              Open agent tab on connect
            </label>
          </div>

          <div className="project-edit-field">
            <label className="settings-label">Default Tabs</label>
            <div className="project-edit-hint">
              Tabs to open on connect. Each tab can have its own command.
            </div>
            <div className="default-tabs-list">
              {defaultTabs.map((tab, i) => (
                <div
                  key={i}
                  className={`default-tab-row ${dragIndex === i ? 'dragging' : ''} ${dragOverIndex === i && dragIndex !== i ? 'drag-over' : ''}`}
                  draggable
                  onMouseDown={handleMouseDown}
                  onDragStart={(e) => handleDragStart(e, i)}
                  onDragOver={(e) => handleDragOver(e, i)}
                  onDrop={(e) => handleDrop(e, i)}
                  onDragEnd={handleDragEnd}
                >
                  <span className="default-tab-drag">⠿</span>
                  <div className="default-tab-color-wrapper">
                    <button
                      className="default-tab-color-btn"
                      style={tab.color ? { backgroundColor: tab.color } : undefined}
                      onClick={() => setColorPickerIndex(colorPickerIndex === i ? null : i)}
                      title="Tab color"
                    />
                    {colorPickerIndex === i && (
                      <div className="default-tab-color-dropdown">
                        <button
                          className={`color-swatch color-swatch-none ${!tab.color ? 'active' : ''}`}
                          onClick={() => { updateTab(i, 'color', ''); setColorPickerIndex(null); }}
                          title="No color"
                        />
                        {TAB_COLORS.map((c) => (
                          <button
                            key={c.hex}
                            className={`color-swatch ${tab.color === c.hex ? 'active' : ''}`}
                            style={{ backgroundColor: c.hex }}
                            onClick={() => { updateTab(i, 'color', c.hex); setColorPickerIndex(null); }}
                            title={c.name}
                          />
                        ))}
                      </div>
                    )}
                  </div>
                  <input
                    className="default-tab-name"
                    type="text"
                    value={tab.name}
                    onChange={(e) => updateTab(i, 'name', e.target.value)}
                    placeholder="Tab name"
                  />
                  <input
                    className="default-tab-cmd"
                    type="text"
                    value={tab.cmd || ''}
                    onChange={(e) => updateTab(i, 'cmd', e.target.value)}
                    placeholder="command (optional)"
                  />
                  <button
                    className="default-tab-remove"
                    onClick={() => removeTab(i)}
                    disabled={defaultTabs.length <= 1}
                    title="Remove tab"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button className="default-tab-add" onClick={addTab}>+ Add Tab</button>
          </div>

          <div className="project-edit-field">
            <label className="settings-label">Quick Commands</label>
            <div className="project-edit-hint">
              Commands available via {navigator.platform.toUpperCase().includes('MAC') ? '⌘E' : 'Ctrl+E'}. Target a specific tab by name or use current tab.
            </div>
            <div className="quick-commands-list">
              {quickCommands.map((cmd, i) => (
                <div key={i} className="quick-command-row">
                  <input
                    className="quick-command-label"
                    type="text"
                    value={cmd.label}
                    onChange={(e) =>
                      setQuickCommands((cmds) =>
                        cmds.map((c, j) => (j === i ? { ...c, label: e.target.value } : c)),
                      )
                    }
                    placeholder="Label"
                  />
                  <input
                    className="quick-command-cmd"
                    type="text"
                    value={cmd.command}
                    onChange={(e) =>
                      setQuickCommands((cmds) =>
                        cmds.map((c, j) => (j === i ? { ...c, command: e.target.value } : c)),
                      )
                    }
                    placeholder="command"
                  />
                  <select
                    className="quick-command-target"
                    value={cmd.target}
                    onChange={(e) =>
                      setQuickCommands((cmds) =>
                        cmds.map((c, j) => (j === i ? { ...c, target: e.target.value } : c)),
                      )
                    }
                  >
                    <option value="current">Current tab</option>
                    {(project.config.defaultTabs || []).map((t) => (
                      <option key={t.name} value={t.name}>{t.name}</option>
                    ))}
                  </select>
                  <button
                    className="default-tab-remove"
                    onClick={() => setQuickCommands((cmds) => cmds.filter((_, j) => j !== i))}
                    title="Remove command"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
            <button
              className="default-tab-add"
              onClick={() =>
                setQuickCommands((cmds) => [...cmds, { label: '', command: '', target: 'current' }])
              }
            >
              + Add Command
            </button>
          </div>

          <div className="project-edit-field">
            <label className="settings-label">Uploaded Files</label>
            <div className="project-edit-hint">
              Files dropped or pasted into the terminal land in <code>.tmp/shelf/</code>.
              Leftovers from previous sessions are auto-cleaned a few seconds after the
              project's first tab opens.
            </div>
            <button
              className="conn-btn conn-btn-cancel"
              onClick={handleClearUploads}
              disabled={clearDisabled}
              title={clearTooltip}
            >
              {clearing ? 'Clearing…' : 'Clear uploaded files'}
            </button>
          </div>
        </div>
        <div className="project-edit-footer">
          <button className="conn-btn conn-btn-cancel" onClick={handleClose}>Cancel</button>
          <button className="conn-btn conn-btn-next" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
