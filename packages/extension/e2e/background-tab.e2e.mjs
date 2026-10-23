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

// A tab that is not the active tab of its window is hidden: Chrome stops
// painting it, requestAnimationFrame never fires and pages such as Gmail hold
// uploads until it is visible again. Playwright's click waits on
// requestAnimationFrame too, so the agent's call hangs and nothing says why.
// This opens a tab over the controlled one and drives it through a real MCP
// server in --extension mode.
//
// Needs a window, so it cannot run headless. A browser window opens briefly.
//
//   node --test packages/extension/e2e/background-tab.e2e.mjs
//
// MCP_SERVER_COMMAND selects the server under test, as in upload.e2e.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { extensionOrigin } from './harness.mjs';
import { launchRawBrowserWithExtension } from './rawBrowser.mjs';

// The work only finishes while the page is visible, the way Gmail's upload does.
const PAGE = `<!doctype html><title>visibility site</title>
  <button id="go">Go</button>
  <div id="status">idle</div>
  <script>
    document.getElementById('go').onclick = async () => {
      const status = document.getElementById('status');
      status.textContent = 'working';
      if (document.visibilityState !== 'visible')
        await new Promise(resolve => document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && resolve()));
      status.textContent = 'done';
    };
  </script>`;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let browser;
let siteServer;
let siteUrl;
let workspace;
let client;
let transport;

before(async () => {
  siteServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(PAGE);
  });
  await new Promise(resolve => siteServer.listen(0, '127.0.0.1', resolve));
  siteUrl = `http://127.0.0.1:${siteServer.address().port}/`;
  workspace = fs.mkdtempSync(os.tmpdir() + '/pw-ext-bg-');

  browser = await launchRawBrowserWithExtension();

  const [command, ...commandArgs] = process.env.MCP_SERVER_COMMAND
    ? JSON.parse(process.env.MCP_SERVER_COMMAND)
    : process.platform === 'win32' ? ['cmd', '/c', 'npx', '-y', '@playwright/mcp@latest'] : ['npx', '-y', '@playwright/mcp@latest'];
  transport = new StdioClientTransport({
    command,
    args: [...commandArgs, '--extension', '--executable-path', process.execPath],
    env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: browser.token, DEBUG: 'pw:mcp:relay' },
    cwd: workspace,
    stderr: 'pipe',
  });
  client = new Client({ name: 'background-tab-e2e', version: '1.0.0' });
  await client.connect(transport);
});

