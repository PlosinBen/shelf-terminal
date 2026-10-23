import { it, expect, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { DockerConnector } from './docker';
import { WorktreeProbe } from './worktree-probe';
import { scanWorktrees } from '../worktree/scan';
vi.mock('node-pty', () => ({}));
const image = process.env.SHELF_WORKTREE_DOCKER_IMAGE;
it.skipIf(!image)('inspects container-only Git paths and fails on denied access', async () => {
  const container = `shelf-worktree-probe-${process.pid}`;
  execFileSync('docker', ['run', '--rm', '-d', '--name', container, '--user', '65534:65534', image!, 'sleep', '300']);
  try {
    const connector = new DockerConnector(container);
    await connector.exec('/tmp', 'git init -b main /tmp/shelf-probe');
    await connector.exec('/tmp/shelf-probe', 'git -c user.name=test -c user.email=test@example.com commit --allow-empty -m initial');
    await connector.exec('/tmp/shelf-probe', 'git worktree add --detach /tmp/shelf-child');
    const probe = new WorktreeProbe(connector, '/tmp/shelf-probe', false);
    const snapshot = await scanWorktrees(probe, '/tmp/shelf-probe');
    expect(snapshot?.worktrees.map(item => [item.path, item.branch])).toEqual([['/tmp/shelf-child', null]]);
    await connector.exec('/tmp', 'chmod 000 /tmp/shelf-child');
    await expect(scanWorktrees(probe, '/tmp/shelf-probe')).rejects.toThrow('inaccessible');
    await connector.exec('/tmp', 'chmod 700 /tmp/shelf-child');
    await connector.exec('/tmp', 'rm -rf /tmp/shelf-child');
    expect((await scanWorktrees(probe, '/tmp/shelf-probe'))?.worktrees).toEqual([]);
    expect(await probe.identity('/tmp')).toBeNull();
  } finally {
    execFileSync('docker', ['rm', '-f', container]);
  }
}, 60000);
