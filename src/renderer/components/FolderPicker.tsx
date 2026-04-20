import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useStore } from '../store';
import { FolderBrowser } from './FolderBrowser';
import { on, emit, Events } from '../events';
import type { ProjectConfig, Connection, SSHConnection, AgentProvider } from '@shared/types';
import { VISIBLE_AGENT_PROVIDERS } from '@shared/agent-providers';

type Step = 'connection' | 'browse';

export function FolderPicker() {
  const { settings } = useStore();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<Step>('connection');
  const [connection, setConnection] = useState<Connection>({ type: 'local' });

  // SSH form state
  const [sshHost, setSshHost] = useState('');
  const [sshPort, setSshPort] = useState('22');
  const [sshUser, setSshUser] = useState('');
  const [sshPassword, setSshPassword] = useState('');

  // WSL form state
  const [wslDistro, setWslDistro] = useState('Ubuntu');

  // Docker form state
  const [dockerContainer, setDockerContainer] = useState('');

  // Agent provider state
  const [defaultAgentProvider, setDefaultAgentProvider] = useState<AgentProvider | ''>('');
  const [openAgentOnConnect, setOpenAgentOnConnect] = useState(true);

  // Browse state
  const [currentPath, setCurrentPath] = useState('');
  const [entries, setEntries] = useState<string[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [filter, setFilter] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const listRef = useRef<HTMLDivElement>(null);
  const entriesRef = useRef<string[]>([]);
  entriesRef.current = entries;
  const selectedIndexRef = useRef(selectedIndex);
  selectedIndexRef.current = selectedIndex;
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;
  const connectionRef = useRef(connection);
  connectionRef.current = connection;

  // ── Jump-to-match on filter change ──
  useEffect(() => {
    if (!filter) return;
    const lowerFilter = filter.toLowerCase();
    const prefixIndex = entries.findIndex((name) => name.toLowerCase().startsWith(lowerFilter));
    if (prefixIndex !== -1) {
      setSelectedIndex(prefixIndex);
      return;
    }
    const substringIndex = entries.findIndex((name) => name.toLowerCase().includes(lowerFilter));
    if (substringIndex !== -1) {
      setSelectedIndex(substringIndex);
    }
  }, [filter, entries]);

  // ── Folder loading ──
  const requestFolder = useCallback(async (dirPath: string) => {
    setLoading(true);
    setError(null);
    setFilter('');
    setSelectedIndex(0);

    try {
      const result = await window.shelfApi.connector.listDir(connectionRef.current, dirPath);
      setCurrentPath(result.path);
      setEntries(result.entries);
      setError(result.error ?? null);
    } catch {
      setError('Failed to list folders');
    } finally {
      setLoading(false);
    }
  }, []);

  const goUp = useCallback(() => {
    const parent = currentPathRef.current.replace(/\/[^/]+\/?$/, '') || '/';
    if (parent !== currentPathRef.current) {
      requestFolder(parent);
    }
  }, [requestFolder]);

  // ── Open handler ──
  useEffect(() => {
    const handler = () => {
      setOpen(true);
      setStep('connection');
      setConnection({ type: 'local' });
      setSshHost('');
      setSshPort('22');
      setSshUser('');
      setSshPassword('');
      setWslDistro('Ubuntu');
      setDockerContainer('');
      setDefaultAgentProvider('');
      setOpenAgentOnConnect(true);
    };
    const off = on(Events.OPEN_FOLDER_PICKER, handler);
    return () => { off(); };
  }, []);

  // ── Scroll selected into view ──
  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const item = list.children[selectedIndex + 1] as HTMLElement | undefined;
    item?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  // ── Proceed from connection step to browse ──
  const proceedToBrowse = async (conn: Connection) => {
    setConnection(conn);
    connectionRef.current = conn;
    setStep('browse');

    // Establish connection if needed (e.g. SSH with password)
    if (conn.type === 'ssh' && conn.password) {
      try {
        await window.shelfApi.connector.connect(conn, conn.password);
      } catch {
        setError('SSH authentication failed');
        setStep('connection');
        return;
      }
    }

    let startPath: string | undefined;
    if (conn.type === 'local' && settings.defaultLocalPath) {
      const result = await window.shelfApi.connector.listDir(conn, settings.defaultLocalPath);
      if (!result.error) startPath = settings.defaultLocalPath;
    }
    if (!startPath) {
      startPath = await window.shelfApi.connector.homePath(conn);
    }
    requestFolder(startPath);
  };

  // ── Select and close ──
  const handleSelect = async () => {
    const entry = entriesRef.current[selectedIndexRef.current];
    const selectedPath = entry
      ? `${currentPathRef.current}/${entry}`
      : currentPathRef.current;

    const folderName = selectedPath.split('/').filter(Boolean).pop() || 'project';
    const conn = connectionRef.current;

    let displayName = folderName;
    if (conn.type === 'ssh') {
      displayName = `${conn.user}@${conn.host}:${folderName}`;
    } else if (conn.type === 'wsl') {
      displayName = `[WSL] ${folderName}`;
    }

    const config: ProjectConfig = {
      id: `proj-${Date.now()}`,
      name: displayName,
      cwd: selectedPath,
      connection: conn,
      maxTabs: settings.defaultMaxTabs,
      defaultAgentProvider: defaultAgentProvider || undefined,
      openAgentOnConnect,
    };

    emit(Events.ADD_PROJECT, config);
    setOpen(false);
  };

  const handleCancel = () => setOpen(false);

  // ── Keyboard navigation (browse step only) ──
  useEffect(() => {
    if (!open || step !== 'browse') return;

    const handler = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'ArrowUp':
          e.preventDefault();
          setSelectedIndex((i) => Math.max(-1, i - 1));
          break;
        case 'ArrowDown':
          e.preventDefault();
          setSelectedIndex((i) => Math.min(entriesRef.current.length - 1, i + 1));
          break;
        case 'ArrowRight': {
          e.preventDefault();
          if (selectedIndexRef.current === -1) {
            goUp();
            return;
          }
          const entry = entriesRef.current[selectedIndexRef.current];
          if (entry) requestFolder(currentPathRef.current + '/' + entry);
          break;
        }
        case 'ArrowLeft':
          e.preventDefault();
          goUp();
          break;
        case 'Enter':
          e.preventDefault();
          if (e.metaKey || e.ctrlKey) {
            // Cmd+Enter (macOS) / Ctrl+Enter (Win/Linux): confirm selection
            handleSelect();
          } else if (selectedIndexRef.current === -1) {
            goUp();
          } else {
            // Enter: navigate into selected folder
            const entry = entriesRef.current[selectedIndexRef.current];
            if (entry) requestFolder(currentPathRef.current + '/' + entry);
          }
          break;
        case 'Escape':
          e.preventDefault();
          handleCancel();
          break;
        case 'Backspace':
          e.preventDefault();
          setFilter((f) => f.slice(0, -1));
          break;
        default:
          if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
            e.preventDefault();
            setFilter((f) => f + e.key);
          }
          break;
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, step, goUp, requestFolder]);

  // Escape on connection step
  useEffect(() => {
    if (!open || step !== 'connection') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleCancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, step]);

  if (!open) return null;

  return (
    <div className="folder-picker-overlay" onMouseDown={(e) => {
      if (e.target === e.currentTarget) handleCancel();
    }}>
      <div className="folder-picker">
        <div className="fp-header">
          {step === 'connection' ? 'New Project — Connection' : 'Open Project'}
        </div>

        {step === 'connection' ? (
          <ConnectionStep
            sshHost={sshHost}
            sshPort={sshPort}
            sshUser={sshUser}
            sshPassword={sshPassword}
            wslDistro={wslDistro}
            onSshHostChange={setSshHost}
            onSshPortChange={setSshPort}
            onSshUserChange={setSshUser}
            onSshPasswordChange={setSshPassword}
            onWslDistroChange={setWslDistro}
            dockerContainer={dockerContainer}
            onDockerContainerChange={setDockerContainer}
            defaultAgentProvider={defaultAgentProvider}
            onAgentProviderChange={setDefaultAgentProvider}
            openAgentOnConnect={openAgentOnConnect}
            onOpenAgentOnConnectChange={setOpenAgentOnConnect}
            onSelect={proceedToBrowse}
            onCancel={handleCancel}
          />
        ) : (
          <FolderBrowser
            currentPath={currentPath}
            entries={entries}
            selectedIndex={selectedIndex}
            filter={filter}
            loading={loading}
            error={error}
            listRef={listRef}
            onSelectIndex={setSelectedIndex}
            onNavigate={requestFolder}
            onGoUp={goUp}
          />
        )}
      </div>
    </div>
  );
}

