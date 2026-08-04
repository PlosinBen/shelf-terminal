export const CHANNEL_LOG = {
  MEMORY: 'mem',
  MEMORY_SUMMARY: 'mem-summary',
} as const;

export type ManagedChannelLog = typeof CHANNEL_LOG[keyof typeof CHANNEL_LOG];

export const CHANNEL_LOG_POLICY: Readonly<Record<ManagedChannelLog, { retentionDays: number }>> = {
  [CHANNEL_LOG.MEMORY]: { retentionDays: 30 },
  [CHANNEL_LOG.MEMORY_SUMMARY]: { retentionDays: 30 },
};
