import { SHELF_MCP_FAILURE, SHELF_MCP_STATE } from '@shared/shelf-mcp';
import { useAgentTab } from '../../agentTabStore';

const FAILURE_LABELS = {
  [SHELF_MCP_FAILURE.AUTHORIZATION]: 'Authorization failed',
  [SHELF_MCP_FAILURE.LISTENER]: 'Local endpoint could not start',
  [SHELF_MCP_FAILURE.STARTUP]: 'Startup failed',
} as const;

export function ShelfMcpBanner({ tabId }: { tabId: string }) {
  const status = useAgentTab(tabId)?.shelfMcpStatus;
  if (status?.state !== SHELF_MCP_STATE.UNAVAILABLE) return null;
  return (
    <div className="agent-shelf-mcp-banner" role="alert">
      Shelf tools are unavailable: {FAILURE_LABELS[status.reason]}. This Agent remains usable without Shelf tools.
      {' '}Reconnect the project to retry. Provider sign-in may still be required.
    </div>
  );
}
