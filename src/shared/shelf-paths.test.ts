import { describe, it, expect } from 'vitest';
import {
  shelfPlacement,
  ShelfFileTypeMcp,
  ShelfFileTypeSkill,
  ShelfFileTypeUpload,
  ShelfFileTypeTest,
  SHELF_UPLOAD_DIR_REL,
} from './shelf-paths';

describe('shelfPlacement', () => {
  it('maps mcp → home-relative .shelf/apps/<appId>/mcp-servers.json', () => {
    expect(shelfPlacement(ShelfFileTypeMcp, { appId: 'app-123' })).toEqual({
      base: 'home',
      rel: '.shelf/apps/app-123/mcp-servers.json',
    });
  });

  it('throws when mcp is missing appId (closed allowlist guards context)', () => {
    expect(() => shelfPlacement(ShelfFileTypeMcp, {})).toThrow(/appId/);
  });

  it('maps skill → home-relative .shelf/apps/<appId>/skills (a directory rel)', () => {
    expect(shelfPlacement(ShelfFileTypeSkill, { appId: 'app-123' })).toEqual({
      base: 'home',
      rel: '.shelf/apps/app-123/skills',
    });
  });

  it('throws when skill is missing appId (closed allowlist guards context)', () => {
    expect(() => shelfPlacement(ShelfFileTypeSkill, {})).toThrow(/appId/);
  });

  it('maps upload → cwd-relative .tmp/shelf/<name> (single-source dir)', () => {
    expect(shelfPlacement(ShelfFileTypeUpload, { cwd: '/proj', name: 'abc123-paste.png' })).toEqual({
      base: 'cwd',
      rel: `${SHELF_UPLOAD_DIR_REL}/abc123-paste.png`,
    });
  });

  it('throws when upload is missing name (closed allowlist guards context)', () => {
    expect(() => shelfPlacement(ShelfFileTypeUpload, { cwd: '/proj' })).toThrow(/name/);
  });

  it('maps the verification-only `test` type to a neutral home-relative path', () => {
    expect(shelfPlacement(ShelfFileTypeTest, {})).toEqual({ base: 'home', rel: '.shelf/test/transport-check' });
  });

  it('throws on an unknown type (closed allowlist)', () => {
    expect(() => shelfPlacement('bogus' as any, { appId: 'x' })).toThrow(/Unknown shelf file type/);
  });
});
