interface Props {
  container: string;
  containers: string[];
  onContainerChange: (v: string) => void;
  onRefresh: () => void;
}

export function DockerConnectionForm({ container, containers, onContainerChange, onRefresh }: Props) {
  return (
    <div className="conn-field">
      <label className="conn-label">Container</label>
      <div className="conn-docker-row">
        {containers.length > 0 ? (
          <select
            className="settings-select"
            value={container}
            onChange={(e) => onContainerChange(e.target.value)}
            autoFocus
          >
            {containers.map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
        ) : (
          <span className="conn-local-hint">No running containers found.</span>
        )}
        <button
          type="button"
          className="conn-refresh-btn"
          onClick={onRefresh}
          title="Refresh container list"
        >
          &#x21bb;
        </button>
      </div>
    </div>
  );
}
