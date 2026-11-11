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
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';

import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { test as baseTest, expect, mcpServerPath } from './fixtures';
import { inheritAndCleanEnv } from '../config/utils';

import type { ChildProcess } from 'child_process';

// One HTTP server process outlives its clients; a test may run two of them.
const test = baseTest.extend<{ startServer: (args: string[], env?: Record<string, string | undefined>) => Promise<URL> }>({
  startServer: async ({}, use, testInfo) => {
    const processes: ChildProcess[] = [];
    await use(async (args, env) => {
      const cp = spawn('node', [...mcpServerPath, '--port=0', ...args], {
        stdio: 'pipe',
        env: inheritAndCleanEnv({ DEBUG: 'pw:mcp:test', DEBUG_COLORS: '0', DEBUG_HIDE_DATE: '1', ...env }),
        cwd: testInfo.outputPath(),
      });
      processes.push(cp);
      let stderr = '';
      const url = await new Promise<string>(resolve => cp.stderr!.on('data', data => {
        stderr += data.toString();
        const match = stderr.match(/Listening on (http:\/\/.*)/);
        if (match)
          resolve(match[1]);
      }));
      return new URL('/mcp', url);
    });
    for (const cp of processes)
      cp.kill('SIGTERM');
  },
});

async function connect(endpoint: URL, name: string) {
  const transport = new StreamableHTTPClientTransport(endpoint);
  const client = new Client({ name, version: '1.0.0' });
  await client.connect(transport);
  return { client, transport };
}

