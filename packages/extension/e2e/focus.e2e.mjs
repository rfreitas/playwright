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

// The agent must not change what the user is looking at. The user's tab here is a
// tab the test opens in the browser; it is the active tab, so it reports "visible"
// (the agent's tabs report visible whatever happens, because the server emulates
// focus, so only the user's tab can tell). Any tab that comes to the front over it
// makes it "hidden".
//
//   node --test packages/extension/e2e/focus.e2e.mjs
//
// MCP_SERVER_COMMAND selects the server under test, as in upload.e2e.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { launchRawBrowserWithExtension } from './rawBrowser.mjs';
import { startMcpSession } from './mcpSession.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let browser;
let siteServer;
let siteUrl;
let workspace;
const sessions = [];

before(async () => {
  siteServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>focus site</title><button id="go">Go</button>');
  });
  await new Promise(resolve => siteServer.listen(0, '127.0.0.1', resolve));
  siteUrl = `http://127.0.0.1:${siteServer.address().port}/`;
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-focus-'));
  browser = await launchRawBrowserWithExtension();
});

after(async () => {
  for (const session of sessions)
    await session.close();
  await browser?.close();
  await new Promise(resolve => siteServer.close(resolve));
  fs.rmSync(workspace, { recursive: true, force: true });
});

async function newSession() {
  const session = await startMcpSession({ browser, workspace });
  sessions.push(session);
  return session;
}

// The tab the user is on.
async function openUserTab() {
  const tab = await browser.newTab('about:blank');
  await sleep(500);
  assert.equal(await browser.evaluate(tab, 'document.visibilityState'), 'visible', 'the test could not make the user tab active');
  return tab;
}

async function assertUserStillThere(userTab, step) {
  await sleep(300);
  const visibility = await browser.evaluate(userTab, 'document.visibilityState').catch(() => 'gone');
  assert.equal(visibility, 'visible', `after ${step}, another tab is in front of the tab the user was on`);
}

describe('with a connection that is already open', () => {
  test('nothing the agent does moves the user off their tab', { timeout: 180_000 }, async () => {
    const session = await newSession();
    const url = `${siteUrl}open`;
    const connect = await session.callToolConnecting('browser_navigate', { url });
    assert.equal(connect.isError, false, connect.text);

    // The user goes back to their own tab; connecting is checked separately below.
    const userTab = await openUserTab();

    const steps = [
      ['browser_navigate', { url }],
      ['browser_tabs', { action: 'new', url }],
      ['browser_snapshot', {}],
      ['browser_take_screenshot', { type: 'png' }],
      ['browser_click', { element: 'Go button', target: '#go' }],
      ['browser_tabs', { action: 'select', index: 0 }],
      ['browser_evaluate', { function: '() => document.title' }],
      ['browser_tabs', { action: 'close', index: 1 }],
    ];
    for (const [name, args] of steps) {
      const result = await session.callTool(name, args);
      assert.equal(result.isError, false, `${name} ${JSON.stringify(args)} failed:\n${result.text}`);
      await assertUserStillThere(userTab, `${name} ${JSON.stringify(args)}`);
    }
    await browser.closeTab(userTab).catch(() => {});
  });
});

describe('connecting', () => {
  test('the first connection leaves the user on their tab', { timeout: 180_000 }, async () => {
    const userTab = await openUserTab();
    const session = await newSession();

    const result = await session.callToolConnecting('browser_navigate', { url: `${siteUrl}first` });
    assert.equal(result.isError, false, result.text);

    await assertUserStillThere(userTab, 'connecting for the first time');
    await browser.closeTab(userTab).catch(() => {});
  });

  test('reconnecting after the connection is lost leaves the user on their tab', { timeout: 180_000 }, async () => {
    const session = await newSession();
    const url = `${siteUrl}reconnect`;
    const first = await session.callToolConnecting('browser_navigate', { url });
    assert.equal(first.isError, false, first.text);

    // The user closes the controlled tab, which ends the connection.
    const controlled = (await browser.targets()).find(t => t.url.startsWith(url));
    assert.ok(controlled, 'the controlled tab is not on the site');
    await browser.closeTab(controlled);
    await sleep(1500);

    const userTab = await openUserTab();
    const second = await session.callToolConnecting('browser_navigate', { url });
    assert.equal(second.isError, false, second.text);

    await assertUserStillThere(userTab, 'reconnecting');
    await browser.closeTab(userTab).catch(() => {});
  });
});
