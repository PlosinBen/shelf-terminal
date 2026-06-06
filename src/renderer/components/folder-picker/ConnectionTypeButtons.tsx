export type ConnType = 'local' | 'ssh' | 'wsl' | 'docker';

interface Props {
  connType: ConnType;
  availableTypes: string[];
  onTypeChange: (type: ConnType) => void;
}

export function ConnectionTypeButtons({ connType, availableTypes, onTypeChange }: Props) {
  return (
    <div className="conn-type-buttons">
      {availableTypes.includes('local') && (
        <button
          type="button"
          className={`conn-type-btn ${connType === 'local' ? 'active' : ''}`}
          onClick={() => onTypeChange('local')}
        >
          Local
        </button>
      )}
      {availableTypes.includes('ssh') && (
        <button
          type="button"
          className={`conn-type-btn ${connType === 'ssh' ? 'active' : ''}`}
          onClick={() => onTypeChange('ssh')}
        >
          SSH
        </button>
      )}
      {availableTypes.includes('docker') && (
        <button
          type="button"
          className={`conn-type-btn ${connType === 'docker' ? 'active' : ''}`}
          onClick={() => onTypeChange('docker')}
        >
          Docker
        </button>
      )}
      {availableTypes.includes('wsl') && (
        <button
          type="button"
          className={`conn-type-btn ${connType === 'wsl' ? 'active' : ''}`}
          onClick={() => onTypeChange('wsl')}
        >
          WSL
        </button>
      )}
    </div>
  );
}
