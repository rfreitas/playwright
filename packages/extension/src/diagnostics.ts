/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const DB_NAME = 'playwright-diagnostics';
const STORE_NAME = 'events';
const MAX_ENTRIES = 300;

// The service worker can be killed at any time, so connection events are kept
// in IndexedDB, which survives a restart and needs no extension permission.
// Read the log from an extension page: database 'playwright-diagnostics',
// object store 'events'.
let pending: Promise<void> = Promise.resolve();

export function recordDiagnostic(event: string, details?: Record<string, unknown>): void {
  const entry = { t: new Date().toISOString(), event, ...details };
  // eslint-disable-next-line no-console
  console.log('[Extension]', entry);
  pending = pending.then(() => appendEntry(entry)).catch(() => {});
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE_NAME, { autoIncrement: true });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function appendEntry(entry: object): Promise<void> {
  const db = await openDatabase();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      store.add(entry);
      const count = store.count();
      count.onsuccess = () => {
        const excess = count.result - MAX_ENTRIES;
        if (excess <= 0)
          return;
        store.getAllKeys(undefined, excess).onsuccess = event => {
          for (const key of (event.target as IDBRequest<IDBValidKey[]>).result)
            store.delete(key);
        };
      };
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
    });
  } finally {
    db.close();
  }
}