// ── Connection Step sub-component ──

interface ConnectionStepProps {
  sshHost: string;
  sshPort: string;
  sshUser: string;
  sshPassword: string;
  wslDistro: string;
  dockerContainer: string;
  onSshHostChange: (v: string) => void;
  onSshPortChange: (v: string) => void;
  onSshUserChange: (v: string) => void;
  onSshPasswordChange: (v: string) => void;
  onWslDistroChange: (v: string) => void;
  onDockerContainerChange: (v: string) => void;
  defaultAgentProvider: AgentProvider | '';
  onAgentProviderChange: (v: AgentProvider | '') => void;
  openAgentOnConnect: boolean;
  onOpenAgentOnConnectChange: (v: boolean) => void;
  onSelect: (conn: Connection) => void;
  onCancel: () => void;
}

function ConnectionStep({
  sshHost, sshPort, sshUser, sshPassword, wslDistro, dockerContainer,
  onSshHostChange, onSshPortChange, onSshUserChange, onSshPasswordChange, onWslDistroChange, onDockerContainerChange,
  defaultAgentProvider, onAgentProviderChange,
  openAgentOnConnect, onOpenAgentOnConnectChange,
  onSelect, onCancel,
}: ConnectionStepProps) {
  const [connType, setConnType] = useState<'local' | 'ssh' | 'wsl' | 'docker'>('local');
  const [availableTypes, setAvailableTypes] = useState<string[]>(['local', 'ssh', 'docker']);
  const [wslDistros, setWslDistros] = useState<string[]>([]);
  const [dockerContainers, setDockerContainers] = useState<string[]>([]);
  const [sshConnected, setSshConnected] = useState(false);
  const [sshServers, setSshServers] = useState<Array<{ host: string; port: number; user: string }>>([]);

  // Fetch available connection types from main process
  useEffect(() => {
    window.shelfApi.connector.availableTypes().then(setAvailableTypes);
  }, []);

  // Fetch SSH server history when SSH tab is selected
  useEffect(() => {
    if (connType === 'ssh') {
      window.shelfApi.ssh.servers().then(setSshServers);
    }
  }, [connType]);

  useEffect(() => {
    if (connType === 'wsl' && wslDistros.length === 0) {
      window.shelfApi.wsl.listDistros().then((list) => {
        setWslDistros(list);
        if (list.length > 0 && !wslDistro) onWslDistroChange(list[0]);
      });
    }
    if (connType === 'docker') {
      refreshDockerContainers();
    }
  }, [connType]);

  const refreshDockerContainers = () => {
    window.shelfApi.docker.listContainers().then((list) => {
      setDockerContainers(list);
      if (list.length > 0 && !dockerContainer) onDockerContainerChange(list[0]);
    });
  };

  // Check if SSH connection already exists
  useEffect(() => {
    if (connType !== 'ssh' || !sshHost || !sshUser) {
      setSshConnected(false);
      return;
    }
    const port = Number(sshPort) || 22;
    const conn = { type: 'ssh' as const, host: sshHost, port, user: sshUser };
    window.shelfApi.connector.isConnected(conn).then(setSshConnected);
  }, [connType, sshHost, sshPort, sshUser]);

  const handleSelectServer = (server: { host: string; port: number; user: string }) => {
    onSshHostChange(server.host);
    onSshPortChange(String(server.port));
    onSshUserChange(server.user);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (connType === 'local') {
      onSelect({ type: 'local' });
    } else if (connType === 'ssh') {
      if (!sshHost || !sshUser) return;
      onSelect({ type: 'ssh', host: sshHost, port: Number(sshPort) || 22, user: sshUser, password: sshConnected ? undefined : sshPassword || undefined });
    } else if (connType === 'wsl') {
      onSelect({ type: 'wsl', distro: wslDistro || 'Ubuntu' });
    } else if (connType === 'docker') {
      if (!dockerContainer) return;
      onSelect({ type: 'docker', container: dockerContainer });
    }
  };

  return (
    <form className="conn-step" onSubmit={handleSubmit}>
      <div className="conn-type-buttons">
        {availableTypes.includes('local') && (
          <button
            type="button"
            className={`conn-type-btn ${connType === 'local' ? 'active' : ''}`}
            onClick={() => setConnType('local')}
          >
            Local
          </button>
        )}
        {availableTypes.includes('ssh') && (
          <button
            type="button"
            className={`conn-type-btn ${connType === 'ssh' ? 'active' : ''}`}
            onClick={() => setConnType('ssh')}
          >
            SSH
          </button>
        )}
        {availableTypes.includes('docker') && (
          <button
            type="button"
            className={`conn-type-btn ${connType === 'docker' ? 'active' : ''}`}
            onClick={() => setConnType('docker')}
          >
            Docker
          </button>
        )}
        {availableTypes.includes('wsl') && (
          <button
            type="button"
            className={`conn-type-btn ${connType === 'wsl' ? 'active' : ''}`}
            onClick={() => setConnType('wsl')}
          >
            WSL
          </button>
        )}
      </div>

      <div className="conn-form-body">
        {connType === 'ssh' && (
          <>
            {sshServers.length > 0 && (
              <div className="conn-server-list">
                <label className="conn-label">Servers</label>
                <div className="conn-server-items">
                  {sshServers.map((s, i) => (
                    <button
                      key={i}
                      type="button"
                      className="conn-server-item"
                      onClick={() => handleSelectServer(s)}
                    >
                      {s.user}@{s.host}{s.port !== 22 ? `:${s.port}` : ''}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className="conn-field">
              <label className="conn-label">Host</label>
              <input
                className="conn-input"
                type="text"
                value={sshHost}
                onChange={(e) => onSshHostChange(e.target.value)}
                placeholder="example.com"
                autoFocus
              />
            </div>
            <div className="conn-field">
              <label className="conn-label">Port</label>
              <input
                className="conn-input conn-input-short"
                type="text"
                value={sshPort}
                onChange={(e) => onSshPortChange(e.target.value)}
                placeholder="22"
              />
            </div>
            <div className="conn-field">
              <label className="conn-label">User</label>
              <input
                className="conn-input"
                type="text"
                value={sshUser}
                onChange={(e) => onSshUserChange(e.target.value)}
                placeholder="root"
              />
            </div>
            <div className="conn-field">
              <label className="conn-label">Password</label>
              <input
                className="conn-input"
                type="password"
                value={sshPassword}
                onChange={(e) => onSshPasswordChange(e.target.value)}
                placeholder="optional"
                disabled={sshConnected}
              />
            </div>
            {sshConnected && (
              <div className="conn-local-hint">Already connected, password not required.</div>
            )}
          </>
        )}

        {connType === 'wsl' && (
          <div className="conn-field">
            <label className="conn-label">Distro</label>
            {wslDistros.length > 0 ? (
              <select
                className="settings-select"
                value={wslDistro}
                onChange={(e) => onWslDistroChange(e.target.value)}
                autoFocus
              >
                {wslDistros.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            ) : (
              <span className="conn-local-hint">Loading distros...</span>
            )}
          </div>
        )}

        {connType === 'docker' && (
          <div className="conn-field">
            <label className="conn-label">Container</label>
            <div className="conn-docker-row">
              {dockerContainers.length > 0 ? (
                <select
                  className="settings-select"
                  value={dockerContainer}
                  onChange={(e) => onDockerContainerChange(e.target.value)}
                  autoFocus
                >
                  {dockerContainers.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              ) : (
                <span className="conn-local-hint">No running containers found.</span>
              )}
              <button
                type="button"
                className="conn-refresh-btn"
                onClick={refreshDockerContainers}
                title="Refresh container list"
              >
                &#x21bb;
              </button>
            </div>
          </div>
        )}

        {connType === 'local' && (
          <div className="conn-local-hint">
            Browse local filesystem to select a project folder.
          </div>
        )}

        <div className="conn-field">
          <label className="conn-label">Default Agent</label>
          <select
            className="settings-select"
            value={defaultAgentProvider}
            onChange={(e) => onAgentProviderChange(e.target.value as AgentProvider | '')}
          >
            <option value="">None</option>
            {VISIBLE_AGENT_PROVIDERS.map((p) => (
              <option key={p.id} value={p.id}>{p.label}</option>
            ))}
          </select>
        </div>

        <div className="conn-field">
          <label className="settings-checkbox-label">
            <input
              type="checkbox"
              checked={openAgentOnConnect}
              onChange={(e) => onOpenAgentOnConnectChange(e.target.checked)}
            />
            Open agent tab on connect
          </label>
        </div>
      </div>

      <div className="conn-actions">
        <button type="button" className="conn-btn conn-btn-cancel" onClick={onCancel}>
          Cancel
        </button>
        <button type="submit" className="conn-btn conn-btn-next">
          Next
        </button>
      </div>
    </form>
  );
}
