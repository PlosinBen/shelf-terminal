import { openDB, type IDBPDatabase } from 'idb';
import type { AgentMsg } from '../components/AgentMessage';

const DB_NAME = 'shelf-agent-history';
// v1: legacy schema (keyPath 'id', index 'by-project-time'). Long gone but
// users who ran early shelf builds still have v1 DBs in their browser
// profile; opening at v1 finds no 'by-session' index and throws NotFoundError.
// v2: keyPath 'dbId' autoIncrement, index 'by-session'. Overwrite-all save.
// v3: same keyPath/store, adds 'by-session-time' composite index for the
// paginated `loadLatest` cursor. Save layer switches to append-only delta
// (see agentTabStore.PendingSave + saveAgentMessagesDelta below) — IDB no
// longer trims itself, so there's no `maxMessages` knob anymore. Writes
// only happen at turn end (agentTabStore's doSave isStreaming guard), so
// each msg.id appears in the store exactly once and we never need upsert
// semantics. Hence keyPath stays on the synthetic dbId.
const DB_VERSION = 3;
const STORE_NAME = 'messages';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db, oldVersion, _newVersion, tx) {
        if (oldVersion < 2 && db.objectStoreNames.contains(STORE_NAME)) {
          db.deleteObjectStore(STORE_NAME);
        }
        let store;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          store = db.createObjectStore(STORE_NAME, {
            keyPath: 'dbId',
            autoIncrement: true,
          });
          store.createIndex('by-session', 'sessionId');
        } else {
          store = tx.objectStore(STORE_NAME);
        }
        if (oldVersion < 3 && !store.indexNames.contains('by-session-time')) {
          // Composite (sessionId, timestamp) index lets `loadLatest` cursor
          // reverse-iterate the tail of a session in O(limit) instead of
          // pulling the whole session via getAllFromIndex.
          store.createIndex('by-session-time', ['sessionId', 'timestamp']);
        }
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
  if (msg.type === 'slash_response' && msg.status === 'pending') {
    return { ...msg, status: 'error', content: 'Session ended before this command finished.' };
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

/**
 * Load the latest `limit` messages for a session in ascending order
 * (oldest of the returned window first, suitable for direct render).
 *
 * Uses the `by-session-time` index in reverse, accumulating until limit
 * is hit, then reverses the buffer before returning. With `limit=500`
 * this is roughly equivalent in cost to the old `getAllFromIndex` for
 * a small session, but stays bounded as IDB grows past in-memory cap.
 *
 * Returns `[]` if the session has no rows.
 */
export async function loadAgentMessagesLatest(
  sessionId: string,
  limit: number,
): Promise<AgentMsg[]> {
  if (limit <= 0) return [];
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readonly');
  const idx = tx.objectStore(STORE_NAME).index('by-session-time');
  // Bounds the cursor to (sessionId, *) — composite index treats missing
  // upper-bound on timestamp as +Infinity for that sessionId.
  const range = IDBKeyRange.bound(
    [sessionId, Number.NEGATIVE_INFINITY],
    [sessionId, Number.POSITIVE_INFINITY],
  );
  const rows: StoredMsg[] = [];
  let cursor = await idx.openCursor(range, 'prev');
  while (cursor && rows.length < limit) {
    rows.push(cursor.value as StoredMsg);
    cursor = await cursor.continue();
  }
  await tx.done;
  rows.reverse();
  return rows.map(({ dbId: _, sessionId: __, ...rest }) => {
    return reviveOrphanPending(migrateLegacyToolUseInput(rest));
  });
}

/**
 * Append-only delta save. Caller (agentTabStore) batches dirty msg
 * snapshots inside a throttle window and hands them off here; we just
 * `store.add` each one as a new row. msg.id may already exist in another
 * row for this session, but that's fine — IDB doesn't enforce uniqueness
 * on msg.id (keyPath is the synthetic dbId), and the agentTabStore
 * isStreaming guard ensures each msg is only written once per turn at
 * its final state. On load, ascending-by-time iteration naturally yields
 * the latest write last; if a logic bug ever caused a dup, the later
 * row wins display-wise.
 *
 * Streaming partials (text / thinking with `streaming: true`) are dropped
 * here as a safety net — agentTabStore already excludes them at mark
 * time, but defensive double-check costs nothing.
 *
 * `deletedIds` is a forward-compat slot — no current caller populates it
 * (no single-msg deletion exists; clear is whole-session via
 * `clearAgentSession`). Implementation supports it so the API matches
 * `PendingSave.deletedIds` shape.
 */
export async function saveAgentMessagesDelta(
  sessionId: string,
  dirty: AgentMsg[],
  deletedIds?: Set<string>,
): Promise<void> {
  if (dirty.length === 0 && (!deletedIds || deletedIds.size === 0)) return;
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);

  if (deletedIds && deletedIds.size > 0) {
    // No msg.id index, so cursor-scan the session and delete rows whose
    // msg.id is in the set. Acceptable cost since deletion is rare.
    const idx = store.index('by-session');
    let cursor = await idx.openCursor(sessionId);
    while (cursor) {
      const v = cursor.value as StoredMsg;
      if (deletedIds.has(v.id)) {
        await cursor.delete();
      }
      cursor = await cursor.continue();
    }
  }

  for (const msg of dirty) {
    if (msg.type === 'text' && msg.streaming) continue;
    if (msg.type === 'thinking' && msg.streaming) continue;
    await store.add({ ...msg, sessionId } as StoredMsg);
  }
  await tx.done;
}

export async function clearAgentSession(sessionId: string): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(STORE_NAME);
  const idx = store.index('by-session');
  const keys = await idx.getAllKeys(sessionId);
  for (const key of keys) {
    await store.delete(key);
  }
  await tx.done;
}
