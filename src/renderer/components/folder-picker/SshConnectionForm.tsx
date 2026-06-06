interface SshServer { host: string; port: number; user: string }

interface Props {
  host: string;
  port: string;
  user: string;
  password: string;
  connected: boolean;
  servers: SshServer[];
  onHostChange: (v: string) => void;
  onPortChange: (v: string) => void;
  onUserChange: (v: string) => void;
  onPasswordChange: (v: string) => void;
  onSelectServer: (server: SshServer) => void;
}

export function SshConnectionForm({
  host, port, user, password, connected, servers,
  onHostChange, onPortChange, onUserChange, onPasswordChange, onSelectServer,
}: Props) {
  return (
    <>
      {servers.length > 0 && (
        <div className="conn-server-list">
          <label className="conn-label">Servers</label>
          <div className="conn-server-items">
            {servers.map((s, i) => (
              <button
                key={i}
                type="button"
                className="conn-server-item"
                onClick={() => onSelectServer(s)}
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
          value={host}
          onChange={(e) => onHostChange(e.target.value)}
          placeholder="example.com"
          autoFocus
        />
      </div>
      <div className="conn-field">
        <label className="conn-label">Port</label>
        <input
          className="conn-input conn-input-short"
          type="text"
          value={port}
          onChange={(e) => onPortChange(e.target.value)}
          placeholder="22"
        />
      </div>
      <div className="conn-field">
        <label className="conn-label">User</label>
        <input
          className="conn-input"
          type="text"
          value={user}
          onChange={(e) => onUserChange(e.target.value)}
          placeholder="root"
        />
      </div>
      <div className="conn-field">
        <label className="conn-label">Password</label>
        <input
          className="conn-input"
          type="password"
          value={password}
          onChange={(e) => onPasswordChange(e.target.value)}
          placeholder="optional"
          disabled={connected}
        />
      </div>
      {connected && (
        <div className="conn-local-hint">Already connected, password not required.</div>
      )}
    </>
  );
}