type Response = Awaited<ReturnType<Client['callTool']>>;
const text = (response: Response) => (response.content as { text: string }[])[0].text;
const tokenOf = (response: Response) => text(response).match(/### Session\n([0-9a-f]{24})/)![1];
const kReminder = 'A session that disconnected recently is still open';

test('grace: a dropped session keeps its windows, and a later client takes them over', async ({ cdpServer, startServer, server }) => {
  test.setTimeout(60000);
  const browserContext = await cdpServer.start();
  const outputDir = test.info().outputPath('output');
  const args = [`--cdp-endpoint=${cdpServer.endpoint}`, '--private-tabs', `--output-dir=${outputDir}`];
  const endpoint = await startServer([...args, '--resume-grace=60000']);

  const a = await connect(endpoint, 'client-a');
  const token = tokenOf(await a.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/a' } }));
  const recordFile = path.join(outputDir, 'sessions', `${token}.json`);
  const readRecord = () => fs.promises.readFile(recordFile, 'utf-8').then(JSON.parse, () => undefined);
  await expect.poll(readRecord).toEqual(expect.objectContaining({
    token,
    clientName: 'client-a',
    tabs: [expect.objectContaining({ url: server.PREFIX + '/a', targetId: expect.any(String), current: true })],
  }));

  // A goes away; its window stays open for the grace period.
  await a.transport.terminateSession();
  await a.client.close();
  await expect.poll(async () => (await readRecord())?.endedAt).toEqual(expect.any(String));
  await new Promise(f => setTimeout(f, 2000));
  expect(browserContext.pages().map(p => p.url())).toContain(server.PREFIX + '/a');

  // A new client hears about it once.
  const b = await connect(endpoint, 'client-b');
  expect(text(await b.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/b' } }))).toContain(kReminder);
  expect(text(await b.client.callTool({ name: 'browser_snapshot', arguments: {} }))).not.toContain(kReminder);
  expect(text(await b.client.callTool({ name: 'browser_sessions', arguments: {} }))).toContain(`${token} grace until`);

  // C takes the session over: the same window, the same token.
  const c = await connect(endpoint, 'client-c');
  expect(await c.client.callTool({ name: 'browser_tabs', arguments: { action: 'resume', token } })).toHaveResponse({
    result: `- 0: (current) [](${server.PREFIX}/a)`,
  });
  expect(tokenOf(await c.client.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }))).toBe(token);
  expect(browserContext.pages().filter(p => p.url() === server.PREFIX + '/a')).toHaveLength(1);
  expect(text(await c.client.callTool({ name: 'browser_sessions', arguments: {} }))).toContain(`${token} live`);

  // Without grace a dropped client's window closes as soon as the heartbeat notices.
  const endpoint0 = await startServer([...args, '--resume-grace=0']);
  const d = await connect(endpoint0, 'client-d');
  await d.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/d' } });
  await d.client.close();
  await expect.poll(() => browserContext.pages().map(p => p.url()), { timeout: 15000 }).not.toContain(server.PREFIX + '/d');
});

test('records: a closed session reopens from its record, and resume refuses what it cannot take', async ({ cdpServer, startServer, server }) => {
  test.setTimeout(60000);
  const browserContext = await cdpServer.start();
  const outputDir = test.info().outputPath('output');
  const endpoint = await startServer([`--cdp-endpoint=${cdpServer.endpoint}`, '--private-tabs', `--output-dir=${outputDir}`, '--resume-grace=1']);
  const recordFile = (token: string) => path.join(outputDir, 'sessions', `${token}.json`);
  const readRecord = (token: string) => fs.promises.readFile(recordFile(token), 'utf-8').then(JSON.parse, () => undefined);

  const a = await connect(endpoint, 'client-a');
  const token = tokenOf(await a.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/a' } }));
  await expect.poll(() => readRecord(token)).toBeTruthy();
  await a.transport.terminateSession();
  await a.client.close();
  await expect.poll(() => browserContext.pages().map(p => p.url())).not.toContain(server.PREFIX + '/a');

  // Nothing is held in memory any more, so there is no reminder, and the record reads as closed.
  const c = await connect(endpoint, 'client-c');
  const sessions = text(await c.client.callTool({ name: 'browser_sessions', arguments: {} }));
  expect(sessions).toContain(`${token} closed`);
  expect(sessions).not.toContain(kReminder);

  const resumed = text(await c.client.callTool({ name: 'browser_tabs', arguments: { action: 'resume', token } }));
  const newToken = resumed.match(/Reopened from record; this session is ([0-9a-f]{24})/)![1];
  expect(newToken).not.toBe(token);
  expect(resumed).toContain(`- 0: (current) [](${server.PREFIX}/a)`);
  expect(browserContext.pages().map(p => p.url())).toContain(server.PREFIX + '/a');
  await expect.poll(() => readRecord(newToken)).toEqual(expect.objectContaining({ tabs: [expect.objectContaining({ url: server.PREFIX + '/a' })] }));
  expect(await readRecord(token)).toBeUndefined();
  expect(text(await c.client.callTool({ name: 'browser_sessions', arguments: {} }))).toContain(`${newToken} live`);

  const e = await connect(endpoint, 'client-e');
  expect(text(await e.client.callTool({ name: 'browser_tabs', arguments: { action: 'resume', token: newToken } }))).toContain(`Session ${newToken} is in use`);
  expect(text(await e.client.callTool({ name: 'browser_tabs', arguments: { action: 'resume', token: 'deadbeefdeadbeefdeadbeef' } }))).toContain('Nothing to resume for deadbeefdeadbeefdeadbeef');
});

// Writes a stub cgroup v2 directory and returns it, so the server reads a crafted memory limit and usage.
async function stubCgroup(name: string, limit: number, usage?: number): Promise<string> {
  const dir = test.info().outputPath(name);
  await fs.promises.mkdir(dir, { recursive: true });
  await fs.promises.writeFile(path.join(dir, 'memory.max'), String(limit));
  if (usage !== undefined)
    await fs.promises.writeFile(path.join(dir, 'memory.current'), String(usage));
  return dir;
}

const readRecordAt = (outputDir: string, token: string) =>
  fs.promises.readFile(path.join(outputDir, 'sessions', `${token}.json`), 'utf-8').then(JSON.parse, () => undefined);

test('grace cap: an over-cap park evicts the oldest but keeps its record to reopen', async ({ cdpServer, startServer, server }) => {
  test.setTimeout(60000);
  const browserContext = await cdpServer.start();
  const outputDir = test.info().outputPath('output');
  // Plenty of memory headroom, so only the count cap evicts.
  const cgroupDir = await stubCgroup('cgroup1', 64 * 1024 ** 3, 1024 ** 2);
  const args = [`--cdp-endpoint=${cdpServer.endpoint}`, '--private-tabs', `--output-dir=${outputDir}`, '--resume-grace=60000', '--resume-grace-max=1'];
  const endpoint = await startServer(args, { PWMCP_CGROUP_DIR_FOR_TEST: cgroupDir });

  const a = await connect(endpoint, 'client-a');
  const tokenA = tokenOf(await a.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/a' } }));
  await expect.poll(() => readRecordAt(outputDir, tokenA)).toBeTruthy();
  await a.transport.terminateSession();
  await a.client.close();
  await expect.poll(async () => (await readRecordAt(outputDir, tokenA))?.endedAt).toEqual(expect.any(String));

  const b = await connect(endpoint, 'client-b');
  const tokenB = tokenOf(await b.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/b' } }));
  await b.transport.terminateSession();
  await b.client.close();

  // Two sessions in grace over a cap of one: the oldest, A, is evicted; B, the newest, stays.
  await expect.poll(() => browserContext.pages().map(p => p.url())).not.toContain(server.PREFIX + '/a');
  expect(browserContext.pages().map(p => p.url())).toContain(server.PREFIX + '/b');

  const c = await connect(endpoint, 'client-c');
  const sessions = text(await c.client.callTool({ name: 'browser_sessions', arguments: {} }));
  expect(sessions).toContain(`${tokenA} closed`);
  expect(sessions).toContain(`${tokenB} grace until`);
  // Eviction kept A's record, so it reopens from the record under a new token.
  expect(await readRecordAt(outputDir, tokenA)).toEqual(expect.objectContaining({ token: tokenA }));
  const resumed = text(await c.client.callTool({ name: 'browser_tabs', arguments: { action: 'resume', token: tokenA } }));
  expect(resumed).toContain('Reopened from record');
  expect(resumed).toContain(`[](${server.PREFIX}/a)`);
});

test('grace cap: the default adapts to a small memory limit', async ({ cdpServer, startServer, server }) => {
  test.setTimeout(60000);
  const browserContext = await cdpServer.start();
  const outputDir = test.info().outputPath('output');
  // 512 MB / 250 MB per window => an adaptive cap of two. No usage file, so memory stays out of it.
  const cgroupDir = await stubCgroup('cgroup2', 512 * 1024 ** 2);
  const args = [`--cdp-endpoint=${cdpServer.endpoint}`, '--private-tabs', `--output-dir=${outputDir}`, '--resume-grace=60000'];
  const endpoint = await startServer(args, { PWMCP_CGROUP_DIR_FOR_TEST: cgroupDir });

  const tokens: string[] = [];
  for (const u of ['/one', '/two', '/three']) {
    const client = await connect(endpoint, 'client' + u);
    tokens.push(tokenOf(await client.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + u } })));
    await expect.poll(() => readRecordAt(outputDir, tokens[tokens.length - 1])).toBeTruthy();
    await client.transport.terminateSession();
    await client.client.close();
    await expect.poll(async () => (await readRecordAt(outputDir, tokens[tokens.length - 1]))?.endedAt).toEqual(expect.any(String));
  }

  // Three parks over a cap of two: the oldest is evicted, its record kept.
  await expect.poll(() => browserContext.pages().map(p => p.url())).not.toContain(server.PREFIX + '/one');
  const live = await connect(endpoint, 'client-x');
  const sessions = text(await live.client.callTool({ name: 'browser_sessions', arguments: {} }));
  expect(sessions).toContain(`${tokens[0]} closed`);
  expect(sessions).toContain(`${tokens[1]} grace until`);
  expect(sessions).toContain(`${tokens[2]} grace until`);
  expect(await readRecordAt(outputDir, tokens[0])).toEqual(expect.objectContaining({ token: tokens[0] }));
});

test('grace cap: memory pressure evicts even under the count cap', async ({ cdpServer, startServer, server }) => {
  test.setTimeout(60000);
  const browserContext = await cdpServer.start();
  const outputDir = test.info().outputPath('output');
  // A bounded limit well above the count cap, but usage already over the 85% high-water mark.
  const limit = Math.min(2 * 1024 ** 3, Math.floor(os.totalmem() / 2));
  const cgroupDir = await stubCgroup('cgroup3', limit, Math.floor(limit * 0.86));
  const args = [`--cdp-endpoint=${cdpServer.endpoint}`, '--private-tabs', `--output-dir=${outputDir}`, '--resume-grace=60000', '--resume-grace-max=40'];
  const endpoint = await startServer(args, { PWMCP_CGROUP_DIR_FOR_TEST: cgroupDir });

  const a = await connect(endpoint, 'client-a');
  const tokenA = tokenOf(await a.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/a' } }));
  await expect.poll(() => readRecordAt(outputDir, tokenA)).toBeTruthy();
  await a.transport.terminateSession();
  await a.client.close();
  // A is the only park and far under the cap of 40, so its own park does not evict it.
  await expect.poll(async () => (await readRecordAt(outputDir, tokenA))?.endedAt).toEqual(expect.any(String));
  expect(browserContext.pages().map(p => p.url())).toContain(server.PREFIX + '/a');

  const b = await connect(endpoint, 'client-b');
  const tokenB = tokenOf(await b.client.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/b' } }));
  await b.transport.terminateSession();
  await b.client.close();

  // Memory is over the high-water mark, so parking B evicts the oldest park, A, though the count cap was not hit.
  await expect.poll(() => browserContext.pages().map(p => p.url())).not.toContain(server.PREFIX + '/a');
  expect(browserContext.pages().map(p => p.url())).toContain(server.PREFIX + '/b');
  const c = await connect(endpoint, 'client-c');
  const sessions = text(await c.client.callTool({ name: 'browser_sessions', arguments: {} }));
  expect(sessions).toContain(`${tokenA} closed`);
  expect(sessions).toContain(`${tokenB} grace until`);
  expect(await readRecordAt(outputDir, tokenA)).toEqual(expect.objectContaining({ token: tokenA }));
});
