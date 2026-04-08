import React, { useState, useEffect } from 'react';
import { useStore, setEditingProject, updateProjectConfig } from '../store';

export function ProjectEditPanel() {
  const { editingProjectIndex, projects } = useStore();
  const project = editingProjectIndex !== null ? projects[editingProjectIndex] : null;

  const [name, setName] = useState('');
  const [initScript, setInitScript] = useState('');

  useEffect(() => {
    if (project) {
      setName(project.config.name);
      setInitScript(project.config.initScript || '');
    }
  }, [editingProjectIndex]);

  if (!project || editingProjectIndex === null) return null;

  const handleClose = () => setEditingProject(null);

  const handleSave = () => {
    updateProjectConfig(editingProjectIndex, {
      name: name.trim() || project.config.name,
      initScript: initScript.trim() || undefined,
    });
    handleClose();
  };

  const handleOverlayClick = (e: React.MouseEvent) => {
    if (e.target === e.currentTarget) handleClose();
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
              Runs automatically when a new tab opens
            </div>
            <textarea
              className="project-edit-textarea"
              value={initScript}
              onChange={(e) => setInitScript(e.target.value)}
              placeholder="e.g. nvm use 22.22&#10;source .env"
              rows={5}
            />
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
