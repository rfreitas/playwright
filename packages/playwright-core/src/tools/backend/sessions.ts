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

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import debug from 'debug';

import type * as playwright from '../../..';

const log = debug('pw:mcp:grace');

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

// A parked window keeps a browser process alive; this is a rough bytes-per-window estimate.
const kPerWindowBytes = 250 * 1024 * 1024;
// Fractions of the memory limit at which parking starts and stops evicting parked windows.
const kMemoryHighWater = 0.85;
const kMemoryLowWater = 0.75;

// The most windows parked sessions may hold; 0 means no count limit. Set at server start.
let graceMax = 0;

// How many parked windows a small machine can hold before the count cap kicks in.
export function configureGraceLimit(explicitMax: number | undefined) {
  graceMax = explicitMax ?? adaptiveGraceMax();
}

function adaptiveGraceMax(): number {
  const limit = readCgroupMemory().limit;
  return Math.max(2, Math.min(40, Math.floor(limit / kPerWindowBytes)));
}

// The usage file counts page cache; the stat key is the part of it that the kernel reclaims first.
function cgroupFiles(): { limitFile: string, usageFile: string, statFile: string, inactiveFileKey: string } {
  const root = process.env.PWMCP_CGROUP_DIR_FOR_TEST || '/sys/fs/cgroup';
  if (fs.existsSync(path.join(root, 'memory.max')))
    return { limitFile: path.join(root, 'memory.max'), usageFile: path.join(root, 'memory.current'), statFile: path.join(root, 'memory.stat'), inactiveFileKey: 'inactive_file' };
  const v1 = path.join(root, 'memory');
  return { limitFile: path.join(v1, 'memory.limit_in_bytes'), usageFile: path.join(v1, 'memory.usage_in_bytes'), statFile: path.join(v1, 'memory.stat'), inactiveFileKey: 'total_inactive_file' };
}

function readNumberFile(file: string): number | undefined {
  try {
    const raw = fs.readFileSync(file, 'utf-8').trim();
    if (raw === 'max')
      return undefined;
    const n = Number(raw);
    return Number.isFinite(n) ? n : undefined;
  } catch {
    return undefined;
  }
}

// The container memory limit and current usage. A host-sized or unbounded cgroup limit (as on a Firecracker VM,
// where the cgroup limit equals the VM memory, or cgroup v1, which reports about 2^63 for no limit) falls back to /proc/meminfo. If that is unreadable too, usage is
// undefined, so the memory high-water check is skipped but the count cap still has a limit.
function readCgroupMemory(): { limit: number, usage: number | undefined } {
  const { limitFile, usageFile, statFile, inactiveFileKey } = cgroupFiles();
  const total = os.totalmem();
  const limit = readNumberFile(limitFile);
  if (limit === undefined || limit >= total)
    return readMeminfo() ?? { limit: total, usage: undefined };
  const usage = readNumberFile(usageFile);
  return { limit, usage: usage === undefined ? undefined : usage - readStat(statFile, inactiveFileKey) };
}

// A value from memory.stat, 0 when the file or the key is not there.
function readStat(file: string, key: string): number {
  try {
    return Number(new RegExp(`^${key} (\\d+)$`, 'm').exec(fs.readFileSync(file, 'utf-8'))?.[1] ?? 0);
  } catch {
    return 0;
  }
}

function readMeminfo(): { limit: number, usage: number } | undefined {
  try {
    const text = fs.readFileSync(process.env.PWMCP_MEMINFO_FOR_TEST || '/proc/meminfo', 'utf-8');
    const kb = (name: string) => Number(new RegExp(`^${name}:\\s+(\\d+)\\s*kB`, 'm').exec(text)?.[1]) * 1024;
    const total = kb('MemTotal');
    const available = kb('MemAvailable');
    if (total > 0 && available >= 0)
      return { limit: total, usage: total - available };
  } catch {
  }
  return undefined;
}

// Returns whether it parked the windows. A session with more windows than the cap is not parked, so that it
// does not evict everyone else; its record stays for browser_tabs resume.
export function parkSession(record: SessionRecord, pages: playwright.Page[], graceMs: number, close: (() => Promise<void>) | undefined): boolean {
  if (graceMax > 0 && pages.length > graceMax) {
    log(`not parking ${record.token}: ${pages.length} windows over cap ${graceMax}`);
    return false;
  }
  const timer = setTimeout(() => void evictGraceSession(record.token), graceMs);
  graceSessions.set(record.token, { pages, record, closeAt: Date.now() + graceMs, timer, close });
  enforceGraceLimits(record.token);
  return true;
}

// Closes a parked session as its grace timer would on expiry: drop it from the registry and close its
// windows and connection, but leave its record on disk so browser_tabs resume can still reopen it.
async function evictGraceSession(token: string): Promise<void> {
  const entry = graceSessions.get(token);
  if (!entry)
    return;
  graceSessions.delete(token);
  clearTimeout(entry.timer);
  for (const page of entry.pages)
    await page.close().catch(() => {});
  await entry.close?.().catch(() => {});
}

// The oldest park; never the one just parked. Every park has the same grace, so the registry's insertion order
// is the order of expiry.
function oldestGraceToken(justParked: string): string | undefined {
  for (const token of graceSessions.keys()) {
    if (token !== justParked)
      return token;
  }
  return undefined;
}

// A parked window can close on its own (a crash, window.close(), a person); only the open ones hold memory.
function openWindows(entry: GraceEntry): number {
  return entry.pages.filter(page => !page.isClosed()).length;
}

function parkedWindows(): number {
  let count = 0;
  for (const entry of graceSessions.values())
    count += openWindows(entry);
  return count;
}

// After a park, bring the parked windows back under the count cap and the memory high-water mark, evicting
// the oldest parks first. Both triggers share evictGraceSession and spare the session just parked.
function enforceGraceLimits(justParked: string) {
  if (graceMax > 0) {
    while (parkedWindows() > graceMax) {
      const token = oldestGraceToken(justParked);
      if (!token)
        break;
      log(`evict ${token}: ${parkedWindows()} grace windows over cap ${graceMax}`);
      void evictGraceSession(token);
    }
  }

  const { limit, usage } = readCgroupMemory();
  if (usage === undefined || usage / limit < kMemoryHighWater)
    return;
  // Each evicted window frees about kPerWindowBytes; project the drop so one memory spike does not evict everything.
  let projected = usage;
  while (projected / limit >= kMemoryLowWater) {
    const token = oldestGraceToken(justParked);
    if (!token)
      break;
    log(`evict ${token}: memory ${projected} of ${limit} over high-water`);
    projected -= kPerWindowBytes * openWindows(graceSessions.get(token)!);
    void evictGraceSession(token);
  }
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
  // Write aside and rename, so that a reader never sees a half-written record and a crash leaves the old one.
  const file = recordFile(dir, record.token);
  const temp = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(record, null, 2));
  await fs.promises.rename(temp, file);
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

export async function deleteRecord(dir: string, token: string) {
  await fs.promises.unlink(recordFile(dir, token)).catch(() => {});
}
