import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

let tmpDir: string;

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
  },
}));

// Import after the mock so projectDir() picks up the mocked userData path.
const { isGranted, grant, revoke, listGrants, listAllGrants } = await import('./web-grants');

const KIBANA = 'https://kibana.corp.com';
const ARGOCD = 'https://argocd.corp.com';

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-web-grants-'));
});

afterEach(() => {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('web-grants', () => {
  it('returns false / empty before anything is granted', () => {
    expect(isGranted('p1', KIBANA)).toBe(false);
    expect(listGrants('p1')).toEqual([]);
  });

  it('grants and reads back per origin', () => {
    grant('p1', KIBANA);
    expect(isGranted('p1', KIBANA)).toBe(true);
    expect(isGranted('p1', ARGOCD)).toBe(false);
    expect(listGrants('p1')).toEqual([KIBANA]);
  });

  it('is scoped per project (no cross-project leak)', () => {
    grant('p1', KIBANA);
    expect(isGranted('p2', KIBANA)).toBe(false);
    expect(listGrants('p2')).toEqual([]);
  });

  it('is idempotent — granting twice keeps one entry', () => {
    grant('p1', KIBANA);
    grant('p1', KIBANA);
    expect(listGrants('p1')).toEqual([KIBANA]);
  });

  it('revokes a single origin without touching others', () => {
    grant('p1', KIBANA);
    grant('p1', ARGOCD);
    revoke('p1', KIBANA);
    expect(isGranted('p1', KIBANA)).toBe(false);
    expect(isGranted('p1', ARGOCD)).toBe(true);
  });

  it('persists across calls (separate reads see prior writes)', () => {
    grant('p1', KIBANA);
    // Fresh read path — simulates a later process/agent turn.
    expect(listGrants('p1')).toEqual([KIBANA]);
  });

  it('lists all projects with grants, skipping empty ones', () => {
    grant('p1', KIBANA);
    grant('p1', ARGOCD);
    grant('p2', KIBANA);
    grant('p3', ARGOCD);
    revoke('p3', ARGOCD); // p3 now empty → excluded
    const all = listAllGrants();
    expect(all).toEqual({
      p1: [ARGOCD, KIBANA], // writeGrants sorts
      p2: [KIBANA],
    });
  });

  it('returns empty when no projects have grants', () => {
    expect(listAllGrants()).toEqual({});
  });

  it('treats a corrupt grants file as no grants', () => {
    fs.mkdirSync(path.join(tmpDir, 'projects', 'p1'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'projects', 'p1', 'web-grants.json'), 'not json', 'utf-8');
    expect(isGranted('p1', KIBANA)).toBe(false);
    expect(listGrants('p1')).toEqual([]);
  });
});
