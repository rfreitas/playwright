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

const STORAGE_KEY = 'diagnostics';
const MAX_ENTRIES = 300;

// The service worker can be killed at any time, so connection events are kept
// in chrome.storage.local, where they survive a restart. Read the log from an
// extension page with `chrome.storage.local.get('diagnostics')`.
let pending: Promise<void> = Promise.resolve();

export function recordDiagnostic(event: string, details?: Record<string, unknown>): void {
  const entry = { t: new Date().toISOString(), event, ...details };
  // eslint-disable-next-line no-console
  console.log('[Extension]', entry);
  pending = pending.then(async () => {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as unknown[] | undefined;
    await chrome.storage.local.set({ [STORAGE_KEY]: [...(stored ?? []), entry].slice(-MAX_ENTRIES) });
  }).catch(() => {});
}
