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

interface StoredMsg extends AgentMsg {
  dbId?: number;
  sessionId: string;
}

export async function loadAgentMessages(sessionId: string): Promise<AgentMsg[]> {
  const db = await getDB();
  const all: StoredMsg[] = await db.getAllFromIndex(STORE_NAME, 'by-session', sessionId);
  return all.map(({ dbId: _, sessionId: __, ...msg }) => msg as AgentMsg);
}

export async function saveAgentMessages(sessionId: string, messages: AgentMsg[]): Promise<void> {
  const db = await getDB();
  const tx = db.transaction(STORE_NAME, 'readwrite');
  const store = tx.objectStore(tx.objectStoreNames[0]);
  const idx = store.index('by-session');
  const existing = await idx.getAllKeys(sessionId);
  for (const key of existing) {
    await store.delete(key);
  }
  for (const msg of messages) {
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
