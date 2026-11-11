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
// cgroup v1 reports this (~2^63) for "no limit".
const kCgroupV1Unbounded = 9223372036854771712;

// The most sessions allowed in the grace registry; 0 means no count limit. Set at server start.
let graceMax = 0;

// How many parked grace sessions a small machine can hold before the count cap kicks in.
export function configureGraceLimit(explicitMax: number | undefined) {
  graceMax = explicitMax ?? adaptiveGraceMax();
}

function adaptiveGraceMax(): number {
  const limit = readCgroupMemory().limit;
  return Math.max(2, Math.min(40, Math.floor(limit / kPerWindowBytes)));
}

function cgroupFiles(): { limitFile: string, usageFile: string } {
  const override = process.env.PWMCP_CGROUP_DIR_FOR_TEST;
  const v2 = (dir: string) => ({ limitFile: path.join(dir, 'memory.max'), usageFile: path.join(dir, 'memory.current') });
  const v1 = (dir: string) => ({ limitFile: path.join(dir, 'memory.limit_in_bytes'), usageFile: path.join(dir, 'memory.usage_in_bytes') });
  if (override)
    return fs.existsSync(path.join(override, 'memory.max')) ? v2(override) : v1(override);
  if (fs.existsSync('/sys/fs/cgroup/memory.max'))
    return v2('/sys/fs/cgroup');
  return v1('/sys/fs/cgroup/memory');
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
// where the cgroup limit equals the VM memory) falls back to /proc/meminfo. If that is unreadable too, usage is
// undefined, so the memory high-water check is skipped but the count cap still has a limit.
function readCgroupMemory(): { limit: number, usage: number | undefined } {
  const { limitFile, usageFile } = cgroupFiles();
  const total = os.totalmem();
  const limit = readNumberFile(limitFile);
  if (limit === undefined || limit <= 0 || limit >= total || limit >= kCgroupV1Unbounded)
    return readMeminfo() ?? { limit: total, usage: undefined };
  return { limit, usage: readNumberFile(usageFile) };
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

export function parkSession(record: SessionRecord, pages: playwright.Page[], graceMs: number, close: (() => Promise<void>) | undefined) {
  const timer = setTimeout(() => void evictGraceSession(record.token), graceMs);
  graceSessions.set(record.token, { pages, record, closeAt: Date.now() + graceMs, timer, close });
  enforceGraceLimits(record.token);
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

// The grace entry soonest to expire, which is the oldest park; never the one just parked.
function oldestGraceToken(justParked: string): string | undefined {
  let oldest: string | undefined;
  let oldestAt = Infinity;
  for (const [token, entry] of graceSessions) {
    if (token !== justParked && entry.closeAt < oldestAt) {
      oldestAt = entry.closeAt;
      oldest = token;
    }
  }
  return oldest;
}

// After a park, bring the registry back under the count cap and the memory high-water mark, evicting
// the oldest parks first. Both triggers share evictGraceSession and spare the session just parked.
function enforceGraceLimits(justParked: string) {
  if (graceMax > 0) {
    while (graceSessions.size > graceMax) {
      const token = oldestGraceToken(justParked);
      if (!token)
        break;
      log(`evict ${token}: ${graceSessions.size} grace sessions over cap ${graceMax}`);
      void evictGraceSession(token);
    }
  }

  const { limit, usage } = readCgroupMemory();
  if (usage === undefined || usage / limit < kMemoryHighWater)
    return;
  // Each eviction frees about one window; project the drop so one memory spike does not evict everything.
  let projected = usage;
  while (projected / limit >= kMemoryLowWater) {
    const token = oldestGraceToken(justParked);
    if (!token)
      break;
    log(`evict ${token}: memory ${projected} of ${limit} over high-water`);
    void evictGraceSession(token);
    projected -= kPerWindowBytes;
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

// Newest first.
export async function readRecords(dir: string): Promise<SessionRecord[]> {
  const names = await fs.promises.readdir(dir).catch(() => []);
  const records = await Promise.all(names.filter(name => name.endsWith('.json')).map(name => readRecord(dir, name.slice(0, -'.json'.length))));
  return records.filter((record): record is SessionRecord => !!record).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function deleteRecord(dir: string, token: string) {
  await fs.promises.unlink(recordFile(dir, token)).catch(() => {});
}
