interface Props {
  distro: string;
  distros: string[];
  onDistroChange: (v: string) => void;
}

export function WslConnectionForm({ distro, distros, onDistroChange }: Props) {
  return (
    <div className="conn-field">
      <label className="conn-label">Distro</label>
      {distros.length > 0 ? (
        <select
          className="settings-select"
          value={distro}
          onChange={(e) => onDistroChange(e.target.value)}
          autoFocus
        >
          {distros.map((d) => (
            <option key={d} value={d}>{d}</option>
          ))}
        </select>
      ) : (
        <span className="conn-local-hint">Loading distros...</span>
      )}
    </div>
  );
}
