import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'child_process';
import { spawnPipeWrite, buildRemotePutCmd } from './file-utils';
import { shelfPlacement, ShelfFileTypeTest } from '@shared/shelf-paths';

/**
 * Real-container verification of the transport CHANNEL (features/app-level-mcps).
 * The transport is a shared byte-mover; the only MCP-specific part is the
 * type→path mapping (unit-tested in shelf-paths.test). So one channel check —
 * resolve home on the worker, compose the type path, place bytes, read them
 * back — proves the connection's `putFile` works. This exercises the EXACT
 * mechanism DockerConnector.putFile uses (`spawnPipeWrite` + `buildRemotePutCmd`),
 * bypassing the connector class only to avoid loading node-pty under vitest.
 *
 * Opt-in (spins a container) — run with:
 *   RUN_TRANSPORT_DOCKER_VERIFY=1 npx vitest run transport-channel.docker
 * SSH/WSL putFile reuse the same `spawnPipeWrite` + their already-shipped args
 * (the working uploadFile path), so a green docker channel + that shared plumbing
 * covers them.
 */

const CONTAINER = 'shelf-transport-verify';
let dockerOk = false;
try {
  execFileSync('docker', ['version'], { stdio: 'ignore' });
  dockerOk = true;
} catch {
  dockerOk = false;
}
const enabled = process.env.RUN_TRANSPORT_DOCKER_VERIFY === '1' && dockerOk;

describe.skipIf(!enabled)('transport channel (docker, real container)', () => {
  beforeAll(() => {
    spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
    execFileSync('docker', ['run', '-d', '--name', CONTAINER, 'alpine', 'sleep', '300'], { stdio: 'ignore' });
  });
  afterAll(() => {
    spawnSync('docker', ['rm', '-f', CONTAINER], { stdio: 'ignore' });
  });

  it('resolves home on the container, composes the type path, and round-trips bytes', async () => {
    // Home resolved ON the worker — exactly what transportPut does via homePath().
    const home = execFileSync('docker', ['exec', CONTAINER, 'sh', '-c', 'echo $HOME'], { encoding: 'utf8' }).trim();
    const { base, rel } = shelfPlacement(ShelfFileTypeTest, {});
    expect(base).toBe('home');
    const dest = `${home}/${rel}`;
    const payload = Buffer.from('shelf-transport-ok\n');

    // The mkdir-p + cat path placement must create parents and land the bytes.
    await spawnPipeWrite(
      'docker', ['exec', '-i', CONTAINER, 'sh', '-c', buildRemotePutCmd(dest)],
      payload, dest, 'docker putFile (verify)',
    );

    const readBack = execFileSync('docker', ['exec', CONTAINER, 'cat', dest], { encoding: 'utf8' });
    expect(readBack).toBe('shelf-transport-ok\n');
  });
});
