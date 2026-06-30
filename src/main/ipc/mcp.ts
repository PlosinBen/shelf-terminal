import { ipcMain } from 'electron';
import { IPC } from '@shared/ipc-channels';
import type { McpServerBlock } from '@shared/mcp';
import {
  listMcpServers, getMcpServer, addMcpServer, updateMcpServer, removeMcpServer,
} from '../mcp-store';
import { onMcpChanged } from '../mcp-sync';

// The manager UI is one TRIGGER of an MCP config mutation. Every write funnels
// into the single onMcpChanged() pipeline (re-project locally, run subscribers,
// notify the renderer) so the after-effects live in one place — sibling to
// ipc/skills.ts. Best-effort: the store write already succeeded.

export function registerMcpHandlers(): void {
  ipcMain.handle(IPC.MCP_LIST, async () => {
    return listMcpServers();
  });

  ipcMain.handle(IPC.MCP_GET, async (_event, name: string) => {
    return getMcpServer(name);
  });

  ipcMain.handle(IPC.MCP_ADD, async (_event, payload: { name: string; block: McpServerBlock }) => {
    const res = addMcpServer(payload.name, payload.block);
    if (res.ok) onMcpChanged();
    return res;
  });

  ipcMain.handle(IPC.MCP_UPDATE, async (_event, payload: { name: string; block: McpServerBlock; nextName?: string }) => {
    const res = updateMcpServer(payload.name, payload.block, payload.nextName);
    if (res.ok) onMcpChanged();
    return res;
  });

  ipcMain.handle(IPC.MCP_REMOVE, async (_event, name: string) => {
    removeMcpServer(name);
    onMcpChanged();
  });
}
