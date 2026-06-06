import React, { useState, useEffect } from 'react';
import type { Connection } from '@shared/types';
import { ConnectionTypeButtons, type ConnType } from './ConnectionTypeButtons';
import { SshConnectionForm } from './SshConnectionForm';
import { WslConnectionForm } from './WslConnectionForm';
import { DockerConnectionForm } from './DockerConnectionForm';

export interface ConnectionStepProps {
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
  onSelect: (conn: Connection) => void;
  onCancel: () => void;
}

export function ConnectionStep({
  sshHost, sshPort, sshUser, sshPassword, wslDistro, dockerContainer,
  onSshHostChange, onSshPortChange, onSshUserChange, onSshPasswordChange, onWslDistroChange, onDockerContainerChange,
  onSelect, onCancel,
}: ConnectionStepProps) {
  const [connType, setConnType] = useState<ConnType>('local');
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
      <ConnectionTypeButtons connType={connType} availableTypes={availableTypes} onTypeChange={setConnType} />

      <div className="conn-form-body">
        {connType === 'ssh' && (
          <SshConnectionForm
            host={sshHost}
            port={sshPort}
            user={sshUser}
            password={sshPassword}
            connected={sshConnected}
            servers={sshServers}
            onHostChange={onSshHostChange}
            onPortChange={onSshPortChange}
            onUserChange={onSshUserChange}
            onPasswordChange={onSshPasswordChange}
            onSelectServer={handleSelectServer}
          />
        )}

        {connType === 'wsl' && (
          <WslConnectionForm distro={wslDistro} distros={wslDistros} onDistroChange={onWslDistroChange} />
        )}

        {connType === 'docker' && (
          <DockerConnectionForm
            container={dockerContainer}
            containers={dockerContainers}
            onContainerChange={onDockerContainerChange}
            onRefresh={refreshDockerContainers}
          />
        )}

        {connType === 'local' && (
          <div className="conn-local-hint">
            Browse local filesystem to select a project folder.
          </div>
        )}
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
