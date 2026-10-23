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

// Retries must not litter the browser with connect pages. Each connection
// attempt of the server is answered here with a connect page, the way launching
// the browser does for a user.
//
//   node --test packages/extension/e2e/reconnect.e2e.mjs
//
// MCP_SERVER_COMMAND selects the server under test, as in upload.e2e.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { extensionOrigin } from './harness.mjs';
import { launchRawBrowserWithExtension } from './rawBrowser.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let browser;
let siteServer;
let siteUrl;
let workspace;
const sessions = [];

before(async () => {
  siteServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>reconnect site</title>site');
  });
  await new Promise(resolve => siteServer.listen(0, '127.0.0.1', resolve));
  siteUrl = `http://127.0.0.1:${siteServer.address().port}/`;
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-reconnect-'));
  browser = await launchRawBrowserWithExtension();
});

after(async () => {
  for (const session of sessions)
    await session.client.close().catch(() => {});
  await browser?.close();
  await new Promise(resolve => siteServer.close(resolve));
  fs.rmSync(workspace, { recursive: true, force: true });
});

// A server of its own, whose token and connect timeout the test chooses.
async function startSession({ token, connectTimeout }) {
  const [command, ...commandArgs] = process.env.MCP_SERVER_COMMAND
    ? JSON.parse(process.env.MCP_SERVER_COMMAND)
    : process.platform === 'win32' ? ['cmd', '/c', 'npx', '-y', '@playwright/mcp@latest'] : ['npx', '-y', '@playwright/mcp@latest'];
  const transport = new StdioClientTransport({
    command,
    args: [...commandArgs, '--extension', '--executable-path', process.execPath],
    env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: token, DEBUG: 'pw:mcp:relay', PWTEST_EXTENSION_CONNECT_TIMEOUT: String(connectTimeout) },
    cwd: workspace,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'reconnect-e2e', version: '1.0.0' });
  await client.connect(transport);
  const session = { client, announced: [] };
  transport.stderr.on('data', chunk => {
    for (const match of chunk.toString().matchAll(/extension endpoint: (ws:\/\/\S+?)\.?\s/g))
      session.announced.push(match[1]);
  });
  sessions.push(session);
  return session;
}

async function callTool(session, name, args) {
  const result = await session.client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { isError: !!result.isError, text };
}

// Answers the server's next connection attempt with a connect page.
async function callToolConnecting(session, name, args) {
  const attemptsBefore = session.announced.length;
  const result = callTool(session, name, args);
  for (let i = 0; i < 100 && session.announced.length === attemptsBefore; i++)
    await sleep(200);
  if (session.announced.length === attemptsBefore) {
    const outcome = await Promise.race([result, sleep(1000).then(() => 'pending')]);
    assert.fail(`the server made no attempt to connect to the extension; the call ${outcome === 'pending' ? 'is still pending' : 'returned: ' + JSON.stringify(outcome)}`);
  }
  const params = new URLSearchParams({
    mcpRelayUrl: session.announced[session.announced.length - 1],
    client: JSON.stringify({ name: 'reconnect-e2e' }),
    protocolVersion: '2',
    token: session.token,
  });
  await browser.newTab(`${extensionOrigin}/connect.html?${params}`);
  return await result;
}

async function connectPages() {
  return (await browser.targets()).filter(t => t.url.startsWith(`${extensionOrigin}/connect.html`));
}

describe('losing the connection', () => {
  test('the next call reconnects and leaves no connect pages behind', { timeout: 180_000 }, async () => {
    const session = await startSession({ token: browser.token, connectTimeout: 30_000 });
    session.token = browser.token;
    const first = await callToolConnecting(session, 'browser_navigate', { url: siteUrl });
    assert.equal(first.isError, false, first.text);

    // The user closes the controlled tab; the extension ends the connection.
    const controlled = (await browser.targets()).find(t => t.url.startsWith(siteUrl));
    assert.ok(controlled, 'the controlled tab is not on the site');
    await browser.closeTab(controlled);
    await sleep(1500);

    const second = await callToolConnecting(session, 'browser_navigate', { url: siteUrl });
    assert.equal(second.isError, false, second.text);
    await sleep(500);

    assert.deepEqual((await connectPages()).map(t => t.url.slice(0, 80)), [], 'connect pages were left open');
  });
});

describe('attempts that fail', () => {
  test('retrying leaves at most one connect page open', { timeout: 180_000 }, async () => {
    // A token the extension does not know: the connect page waits for the user to approve
    // and the attempt times out, as when the user is away or the token went stale.
    const session = await startSession({ token: 'not-the-extensions-token', connectTimeout: 3000 });
    session.token = 'not-the-extensions-token';
    for (let attempt = 1; attempt <= 3; attempt++) {
      const result = await callToolConnecting(session, 'browser_navigate', { url: siteUrl });
      assert.equal(result.isError, true, `attempt ${attempt} should have timed out:\n${result.text}`);
      assert.match(result.text, /did not connect/);
    }
    await sleep(500);

    const pages = await connectPages();
    assert.ok(pages.length <= 1, `${pages.length} connect pages are open after 3 failed attempts`);
  });
});
