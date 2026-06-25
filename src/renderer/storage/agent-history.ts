import { openDB, type IDBPDatabase } from 'idb';
import type { AgentMsg } from '../components/AgentMessage';

const DB_NAME = 'shelf-agent-history';
// v1–v3: legacy schemas storing the old AgentMessage discriminated union
// (tool_use / file_edit / thinking / intent / slash_response / plan). The
// type system was refactored to renderer primitives (reply / note / system /
// error / fold_text / fold_code / fold_markdown / fold_diff / user — see
// agent-ui#5). User=developer, so we
// don't migrate per-row; v4 just drops the old store and starts fresh.
// v4: keyPath 'dbId' autoIncrement, indexes 'by-session' and the composite
// 'by-session-time' that lets `loadLatest` reverse-iterate the tail of a
// session in O(limit). Save layer is append-only delta — writes only happen
// at turn end (agentTabStore's doSave isStreaming guard), so each msg.id
// appears in the store exactly once and we never need upsert semantics.
const DB_VERSION = 4;
const STORE_NAME = 'messages';

let dbPromise: Promise<IDBPDatabase> | null = null;

function getDB(): Promise<IDBPDatabase> {
  if (!dbPromise) {
    dbPromise = openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        // Clean break: drop any pre-v4 store and recreate. We don't migrate
        // legacy rows — the old union shape is gone, and reviving them as
        // new types is more code than the developer-user audience needs.
        if (db.objectStoreNames.contains(STORE_NAME)) {
          db.deleteObjectStore(STORE_NAME);
        }
        const store = db.createObjectStore(STORE_NAME, {
          keyPath: 'dbId',
          autoIncrement: true,
        });
        store.createIndex('by-session', 'sessionId');
        store.createIndex('by-session-time', ['sessionId', 'timestamp']);
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
 * If we crashed / were closed mid-tool-call, an in-flight fold_* card may
 * have been persisted without body/errorMessage. On reload that card would
 * render forever as "running"; patch a synthetic errorMessage so the user
 * sees what happened.
 */
function reviveOrphanPending(msg: AgentMsg): AgentMsg {
  if ((msg.type === 'fold_text' || msg.type === 'fold_code'
       || msg.type === 'fold_markdown' || msg.type === 'fold_diff')
       && !msg.body && !msg.errorMessage) {
    return { ...msg, errorMessage: 'Session ended before completion' } as AgentMsg;
  }
  return msg;
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
    return reviveOrphanPending(rest as AgentMsg);
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
    if (msg.type === 'reply' && msg.streaming) continue;
    if (msg.type === 'fold_text' && msg.streaming) continue;
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
