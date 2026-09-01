import type { Connection } from '@shared/types';

/** Persisted connection method and parameters, without runtime target facts. */
export type ConnectorConfig = Readonly<Connection>;

export type ConnectorType = ConnectorConfig['type'];

export function toConnectorConfig(connection: Connection): ConnectorConfig {
  return Object.freeze({ ...connection }) as ConnectorConfig;
}
