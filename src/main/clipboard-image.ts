import fs from 'fs';
import path from 'path';
import os from 'os';
import { app } from 'electron';

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
