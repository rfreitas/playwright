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

import fs from 'fs';
import path from 'path';

import type * as playwright from '../../..';

// What a private-tabs session leaves on disk, so that a later client can find or reopen its tabs.
export type SessionRecord = {
  token: string;
  clientName: string;
  startedAt: string;
  updatedAt: string;
  endedAt?: string;
  tabs: { url: string, title: string, targetId: string, current: boolean }[];
};

type GraceEntry = {
  pages: playwright.Page[];
  record: SessionRecord;
  closeAt: number;
  timer: NodeJS.Timeout;
  close: (() => Promise<void>) | undefined;
};

// Tokens of the sessions in this process that own their tabs.
export const liveSessions = new Set<string>();
// Sessions whose client went away: their windows and connection stay until closeAt, for a client to resume.
export const graceSessions = new Map<string, GraceEntry>();

const kRetentionMs = 30 * 24 * 60 * 60 * 1000;

export function parkSession(record: SessionRecord, pages: playwright.Page[], graceMs: number, close: (() => Promise<void>) | undefined) {
  const timer = setTimeout(async () => {
    graceSessions.delete(record.token);
    for (const page of pages)
      await page.close().catch(() => {});
    await close?.().catch(() => {});
  }, graceMs);
  graceSessions.set(record.token, { pages, record, closeAt: Date.now() + graceMs, timer, close });
}

export function takeSession(token: string): GraceEntry | undefined {
  const entry = graceSessions.get(token);
  if (entry) {
    graceSessions.delete(token);
    clearTimeout(entry.timer);
  }
  return entry;
}

export function sessionsDir(outputDir: string): string {
  return path.join(outputDir, 'sessions');
}

function recordFile(dir: string, token: string): string {
  return path.join(dir, path.basename(token) + '.json');
}

export async function writeRecord(dir: string, record: SessionRecord) {
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(recordFile(dir, record.token), JSON.stringify(record, null, 2));
  // A record's mtime is its updatedAt; the old ones go so that the directory does not grow forever.
  const cutoff = Date.now() - kRetentionMs;
  for (const name of await fs.promises.readdir(dir)) {
    const file = path.join(dir, name);
    const stat = await fs.promises.stat(file).catch(() => undefined);
    if (stat && stat.mtimeMs < cutoff)
      await fs.promises.unlink(file).catch(() => {});
  }
}

export async function readRecord(dir: string, token: string): Promise<SessionRecord | undefined> {
  return await fs.promises.readFile(recordFile(dir, token), 'utf-8').then(text => JSON.parse(text)).catch(() => undefined);
}

// Newest first.
export async function readRecords(dir: string): Promise<SessionRecord[]> {
  const names = await fs.promises.readdir(dir).catch(() => []);
  const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => readRecord(dir, name.slice(0, -'.json'.length))));
  return records.filter((record): record is SessionRecord => !!record).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteRecord(dir: string, token: string) {
  await fs.promises.unlink(recordFile(dir, token)).catch(() => {});
}
