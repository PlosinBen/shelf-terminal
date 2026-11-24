import { test, expect } from '../helpers';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LINK_OPEN } from '../../src/shared/link-open-intent';

test.use({ homeProjectDirectories: false });
test.setTimeout(60_000);
const docker = (...args: string[]) => execFileSync('docker', args, { timeout: 15_000 }).toString().trim();

test('SSH preview uses an explicitly authenticated source connector and preserves raw file intent', async ({ shelfApp: { page } }) => {
  test.skip(process.platform === 'win32', 'Password fixture requires the Unix ControlMaster lifecycle');
  const container = `shelf-link-preview-ssh-${randomUUID()}`;
  docker('run', '-d', '--name', container, '-p', '127.0.0.1::2222', '-e', 'USER_NAME=preview', '-e', 'USER_PASSWORD=preview-pass', '-e', 'PASSWORD_ACCESS=true', 'linuxserver/openssh-server:latest');
  try {
    await expect.poll(() => docker('exec', container, 'sh', '-c', 'netstat -lnt | grep -q ":2222 " && echo ready || echo waiting'), { timeout: 20_000 }).toBe('ready');
    const port = Number(docker('port', container, '2222/tcp').split(':').at(-1));
    const connection = { type: 'ssh' as const, host: '127.0.0.1', port, user: 'preview' };
    docker('exec', container, 'sh', '-c', 'mkdir -p /tmp/preview-worker; printf "%s\\n%s" "SSH remote first" "SSH remote second" > /tmp/preview-worker/source.txt');
    const project = await page.evaluate(connection => window.shelfApi.project.add({ name: 'SSH Preview', cwd: '/tmp/preview-worker', connection, maxTabs: 5 }), connection);
    await page.reload();
    const input = { url: './source.txt#L2', reason: 'Preview source', source: { kind: 'project-note' as const, projectId: project.id, noteId: 'ssh-note' } };
    const disconnected = await page.evaluate(input => window.shelfApi.linkOpen(input), input);
    expect(disconnected).toMatchObject({ kind: 'message', url: './source.txt#L2' });
    expect(disconnected.kind === 'message' && disconnected.title).toContain('disconnected');
    // Authentication is an explicit test/user operation, never performed by read.
    await page.evaluate(connection => window.shelfApi.connector.connect(connection, 'preview-pass'), connection);
    await page.evaluate(({ projectId, attrs }) => {
      const owner = document.createElement('div');
      owner.setAttribute(attrs.projectAttribute, projectId); owner.setAttribute(attrs.noteAttribute, 'ssh-note');
      const a = document.createElement('a'); a.id = 'ssh-preview-link'; a.href = './source.txt#L2'; a.textContent = 'SSH source';
      owner.appendChild(a); document.body.appendChild(owner);
    }, { projectId: project.id, attrs: LINK_OPEN });
    await page.locator('#ssh-preview-link').click();
    const preview = page.getByRole('dialog', { name: 'Link preview' });
    await expect(preview.locator('.link-preview-selected')).toContainText('SSH remote second');
    await expect(preview.locator('.link-preview-original')).toHaveText('./source.txt#L2');
    await expect(page.locator('.external-url-intent-overlay')).toHaveCount(0);
  } finally {
    docker('rm', '-f', container);
  }
});

test('remote Docker preview reads only source-worker bytes and fails explicitly without fallback', async ({ shelfApp: { page, userDataDir } }) => {
  const container = `shelf-link-preview-${randomUUID()}`;
  const cwd = path.join(userDataDir, 'remote-project');
  const filename = "source 'quoted'.html";
  fs.mkdirSync(cwd);
  fs.writeFileSync(path.join(cwd, filename), 'HOST CONTENT MUST NEVER BE READ');
  docker('run', '-d', '--name', container, '--network', 'none', '--user', '65534:65534', 'alpine:3.19', 'sleep', '300');
  try {
    docker('exec', '--user', '0', container, 'sh', '-c',
      'mkdir -p "$1"; printf "%s\\n%s" "<script>window.remoteExecuted=true</script>" "remote line two" > "$1/$2"; printf "\\000" > "$1/binary"; head -c 1048577 /dev/zero > "$1/large"; printf secret > "$1/private"; chmod 600 "$1/private"',
      'fixture', cwd, filename);
    const project = await page.evaluate(({ cwd, container }) => window.shelfApi.project.add({ name: 'Remote Preview', cwd, connection: { type: 'docker', container }, maxTabs: 5 }), { cwd, container });
    await page.reload();
    await expect(page.locator('.sidebar-item', { hasText: 'Remote Preview' })).toBeVisible();
    await page.evaluate(({ id, attrs }) => {
      const owner = document.createElement('div');
      owner.setAttribute(attrs.projectAttribute, id);
      owner.setAttribute(attrs.noteAttribute, 'remote-note');
      const a = document.createElement('a'); a.id = 'remote-preview-link'; a.textContent = 'Remote file';
      owner.appendChild(a); document.body.appendChild(owner);
    }, { id: project.id, attrs: LINK_OPEN });
    const preview = page.getByRole('dialog', { name: 'Link preview' });
    const open = async (url: string) => {
      await page.locator('#remote-preview-link').evaluate((a, href) => a.setAttribute('href', href), url);
      await page.locator('#remote-preview-link').click();
      await expect(preview).toBeVisible();
      await expect(preview.locator('.link-preview-original')).toHaveText(url);
    };
    for (const url of [`./${encodeURIComponent(filename)}#L2`, `file://${cwd}/${encodeURIComponent(filename)}#L2`, `${cwd}/${encodeURIComponent(filename)}:2:1`]) {
      await open(url);
      await expect(preview.locator('.link-preview-selected')).toContainText('remote line two');
      await expect(preview.locator('.link-preview-content')).toContainText('<script>window.remoteExecuted=true</script>');
      expect(await page.evaluate(() => (window as unknown as { remoteExecuted?: boolean }).remoteExecuted)).toBeUndefined();
      await preview.getByRole('button', { name: 'Close' }).click();
    }
    for (const [url, reason] of [['./missing', 'regular file'], ['./binary', 'Binary'], ['./large', '1 MiB'], ['./private', 'permissions'], ['.', 'regular file']]) {
      await open(url);
      await expect(preview).toContainText(reason);
      await expect(preview.locator('.link-preview-content')).toHaveCount(0);
      await expect(page.locator('.external-url-intent-overlay')).toHaveCount(0);
      await preview.getByRole('button', { name: 'Close' }).click();
    }
    docker('stop', '-t', '0', container);
    await open(`./${encodeURIComponent(filename)}`);
    await expect(preview).toContainText('disconnected');
    await expect(preview).not.toContainText('HOST CONTENT');
    await expect(preview.locator('.link-preview-content')).toHaveCount(0);
  } finally {
    docker('rm', '-f', container);
  }
});
