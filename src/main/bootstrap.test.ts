import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let tempDir: string;
const exit = vi.fn();

vi.mock('electron', () => ({
  app: {
    getPath: () => tempDir,
    exit,
  },
  dialog: { showMessageBoxSync: vi.fn(() => 0) },
}));
vi.mock('./project-storage', () => ({ removeProjectStorage: vi.fn(async () => {}) }));
vi.mock('./secret-store', () => ({ deleteProjectSecrets: vi.fn() }));

const { bootstrap } = await import('./bootstrap');

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shelf-bootstrap-'));
  exit.mockReset();
  delete process.env.SHELF_BOOTSTRAP_DIALOG_RESPONSE;
});

afterEach(() => {
  delete process.env.SHELF_BOOTSTRAP_DIALOG_RESPONSE;
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('project repository bootstrap', () => {
  it('loads legacy config without writing migration output', async () => {
    const filePath = path.join(tempDir, 'projects.json');
    const legacy = [{
      id: 'legacy',
      name: 'Legacy',
      cwd: '/repo/legacy',
      connection: { type: 'local' },
      maxTabs: 5,
    }];
    fs.writeFileSync(filePath, JSON.stringify(legacy));

    const result = bootstrap();

    expect(result.projectsRepository.getAll()).toMatchObject([{ id: 'legacy', initScript: null }]);
    expect(JSON.parse(fs.readFileSync(filePath, 'utf8'))).toEqual(legacy);
  });

  it('backs up invalid config before continuing with an empty repository', async () => {
    const filePath = path.join(tempDir, 'projects.json');
    fs.writeFileSync(filePath, '{');
    process.env.SHELF_BOOTSTRAP_DIALOG_RESPONSE = 'continue';

    const result = bootstrap();

    expect(result.projectsRepository.getAll()).toEqual([]);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(fs.readdirSync(tempDir).some((name) => name.startsWith('projects.json.corrupt.'))).toBe(true);
  });

  it('leaves invalid config untouched when bootstrap chooses Quit', async () => {
    const filePath = path.join(tempDir, 'projects.json');
    fs.writeFileSync(filePath, '{');
    process.env.SHELF_BOOTSTRAP_DIALOG_RESPONSE = 'quit';

    expect(() => bootstrap()).toThrow('app exiting');

    expect(exit).toHaveBeenCalledWith(0);
    expect(fs.readFileSync(filePath, 'utf8')).toBe('{');
  });
});
