import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import simpleGit, { type SimpleGit } from 'simple-git';
import { log } from '@shared/logger';
import { BACKUP_BRANCH_PREFIX } from '@shared/config-backup';

/**
 * Side-car git repo — the transport + durable store for config backup.
 *
 * git ONLY ever operates here, on a separate clone under `<userData>`; it never
 * wraps the live config folders (live is never a git repo — Backup/Import are
 * plain file copies between live and this working tree). Because each machine
 * writes ONLY its own `backup/<app-instance-id>` branch, every push is a
 * fast-forward: no merge, no conflict engine, no baseline.
 *
 * This module is pure git plumbing. WHAT lives in the working tree (how skills /
 * MCP map onto paths) is decided by the Backup/Import layers, not here.
 *
 * All operations fail-loud: simple-git rejects on any git error and we let it
 * propagate. The `git`-present / auth preflight runs before these (see
 * preflight.ts), so reaching here means git exists.
 */

const CLONE_DIR_NAME = 'config-backup-repo';

/** Local commit identity, so a machine with no global git user still commits. */
const COMMIT_NAME = 'Shelf Config Backup';
const COMMIT_EMAIL = 'config-backup@shelf.local';

function cloneDir(): string {
  return path.join(app.getPath('userData'), CLONE_DIR_NAME);
}

/** A remote-tracking backup branch discovered via `listBackupBranches()`. */
export interface BackupBranchRef {
  /** Readable git ref, e.g. `origin/backup/<id>` — pass to read/list ops. */
  ref: string;
  /** Local branch name, e.g. `backup/<id>`. */
  branch: string;
  /** The owning machine's app-instance-id (the `<id>` segment). */
  appInstanceId: string;
}

export interface SideCar {
  /** The clone directory (Backup/Import copy files in/out of here). */
  readonly dir: string;
  /** Clone the remote if absent, else reuse; (re)point origin + set identity. */
  ensureClone(remoteUrl: string): Promise<void>;
  /** Fetch all remote branches (prune deleted ones). */
  fetch(): Promise<void>;
  /** Create-or-switch to a local branch, tracking origin when it already exists. */
  checkoutBranch(branch: string): Promise<void>;
  /** Stage everything (incl. deletions) and commit. Returns false if nothing changed. */
  stageAllAndCommit(message: string): Promise<boolean>;
  /** Push a local branch to origin (fast-forward — only this machine writes it). */
  push(branch: string): Promise<void>;
  /** Remote-tracking backup branches (all machines, incl. this one). */
  listBackupBranches(): Promise<BackupBranchRef[]>;
  /** File paths present at a ref (`git ls-tree -r --name-only`). */
  listFilesAtRef(ref: string): Promise<string[]>;
  /** File content at a ref, or null if the path does not exist there. */
  readFileAtRef(ref: string, relPath: string): Promise<string | null>;
}

export function createSideCar(): SideCar {
  const dir = cloneDir();

  async function repo(): Promise<SimpleGit> {
    return simpleGit(dir);
  }

  async function applyIdentity(git: SimpleGit): Promise<void> {
    await git.addConfig('user.name', COMMIT_NAME, false, 'local');
    await git.addConfig('user.email', COMMIT_EMAIL, false, 'local');
  }

  return {
    dir,

    async ensureClone(remoteUrl: string): Promise<void> {
      const isRepo = fs.existsSync(path.join(dir, '.git'));
      if (!isRepo) {
        // Remove a stale non-repo dir if one somehow exists, then clone fresh.
        if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await simpleGit().clone(remoteUrl, dir);
        log.info('config-backup', `cloned backup remote into ${dir}`);
      }
      const git = await repo();
      // Keep origin pointed at the bound remote (it may have changed).
      const remotes = await git.getRemotes(true);
      const origin = remotes.find((r) => r.name === 'origin');
      if (!origin) {
        await git.addRemote('origin', remoteUrl);
      } else if (origin.refs.push !== remoteUrl && origin.refs.fetch !== remoteUrl) {
        await git.remote(['set-url', 'origin', remoteUrl]);
      }
      await applyIdentity(git);
    },

    async fetch(): Promise<void> {
      const git = await repo();
      await git.fetch(['--prune']);
    },

    async checkoutBranch(branch: string): Promise<void> {
      const git = await repo();
      const branches = await git.branch(['-a']);
      const localExists = branches.all.includes(branch);
      const remoteExists = branches.all.includes(`remotes/origin/${branch}`);
      if (localExists) {
        await git.checkout(branch);
      } else if (remoteExists) {
        await git.checkout(['-b', branch, `origin/${branch}`]);
      } else {
        // First backup from this machine: a new branch off current HEAD (which
        // may be unborn on a freshly-cloned empty repo — checkout -b handles it).
        await git.checkout(['-b', branch]);
      }
    },

    async stageAllAndCommit(message: string): Promise<boolean> {
      const git = await repo();
      await git.add(['-A']);
      const status = await git.status();
      if (status.staged.length === 0 && status.created.length === 0 &&
          status.deleted.length === 0 && status.modified.length === 0 &&
          status.renamed.length === 0) {
        return false;
      }
      await git.commit(message);
      return true;
    },

    async push(branch: string): Promise<void> {
      const git = await repo();
      await git.push(['-u', 'origin', branch]);
    },

    async listBackupBranches(): Promise<BackupBranchRef[]> {
      const git = await repo();
      const branches = await git.branch(['-r']);
      const out: BackupBranchRef[] = [];
      for (const name of branches.all) {
        // name looks like `origin/backup/<id>`; skip `origin/HEAD -> …`.
        const m = name.match(new RegExp(`^origin/(${BACKUP_BRANCH_PREFIX}(.+))$`));
        if (!m) continue;
        out.push({ ref: name, branch: m[1], appInstanceId: m[2] });
      }
      return out;
    },

    async listFilesAtRef(ref: string): Promise<string[]> {
      const git = await repo();
      const raw = await git.raw(['ls-tree', '-r', '--name-only', ref]);
      return raw.split('\n').map((l) => l.trim()).filter(Boolean);
    },

    async readFileAtRef(ref: string, relPath: string): Promise<string | null> {
      const git = await repo();
      try {
        return await git.show([`${ref}:${relPath}`]);
      } catch {
        return null; // path absent at this ref
      }
    },
  };
}
