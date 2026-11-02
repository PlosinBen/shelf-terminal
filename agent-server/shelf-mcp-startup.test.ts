import { beforeEach, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { createServer, type Server } from 'node:http';
import { SHELF_MCP_FAILURE } from '@shared/shelf-mcp';
import { startShelfMcpServer } from './shelf-mcp';

vi.mock('node:http', async original => ({ ...await original<typeof import('node:http')>(), createServer: vi.fn() }));
beforeEach(() => vi.mocked(createServer).mockReset());

it('does not construct a listener when bootstrap is rejected', async () => {
  await expect(startShelfMcpServer(async () => { throw new Error('rejected'); })).rejects.toMatchObject({ reason: SHELF_MCP_FAILURE.AUTHORIZATION });
  expect(createServer).not.toHaveBeenCalled();
});

it('classifies an actual listener error separately from authorization failure', async () => {
  const error = Object.assign(new Error('bind denied'), { code: 'EACCES' });
  const server = Object.assign(new EventEmitter(), { listen: () => server.emit('error', error) });
  vi.mocked(createServer).mockReturnValue(server as unknown as Server);
  await expect(startShelfMcpServer(async () => ({ headers: {}, verifyAuthorization: () => false }))).rejects.toMatchObject({
    reason: SHELF_MCP_FAILURE.LISTENER, cause: error,
  });
  expect(createServer).toHaveBeenCalledTimes(1);
});
