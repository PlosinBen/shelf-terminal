import { openDB, type IDBPDatabase } from 'idb';
import type { AgentMsg } from '../components/AgentMessage';

const DB_NAME = 'shelf-agent-history';
// v1: legacy schema (keyPath 'id', index 'by-project-time'). Long gone but
// users who ran early shelf builds still have v1 DBs in their browser
// profile; opening at v1 finds no 'by-session' index and throws NotFoundError.
// v2: current schema. Migration drops the legacy store wholesale — agent UI
// history is non-critical and the shapes are incompatible anyway.
const DB_VERSION = 2;
const STORE_NAME = 'messages';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion) {
        if (oldVersion < 2 && db.objectStoreNames.contains(STORE_NAME)) {
          db.deleteObjectStore(STORE_NAME);
        }
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'dbId',
          autoIncrement: true,
        });
        store.createIndex('by-session', 'sessionId');
      },
    });
  }
  return dbPromise;
}

// AgentMsg is a discriminated union — TS interfaces can't extend unions, so
// use an intersection type. dbId/sessionId are non-discriminating so the
// extension is shape-safe.
type StoredMsg = AgentMsg & { dbId?: number; sessionId: string };

/**
 * If we crashed / were closed mid-tool-call, an in-flight `tool_use` or
 * `file_edit` would have been persisted without a `result`. On reload, that
 * card would render forever as "running" with no agent-server to ever
 * complete it. Patch a synthetic failed result so the user sees what
 * happened instead of a fake pending state.
 */
function reviveOrphanPending(msg: AgentMsg): AgentMsg {
  if (msg.type === 'tool_use' && !msg.result) {
    return { ...msg, result: { content: 'Session ended before this tool finished.', isError: true } };
  }
  if (msg.type === 'file_edit' && !msg.result) {
    return { ...msg, result: { success: false, error: 'Session ended before this edit finished.' } };
  }
  return msg;
}

/**
 * Pre-canonicalization persisted records had `tool_use` with structured
 * `toolInput: Record<string, unknown>` instead of `input: string`. Old saves
 * loaded under the new schema would render with empty header. JSON-stringify
 * the legacy field as a one-shot fallback so historical sessions still show
 * something readable. New writes already carry `input`, so this branch only
 * fires for stale rows.
 */
function migrateLegacyToolUseInput(msg: any): AgentMsg {
  if (msg?.type === 'tool_use' && typeof msg.input !== 'string' && msg.toolInput) {
    const { toolInput, ...rest } = msg;
    return { ...rest, input: JSON.stringify(toolInput) } as AgentMsg;
  }
  return msg as AgentMsg;
}

export async function loadAgentMessages(sessionId: string): Promise<AgentMsg[]> {
  const db = await getDB();
  const all: StoredMsg[] = await db.getAllFromIndex(STORE_NAME, 'by-session', sessionId);
  return all.map(({ dbId: _, sessionId: __, ...rest }) => {
    const migrated = migrateLegacyToolUseInput(rest);
    return reviveOrphanPending(migrated);
  });
}

// Default cap if caller doesn't pass one. Mirrors AppSettings default
// — agent-history.ts can't import from @shared/defaults without pulling
// app-level types into the storage layer, so we duplicate the constant.
const DEFAULT_MAX_MESSAGES = 1000;

export async function saveAgentMessages(
  sessionId: string,
  messages: AgentMsg[],
  maxMessages: number = DEFAULT_MAX_MESSAGES,
): Promise<void> {
  // Rotate at write time: keep the most recent `maxMessages` entries,
  // drop the oldest. Bounds IndexedDB growth without touching component
  // state (in-memory may temporarily exceed the cap; next save trims).
  const trimmed = messages.length > maxMessages
    ? messages.slice(messages.length - maxMessages)
    : messages;

  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(tx.objectStoreNames[0]);
  const idx = store.index('by-session');
  const existing = await idx.getAllKeys(sessionId);
  for (const key of existing) {
    await store.delete(key);
  }
  for (const msg of trimmed) {
    await store.add({ ...msg, sessionId } as StoredMsg);
  }
  await tx.done;
}

export async function clearAgentSession(sessionId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(tx.objectStoreNames[0]);
  const idx = store.index('by-session');
  const keys = await idx.getAllKeys(sessionId);
  for (const key of keys) {
    await store.delete(key);
  }
  await tx.done;
}
