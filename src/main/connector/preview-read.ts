import type { ConnectorRuntime } from './runtime';
import { LINK_OPEN } from '@shared/link-open-intent';
import { randomBytes } from 'node:crypto';

export type PreviewRuntime = Pick<ConnectorRuntime, 'spawnProcess' | 'isConnected' | 'isCurrentGeneration'>;
export const REMOTE_PREVIEW_LIMITS = { timeoutMs: 15_000, stderrBytes: 8192 } as const;

// Paths are positional parameters, never shell source. head reads at most one
// byte beyond the accepted limit; byte decoding remains the caller's job.
const READ_SCRIPT = 'test -f "$1" || exit 44; printf "%s" "$3"; head -c "$2" "$1" || exit 45; printf "%s" "$4"';

export async function readRemotePreviewBytes(runtime: PreviewRuntime, file: string, timeoutMs: number = REMOTE_PREVIEW_LIMITS.timeoutMs): Promise<Buffer> {
  const deadline = Date.now() + timeoutMs;
  if (!runtime.isCurrentGeneration()) throw new Error('Remote connection changed');
  const connected = await new Promise<boolean>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Remote file preview timed out')), timeoutMs);
    runtime.isConnected().then(resolve, reject).finally(() => clearTimeout(timer));
  });
  if (!runtime.isCurrentGeneration()) throw new Error('Remote connection changed');
  if (!connected) throw new Error('Remote connection is disconnected');
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('Remote file preview timed out');
  const nonce = randomBytes(16).toString('hex');
  const prefix = Buffer.from(`SHELF_PREVIEW_${nonce}_START\n`);
  const suffix = Buffer.from(`\nSHELF_PREVIEW_${nonce}_END`);
  const outputLimit = LINK_OPEN.maxFileBytes + 1 + prefix.length + suffix.length;
  const child = runtime.spawnProcess({ executable: 'sh', args: ['-c', READ_SCRIPT, 'shelf-preview', file, String(LINK_OPEN.maxFileBytes + 1), prefix.toString(), suffix.toString()] });
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let bytes = 0, stderrBytes = 0, settled = false;
    const timer = setTimeout(() => fail('Remote file preview timed out'), remaining);
    function fail(message: string) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy();
      reject(new Error(message));
    }
    child.on('error', () => fail('Remote file reader could not start'));
    child.stdin.on('error', () => { /* Early remote exit can close stdin first. */ });
    child.stdout.on('error', () => fail('Remote file read stream failed'));
    child.stderr.on('error', () => fail('Remote file read stream failed'));
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled) return;
      bytes += chunk.length;
      if (bytes > outputLimit) return fail('Remote file reader exceeded its output limit');
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes > REMOTE_PREVIEW_LIMITS.stderrBytes) fail('Remote file reader produced too much diagnostic output');
    });
    child.on('close', (code, signal) => {
      if (settled) return;
      if (!runtime.isCurrentGeneration()) return fail('Remote connection changed');
      if (code === 44) return fail('Remote preview requires an existing regular file');
      if (code !== 0 || signal) return fail('Remote file read failed; check permissions and worker sh/head availability');
      const output = Buffer.concat(chunks, bytes);
      if (!output.subarray(0, prefix.length).equals(prefix) || !output.subarray(-suffix.length).equals(suffix)) return fail('Remote file reader returned invalid framing');
      const content = output.subarray(prefix.length, output.length - suffix.length);
      if (content.length > LINK_OPEN.maxFileBytes) return fail('File preview is limited to 1 MiB');
      settled = true;
      clearTimeout(timer);
      resolve(content);
    });
    child.stdin.end();
  });
}
