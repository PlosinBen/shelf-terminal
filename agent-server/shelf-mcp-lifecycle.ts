import { SHELF_MCP_FAILURE, SHELF_MCP_STATE, type ShelfMcpEndpoint, type ShelfMcpFailure, type ShelfMcpStatus } from '@shared/shelf-mcp';

export class ShelfMcpStartupError extends Error {
  constructor(readonly reason: ShelfMcpFailure, cause: unknown) {
    super(`Shelf MCP ${reason} failed`, { cause });
  }
}

/** mcp#14 / failure-handling#1: degrade availability, never authentication. */
export function createShelfMcpLifecycle(deps: {
  start: () => Promise<ShelfMcpEndpoint>;
  report: (status: ShelfMcpStatus) => void;
  log: (message: string) => void;
}) {
  let endpoint: Promise<ShelfMcpEndpoint | null> | undefined;
  return {
    getEndpoint(): Promise<ShelfMcpEndpoint | null> {
      return endpoint ??= Promise.resolve().then(deps.start).then(handle => {
        deps.report({ state: SHELF_MCP_STATE.AVAILABLE });
        return handle;
      }, (error: unknown) => {
        const reason = error instanceof ShelfMcpStartupError ? error.reason : SHELF_MCP_FAILURE.STARTUP;
        // Arbitrary bootstrap error text may contain credentials. Log the
        // stage and known OS errno instead; neither contains the grant.
        const cause = error instanceof ShelfMcpStartupError ? error.cause : error;
        const code = (cause as { code?: unknown } | null)?.code;
        const errno = typeof code === 'string' && /^E[A-Z]+$/.test(code) ? ` (${code})` : '';
        deps.log(`Shelf MCP ${reason} failed${errno}; Shelf tools disabled for this exec`);
        deps.report({ state: SHELF_MCP_STATE.UNAVAILABLE, reason });
        return null;
      });
    },
  };
}
