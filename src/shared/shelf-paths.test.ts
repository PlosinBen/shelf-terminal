import { describe, it, expect } from 'vitest';
import { shelfPlacement } from './shelf-paths';

describe('shelfPlacement', () => {
  it('maps mcp → home-relative .shelf/apps/<appId>/mcp-servers.json', () => {
    expect(shelfPlacement('mcp', { appId: 'app-123' })).toEqual({
      base: 'home',
      rel: '.shelf/apps/app-123/mcp-servers.json',
    });
  });

  it('throws when mcp is missing appId (closed allowlist guards context)', () => {
    expect(() => shelfPlacement('mcp', {})).toThrow(/appId/);
  });

  it('throws on an unknown type (closed allowlist)', () => {
    expect(() => shelfPlacement('bogus' as any, { appId: 'x' })).toThrow(/Unknown shelf file type/);
  });
});
