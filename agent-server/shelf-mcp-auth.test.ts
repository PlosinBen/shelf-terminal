import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { createShelfMcpAuthority } from '../src/main/agent/shelf-mcp-authority';
import { SHELF_MCP } from '@shared/shelf-mcp';
import { createShelfMcpAuthentication, requestShelfMcpAuthentication } from './shelf-mcp-auth';

const { callMainMock } = vi.hoisted(() => ({ callMainMock: vi.fn() }));
vi.mock('./app-tool-client', () => ({ callMain: callMainMock }));
afterEach(() => { vi.useRealTimers(); callMainMock.mockReset(); });

describe('Project signing authority and exec verification', () => {
  it('shares only the public key across a Project, never endpoint tokens', () => {
    const authority = createShelfMcpAuthority();
    const first = authority.authorize('p', 'a', randomUUID());
    const second = authority.authorize('p', 'b', randomUUID());
    expect(first.publicKey).toBe(second.publicKey);
    expect(first.token).not.toBe(second.token);
    expect(JSON.stringify(first)).not.toContain('PRIVATE');
    const verifier = createShelfMcpAuthentication(first, first.endpointId);
    expect(verifier.verifyAuthorization(`Bearer ${first.token}`)).toBe(true);
    expect(verifier.verifyAuthorization(`Bearer ${second.token}`)).toBe(false);
  });

  it('binds trusted Agent identity even if another Agent requests the same endpoint nonce', () => {
    const authority = createShelfMcpAuthority();
    const endpointId = randomUUID();
    const first = authority.authorize('p', 'a', endpointId);
    const second = authority.authorize('p', 'b', endpointId);
    expect(createShelfMcpAuthentication(first, endpointId).verifyAuthorization(`Bearer ${second.token}`)).toBe(false);
  });

  it('isolates Projects and App runs', () => {
    const authority = createShelfMcpAuthority();
    const endpointId = randomUUID();
    const first = authority.authorize('p', 'a', endpointId);
    for (const other of [authority.authorize('other', 'a', endpointId), createShelfMcpAuthority().authorize('p', 'a', endpointId)]) {
      expect(first.publicKey).not.toBe(other.publicKey);
      expect(createShelfMcpAuthentication(first, endpointId).verifyAuthorization(`Bearer ${other.token}`)).toBe(false);
    }
  });

  it('invalidates an old exec token when the endpoint is recreated', () => {
    const authority = createShelfMcpAuthority();
    const first = authority.authorize('p', 'a', randomUUID());
    const fresh = authority.authorize('p', 'a', randomUUID());
    expect(createShelfMcpAuthentication(fresh, fresh.endpointId).verifyAuthorization(`Bearer ${first.token}`)).toBe(false);
  });

  it.each([undefined, [], '', 'Basic abc', 'Bearer wrong', `Bearer ${'A'.repeat(86)}`, `Bearer ${'A'.repeat(86)}=`])('rejects malformed or forged credentials %j', value => {
    const grant = createShelfMcpAuthority().authorize('p', 'a', randomUUID());
    expect(createShelfMcpAuthentication(grant, grant.endpointId).verifyAuthorization(value)).toBe(false);
  });

  it('fails closed on tampered bootstrap scope or key', () => {
    const grant = createShelfMcpAuthority().authorize('p', 'a', randomUUID());
    expect(() => createShelfMcpAuthentication(grant, randomUUID())).toThrow();
    expect(() => createShelfMcpAuthentication({ ...grant, projectId: 'other' }, grant.endpointId)).toThrow();
    expect(() => createShelfMcpAuthentication({ ...grant, agentSessionId: 'other' }, grant.endpointId)).toThrow();
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
    expect(() => createShelfMcpAuthentication({ ...grant, publicKey: rsa.publicKey.export({ type: 'spki', format: 'pem' }).toString() }, grant.endpointId)).toThrow('Ed25519');
  });

  it('obtains only an endpoint-bound grant from the trusted bridge', async () => {
    const endpointId = randomUUID();
    const grant = createShelfMcpAuthority().authorize('p', 'a', endpointId);
    callMainMock.mockResolvedValue({ ok: true, data: grant });
    const auth = await requestShelfMcpAuthentication(endpointId);
    expect(callMainMock).toHaveBeenCalledExactlyOnceWith(SHELF_MCP.AUTHORIZE, { endpointId }, { requestId: `at-auth-${endpointId}`, timeoutMs: 10_000 });
    expect(auth.headers).toEqual({ Authorization: `Bearer ${grant.token}` });
  });

  it('fails closed if main rejects or sends malformed data', async () => {
    callMainMock.mockResolvedValueOnce({ ok: false, error: 'no Project' }).mockResolvedValueOnce({ ok: true, data: null });
    await expect(requestShelfMcpAuthentication(randomUUID())).rejects.toThrow('no Project');
    await expect(requestShelfMcpAuthentication(randomUUID())).rejects.toThrow('Invalid');
  });

  it('fails closed on an RPC timeout', async () => {
    callMainMock.mockResolvedValue({ ok: false, error: 'app-tool request timed out' });
    await expect(requestShelfMcpAuthentication(randomUUID(), 25)).rejects.toThrow('timed out');
  });
});