after(async () => {
  await client?.close().catch(() => {});
  await browser?.close();
  await new Promise(resolve => siteServer.close(resolve));
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function callTool(name, args) {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
  const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
  return { isError: !!result.isError, text };
}

// The server connects on the first tool call and announces the relay endpoint
// on stderr; opening the connect page with the token is what launching the
// browser does for a user.
async function callToolConnecting(name, args) {
  const endpoint = new Promise(resolve => {
    transport.stderr.on('data', chunk => {
      const match = /extension endpoint: (ws:\/\/\S+?)\.?\s/.exec(chunk.toString());
      if (match)
        resolve(match[1]);
    });
  });
  const result = callTool(name, args);
  const params = new URLSearchParams({
    mcpRelayUrl: await endpoint,
    client: JSON.stringify({ name: 'background-tab-e2e' }),
    protocolVersion: '2',
    token: browser.token,
  });
  await browser.newTab(`${extensionOrigin}/connect.html?${params}`);
  return await result;
}

async function siteTarget() {
  const targets = await browser.targets();
  const target = targets.find(t => t.url.startsWith(siteUrl));
  assert.ok(target, `no tab is on ${siteUrl}: ${targets.map(t => t.url).join(', ')}`);
  return target;
}

let connected = false;

// Loads the site in the controlled tab, connecting the extension on first use.
async function openSite() {
  const navigate = connected
    ? await callTool('browser_navigate', { url: siteUrl })
    : await callToolConnecting('browser_navigate', { url: siteUrl });
  connected = true;
  assert.equal(navigate.isError, false, navigate.text);
  return await siteTarget();
}

async function waitForStatus(target, expected) {
  let status;
  for (let i = 0; i < 20 && status !== expected; i++) {
    status = await browser.evaluate(target, `document.getElementById('status').textContent`);
    if (status !== expected)
      await sleep(250);
  }
  return status;
}

// What the agent does must not change what the user sees: the tab they are on
// stays the active tab, and a minimized window stays minimized.
describe('a controlled tab that is hidden', () => {
  test('behind another tab, a click finishes and the user keeps their tab', { timeout: 150_000 }, async () => {
    const controlled = await openSite();
    assert.equal(await browser.evaluate(controlled, 'document.visibilityState'), 'visible');
    const cover = await browser.newTab('about:blank');
    await sleep(500);

    const click = await callTool('browser_click', { element: 'Go button', target: '#go' });
    const status = await waitForStatus(controlled, 'done');
    const coverVisibility = await browser.evaluate(cover, 'document.visibilityState').catch(() => 'gone');
    await browser.closeTab(cover).catch(() => {});

    assert.equal(status, 'done', `the page never finished; browser_click ${click.isError ? 'failed' : 'returned'}:\n${click.text}`);
    assert.equal(click.isError, false, click.text);
    assert.equal(coverVisibility, 'visible', 'the controlled tab was brought to the front over the tab the user was on');
  });

  test('behind another tab, a screenshot is taken without switching tabs', { timeout: 150_000 }, async () => {
    const controlled = await openSite();
    const cover = await browser.newTab('about:blank');
    await sleep(500);

    const started = Date.now();
    const result = await client.callTool({ name: 'browser_take_screenshot', arguments: { type: 'png' } }, undefined, { timeout: 60_000 });
    const elapsed = Date.now() - started;
    const coverVisibility = await browser.evaluate(cover, 'document.visibilityState').catch(() => 'gone');
    await browser.closeTab(cover).catch(() => {});

    const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    assert.ok(!result.isError, `the screenshot failed after ${elapsed}ms:\n${text}`);
    assert.equal(coverVisibility, 'visible', 'the controlled tab was brought to the front over the tab the user was on');
    assert.ok(controlled);
  });

  test('in a minimized window, a click finishes and the window stays minimized', { timeout: 150_000 }, async () => {
    const controlled = await openSite();
    await browser.setWindowState(controlled, 'minimized');
    try {
      await sleep(500);
      assert.equal(await browser.windowState(controlled), 'minimized', 'the window did not minimize; the test setup is wrong');

      const click = await callTool('browser_click', { element: 'Go button', target: '#go' });
      const status = await waitForStatus(controlled, 'done');
      const windowState = await browser.windowState(controlled);

      assert.equal(status, 'done', `the page never finished; browser_click ${click.isError ? 'failed' : 'returned'}:\n${click.text}`);
      assert.equal(click.isError, false, click.text);
      assert.equal(windowState, 'minimized', 'the window was restored');
    } finally {
      await browser.setWindowState(controlled, 'normal').catch(() => {});
    }
  });
});

describe('the agent managing tabs', () => {
  async function targetIds() {
    return new Set((await browser.targets()).map(t => t.id));
  }

  async function closeNewTargets(before) {
    for (const target of await browser.targets()) {
      if (!before.has(target.id))
        await browser.closeTab(target).catch(() => {});
    }
  }

  test('a tab the agent opens does not come to the front', { timeout: 150_000 }, async () => {
    await openSite();
    const userTab = await browser.newTab('about:blank');
    await sleep(500);
    const before = await targetIds();

    const result = await callTool('browser_tabs', { action: 'new', url: 'about:blank' });
    await sleep(800);
    const userVisibility = await browser.evaluate(userTab, 'document.visibilityState').catch(() => 'gone');
    const opened = [...await targetIds()].filter(id => !before.has(id));
    await closeNewTargets(before);
    await browser.closeTab(userTab).catch(() => {});

    assert.equal(result.isError, false, result.text);
    assert.equal(opened.length, 1, 'the agent should have opened one tab');
    assert.equal(userVisibility, 'visible', 'the new tab was brought to the front over the tab the user was on');
  });

  test('selecting a tab does not switch the tab the user is on', { timeout: 150_000 }, async () => {
    await openSite();
    const opened = await callTool('browser_tabs', { action: 'new', url: siteUrl });
    assert.equal(opened.isError, false, opened.text);
    await sleep(500);
    const userTab = await browser.newTab('about:blank');
    await sleep(500);
    const before = await targetIds();

    const select = await callTool('browser_tabs', { action: 'select', index: 0 });
    await sleep(800);
    const userVisibility = await browser.evaluate(userTab, 'document.visibilityState').catch(() => 'gone');
    await browser.closeTab(userTab).catch(() => {});

    assert.equal(select.isError, false, select.text);
    assert.equal(userVisibility, 'visible', 'selecting a tab for the agent switched the browser to it');
    assert.ok(before.size > 0);
  });
});
