const DB_NAME = 'shelf-agent-history';
const DB_VERSION = 1;
const STORE_NAME = 'messages';
const MAX_TOOL_INPUT_LENGTH = 10240;

export interface PersistedAgentMessage {
  id?: number;
  projectId: string;
  timestamp: number;
  role: 'user' | 'assistant' | 'system' | 'tool';
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'system' | 'result' | 'error';
  content: string;
  provider?: string;
  toolName?: string;
  toolUseId?: string;
  toolInput?: string;
  /** Attachment metadata for user turns — filenames / paths / data URLs */
  attachments?: {
    files?: Array<{ path: string; displayPath: string }>;
    images?: string[];  // data URLs
  };
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
        store.createIndex('by-project-time', ['projectId', 'timestamp']);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

export async function saveMessage(msg: Omit<PersistedAgentMessage, 'id'>): Promise<void> {
  const db = await openDB();
  const record = { ...msg };
  if (record.toolInput && record.toolInput.length > MAX_TOOL_INPUT_LENGTH) {
    record.toolInput = record.toolInput.slice(0, MAX_TOOL_INPUT_LENGTH) + '…';
  }
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).add(record);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function loadMessages(projectId: string, limit = 200): Promise<PersistedAgentMessage[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const index = tx.objectStore(STORE_NAME).index('by-project-time');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const req = index.openCursor(range, 'prev');
    const results: PersistedAgentMessage[] = [];

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor && results.length < limit) {
        results.push(cursor.value);
        cursor.continue();
      } else {
        resolve(results.reverse());
      }
    };
    req.onerror = () => reject(req.error);
  });
}

export async function clearMessages(projectId: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const index = tx.objectStore(STORE_NAME).index('by-project-time');
    const range = IDBKeyRange.bound([projectId, 0], [projectId, Infinity]);
    const req = index.openCursor(range);

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function rotateOldMessages(days: number): Promise<void> {
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    const req = store.openCursor();

    req.onsuccess = () => {
      const cursor = req.result;
      if (cursor) {
        if (cursor.value.timestamp < cutoff) {
          cursor.delete();
        }
        cursor.continue();
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}
