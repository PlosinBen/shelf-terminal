import fs from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { getControlPath } from './ssh-control';

const PASTE_DIR = path.join(os.tmpdir(), 'shelf-paste');
const MAX_AGE_MS = 60 * 60 * 1000; // 1 hour

function ensureDir() {
  if (!fs.existsSync(PASTE_DIR)) {
    fs.mkdirSync(PASTE_DIR, { recursive: true });
  }
}

/**
 * Save image buffer to temp file, return the file path.
 */
export function saveClipboardImage(buffer: Buffer): string {
  ensureDir();
  const filename = `paste-${Date.now()}.png`;
  const filePath = path.join(PASTE_DIR, filename);
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

/**
 * Save image locally, then SCP to remote host. Returns the remote path.
 */
export function saveClipboardImageRemote(
  buffer: Buffer,
  host: string,
  port: number,
  user: string,
): Promise<string> {
  // Save locally first
  const localPath = saveClipboardImage(buffer);
  const remoteTmpDir = '/tmp/shelf-paste';
  const filename = path.basename(localPath);
  const remotePath = `${remoteTmpDir}/${filename}`;

  const controlPath = getControlPath(host, port, user);

  return new Promise((resolve, reject) => {
    // Ensure remote directory exists, then SCP
    execFile(
      'ssh',
      [
        '-o', `ControlMaster=auto`,
        '-o', `ControlPath=${controlPath}`,
        '-o', `ControlPersist=600`,
        '-p', String(port),
        `${user}@${host}`,
        `mkdir -p ${remoteTmpDir}`,
      ],
      { timeout: 10000 },
      (mkdirErr) => {
        // Proceed even if mkdir fails (dir may already exist)
        execFile(
          'scp',
          [
            '-o', `ControlMaster=auto`,
            '-o', `ControlPath=${controlPath}`,
            '-P', String(port),
            localPath,
            `${user}@${host}:${remotePath}`,
          ],
          { timeout: 30000 },
          (err) => {
            if (err) {
              reject(new Error(`SCP failed: ${err.message}`));
            } else {
              resolve(remotePath);
            }
          },
        );
      },
    );
  });
}

/**
 * Clean up expired paste files.
 */
export function cleanupExpiredImages() {
  if (!fs.existsSync(PASTE_DIR)) return;

  const now = Date.now();
  for (const file of fs.readdirSync(PASTE_DIR)) {
    const filePath = path.join(PASTE_DIR, file);
    try {
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > MAX_AGE_MS) {
        fs.unlinkSync(filePath);
      }
    } catch {
      // ignore
    }
  }
}

/**
 * Remove entire paste directory.
 */
export function cleanupAllImages() {
  if (fs.existsSync(PASTE_DIR)) {
    fs.rmSync(PASTE_DIR, { recursive: true, force: true });
  }
}

// Start periodic cleanup
let cleanupInterval: NodeJS.Timeout | null = null;

export function startCleanupTimer() {
  cleanupInterval = setInterval(cleanupExpiredImages, MAX_AGE_MS);
}

export function stopCleanupTimer() {
  if (cleanupInterval) {
    clearInterval(cleanupInterval);
    cleanupInterval = null;
  }
}
