import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { log } from '@shared/logger';
import type { PmMessage } from '@shared/types';
import type { ChatMessage } from './llm-client';

interface PersistedHistory {
  chat: ChatMessage[];
  display: PmMessage[];
}

function historyPath(): string {
  return path.join(app.getPath('home'), '.config', 'shelf', 'pm', 'history.json');
}

export function loadHistory(): { chat: ChatMessage[]; display: PmMessage[] } {
  try {
    const raw = fs.readFileSync(historyPath(), 'utf-8');
    const parsed: PersistedHistory = JSON.parse(raw);
    if (Array.isArray(parsed.chat) && Array.isArray(parsed.display)) {
      return parsed;
    }
  } catch {
    // File doesn't exist or is corrupt — start fresh
  }
  return { chat: [], display: [] };
}

export function saveHistory(chat: ChatMessage[], display: PmMessage[]): void {
  const dir = path.dirname(historyPath());
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data: PersistedHistory = { chat, display };
    fs.writeFileSync(historyPath(), JSON.stringify(data), 'utf-8');
  } catch (err: any) {
    log.error('pm-history', `save failed: ${err.message}`);
  }
}

export function clearPersistedHistory(): void {
  try {
    fs.unlinkSync(historyPath());
  } catch {
    // File doesn't exist — fine
  }
}
