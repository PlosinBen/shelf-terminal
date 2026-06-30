import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { McpServerBlock } from '@shared/mcp';

// Capture the handlers registered via ipcMain.handle so we can invoke them.
const handlers = new Map<string, (...a: any[]) => any>();
vi.mock('electron', () => ({
  ipcMain: { handle: (ch: string, fn: (...a: any[]) => any) => handlers.set(ch, fn) },
}));

const addMcpServer = vi.fn();
const updateMcpServer = vi.fn();
const removeMcpServer = vi.fn();
vi.mock('../mcp-store', () => ({
  listMcpServers: vi.fn(() => []),
  getMcpServer: vi.fn(),
  addMcpServer: (...a: unknown[]) => addMcpServer(...a),
  updateMcpServer: (...a: unknown[]) => updateMcpServer(...a),
  removeMcpServer: (...a: unknown[]) => removeMcpServer(...a),
}));

const onMcpChanged = vi.fn();
vi.mock('../mcp-sync', () => ({
  onMcpChanged: () => onMcpChanged(),
}));

const { registerMcpHandlers } = await import('./mcp');
const { IPC } = await import('@shared/ipc-channels');

const block: McpServerBlock = { type: 'stdio', command: 'node' };

beforeEach(() => {
  handlers.clear();
  addMcpServer.mockReset();
  updateMcpServer.mockReset();
  removeMcpServer.mockReset();
  onMcpChanged.mockReset();
  registerMcpHandlers();
});

describe('MCP mutation handlers run the onMcpChanged pipeline on success', () => {
  it('MCP_ADD fires onMcpChanged when the store accepts', async () => {
    addMcpServer.mockReturnValue({ ok: true, name: 'a' });
    const res = await handlers.get(IPC.MCP_ADD)!({}, { name: 'a', block });
    expect(addMcpServer).toHaveBeenCalledWith('a', block);
    expect(res.ok).toBe(true);
    expect(onMcpChanged).toHaveBeenCalledTimes(1);
  });

  it('MCP_ADD does NOT fire onMcpChanged when the store rejects', async () => {
    addMcpServer.mockReturnValue({ ok: false, error: 'dup' });
    await handlers.get(IPC.MCP_ADD)!({}, { name: 'a', block });
    expect(onMcpChanged).not.toHaveBeenCalled();
  });

  it('MCP_UPDATE passes name+block+nextName and fires on success', async () => {
    updateMcpServer.mockReturnValue({ ok: true, name: 'b' });
    await handlers.get(IPC.MCP_UPDATE)!({}, { name: 'a', block, nextName: 'b' });
    expect(updateMcpServer).toHaveBeenCalledWith('a', block, 'b');
    expect(onMcpChanged).toHaveBeenCalledTimes(1);
  });

  it('MCP_REMOVE always fires onMcpChanged', async () => {
    await handlers.get(IPC.MCP_REMOVE)!({}, 'a');
    expect(removeMcpServer).toHaveBeenCalledWith('a');
    expect(onMcpChanged).toHaveBeenCalledTimes(1);
  });
});
