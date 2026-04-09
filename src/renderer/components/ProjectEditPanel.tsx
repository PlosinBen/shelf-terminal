import React, { useState, useEffect } from 'react';
import { useStore, setEditingProject, updateProjectConfig } from '../store';
import type { TabTemplate } from '../../shared/types';

export function ProjectEditPanel() {
  const { editingProjectIndex, projects } = useStore();
  const project = editingProjectIndex !== null ? projects[editingProjectIndex] : null;

  const [name, setName] = useState('');
  const [initScript, setInitScript] = useState('');
  const [defaultTabs, setDefaultTabs] = useState<TabTemplate[]>([]);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  useEffect(() => {
    if (project) {
      setName(project.config.name);
      setInitScript(project.config.initScript || '');
      setDefaultTabs(project.config.defaultTabs || [{ name: 'Terminal' }]);
    }
  }, [editingProjectIndex]);

  if (!project || editingProjectIndex === null) return null;

  const handleClose = () => setEditingProject(null);

  const handleSave = () => {
    const tabs = defaultTabs.filter((t) => t.name.trim());
    updateProjectConfig(editingProjectIndex, {
      name: name.trim() || project.config.name,
      initScript: initScript.trim() || undefined,
      defaultTabs: tabs.length > 0 ? tabs : undefined,
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

  const handleDragStart = (e: React.DragEvent, index: number) => {
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
                  onDragStart={(e) => handleDragStart(e, i)}
                  onDragOver={(e) => handleDragOver(e, i)}
                  onDrop={(e) => handleDrop(e, i)}
                  onDragEnd={handleDragEnd}
                >
                  <span className="default-tab-drag">⠿</span>
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
        </div>
        <div className="project-edit-footer">
          <button className="conn-btn conn-btn-cancel" onClick={handleClose}>Cancel</button>
          <button className="conn-btn conn-btn-next" onClick={handleSave}>Save</button>
        </div>
      </div>
    </div>
  );
}
