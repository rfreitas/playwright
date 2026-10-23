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

// End-to-end tests of the built extension (`dist/`) in a real Chromium, with a
// fake relay standing in for the MCP server. Run `vite build` first, then:
//   node --test packages/extension/e2e/
// Needs `playwright` (with its Chromium) and `ws`; branded Chrome 137+ ignores
// --load-extension, so the test uses Playwright's own Chromium build.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, before, beforeEach, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { FakeRelay } from './fakeRelay.mjs';

const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
const extensionId = 'mmlmfjhmonkocbjadbfplnigmagldckm';
const extensionOrigin = `chrome-extension://${extensionId}`;

let userDataDir;
let context;
let token;
let relays;
// An extension page that is not under control: it calls chrome.* APIs for the
// tests and is the tab in front while the controlled one sits in the background.
let helper;
// A plain web page for the controlled tab to sit on, as it would on a real site.
let siteServer;
let siteUrl;

before(async () => {
  siteServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end('<!doctype html><title>e2e site</title><h1>e2e site</h1><input type="file" id="file">');
  });
  await new Promise(resolve => siteServer.listen(0, '127.0.0.1', resolve));
  siteUrl = `http://127.0.0.1:${siteServer.address().port}/`;

  assert.ok(fs.existsSync(path.join(distDir, 'manifest.json')), `Build the extension first: ${distDir} is missing`);
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-e2e-'));
  context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
  });
  if (!context.serviceWorkers().length)
    await context.waitForEvent('serviceworker');

  // The status page creates the auth token that lets a connect page skip the approval click.
  helper = await context.newPage();
  await helper.goto(`${extensionOrigin}/status.html`);
  await helper.waitForFunction(() => localStorage.getItem('auth-token'));
  token = await helper.evaluate(() => localStorage.getItem('auth-token'));
});

after(async () => {
  await context?.close();
  await new Promise(resolve => siteServer.close(resolve));
  fs.rmSync(userDataDir, { recursive: true, force: true });
});

beforeEach(() => {
  relays = [];
});

afterEach(async () => {
  await Promise.all(relays.map(relay => relay.stop()));
  for (const page of context.pages()) {
    if (page !== helper)
      await page.close().catch(() => {});
  }
  await helper.bringToFront();
});

// A tab opened while an attached tab is in front gets that tab as its opener,
// which the extension treats as a popup to control. Open from the helper instead.
async function newPage() {
  await helper.bringToFront();
  return await context.newPage();
}

async function startRelay() {
  const relay = new FakeRelay();
  await relay.start();
  relays.push(relay);
  return relay;
}

function connectUrl(relayUrl, withToken = token) {
  const params = new URLSearchParams({
    mcpRelayUrl: relayUrl,
    client: JSON.stringify({ name: 'e2e' }),
    protocolVersion: '2',
  });
  if (withToken)
    params.set('token', withToken);
  return `${extensionOrigin}/connect.html?${params}`;
}

// Opens a connect page that the token lets through, and returns once the
// relay has attached the tab the extension handed it.
async function connectClient(relay) {
  const page = await newPage();
  await page.goto(connectUrl(relay.url()));
  const created = await relay.waitForMessage(m => m.method === 'chrome.tabs.onCreated', 'the initial tab announcement');
  const tabId = created.params[0].id;
  await relay.waitForMessage(m => m.method === 'extension.initialized', 'extension.initialized');
  await waitUntil(() => relay.attachedTabIds.has(tabId), `tab ${tabId} to be attached`);
  // Leave the connect page like a client would. Navigating off an extension page
  // may detach the debugger, so wait for the extension to settle on attached.
  await page.goto(siteUrl);
  await relay.expectStaysOpen(500);
  await waitUntil(() => relay.attachedTabIds.has(tabId), `tab ${tabId} to be attached after navigating to the site`);
  // Put the helper in front so the controlled tab can be discarded.
  await helper.bringToFront();
  return { page, tabId };
}

async function waitUntil(condition, description, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`Timed out after ${timeout}ms waiting for ${description}. Relay traffic:\n${relays.map(r => r.summary()).join('\n--\n')}`);
    await new Promise(resolve => setTimeout(resolve, 50));
  }
}

describe('connecting', () => {
  test('a valid token connects without an approval click', async () => {
    const relay = await startRelay();
    const { page, tabId } = await connectClient(relay);
    assert.ok(tabId);
    assert.equal(relay.closed, undefined);
    assert.equal(page.url(), siteUrl);
  });
});

describe('discarded tabs', () => {
  test('a discarded controlled tab is replaced and the connection stays open', async () => {
    const relay = await startRelay();
    const { tabId } = await connectClient(relay);

    await helper.evaluate(id => chrome.tabs.discard(id), tabId);

    // Chrome swaps the tab for a discarded copy under a new id and detaches the debugger.
    await relay.waitForMessage(m => m.method === 'chrome.debugger.onDetach' && m.params[0].tabId === tabId && m.params[1] === 'target_closed', 'the debugger detach');
    const replacement = await relay.waitForMessage(m => m.method === 'chrome.tabs.onCreated' && m.params[0].id !== tabId, 'the replacement tab announcement');
    const replacementId = replacement.params[0].id;
    await waitUntil(() => relay.attachedTabIds.has(replacementId) || relay.attachErrors.has(replacementId), `replacement tab ${replacementId} to be attached`);
    assert.equal(relay.attachErrors.get(replacementId), undefined, 'attaching the replacement tab failed');

    await relay.expectStaysOpen(3_000);
    assert.ok(relay.attachedTabIds.has(replacementId));
    const tab = await helper.evaluate(id => chrome.tabs.get(id), replacementId);
    assert.equal(tab.discarded, false, 'the replacement tab is awake');
  });

  test('attached tabs are not auto-discardable', async () => {
    const relay = await startRelay();
    const { tabId } = await connectClient(relay);
    await expectAutoDiscardable(helper, tabId, false);
  });
});

describe('lost tabs', () => {
  test('closing the only controlled tab closes the connection', async () => {
    const relay = await startRelay();
    const { tabId } = await connectClient(relay);

    await helper.evaluate(id => chrome.tabs.remove(id), tabId);

    const closed = await relay.waitForClose('the connection to close after the last tab was closed');
    assert.equal(closed.reason, 'All controlled tabs detached');
  });
});

describe('stale connect pages', () => {
  test('connecting a client closes connect pages left by dead relays', async () => {
    const live = await startRelay();
    const { page: livePage } = await connectClient(live);

    // A connect page whose relay is gone: it can never connect and is never closed.
    const dead = await startRelay();
    const deadUrl = dead.url();
    await dead.stop();
    const stalePage = await newPage();
    await stalePage.goto(connectUrl(deadUrl));
    await stalePage.waitForFunction(() => document.body.innerText.length > 0);
    assert.equal(stalePage.isClosed(), false);

    const next = await startRelay();
    await connectClient(next);

    await waitUntil(() => stalePage.isClosed(), 'the stale connect page to be closed');
    assert.equal(livePage.isClosed(), false, 'the connected page is kept');
    assert.equal(live.closed, undefined, 'the other client stays connected');
  });
});

async function expectAutoDiscardable(helper, tabId, expected) {
  const deadline = Date.now() + 5_000;
  let actual;
  while (Date.now() < deadline) {
    actual = (await helper.evaluate(id => chrome.tabs.get(id), tabId)).autoDiscardable;
    if (actual === expected)
      return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(actual, expected, `autoDiscardable of tab ${tabId}`);
}
