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

import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import WebSocket from 'ws';
import { distDir, extensionId, extensionOrigin } from './harness.mjs';

// Chromium with the built extension, started directly and driven over a plain
// CDP port. Playwright keeps focus and visibility emulation on for every page
// it launches, so a background tab still reports "visible" there. Tab and
// window state only behaves like a real browser when Playwright is not the
// one that started it. Headed only: headless has no windows to cover.
async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  await new Promise(resolve => server.close(resolve));
  return port;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// One CDP command over its own connection to a target or to the browser.
async function send(wsUrl, method, params) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  try {
    const response = await new Promise((resolve, reject) => {
      ws.once('message', data => resolve(JSON.parse(data.toString())));
      ws.once('error', reject);
      ws.send(JSON.stringify({ id: 1, method, params }));
    });
    if (response.error)
      throw new Error(`${method}: ${JSON.stringify(response.error)}`);
    return response.result;
  } finally {
    ws.close();
  }
}

// How the browser is kept out of the way of whoever runs the tests.
const MODE_ARGS = {
  headless: ['--headless=new'],
  offscreen: ['--window-position=-32000,-32000', '--window-size=900,700'],
  minimized: ['--start-minimized'],
  headed: [],
};

export async function launchRawBrowserWithExtension({ mode = process.env.PW_E2E_BROWSER_MODE ?? 'headless' } = {}) {
  assert.ok(MODE_ARGS[mode], `unknown browser mode "${mode}", expected one of ${Object.keys(MODE_ARGS).join(', ')}`);
  assert.ok(fs.existsSync(path.join(distDir, 'manifest.json')), `Build the extension first: ${distDir} is missing`);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-raw-'));
  const port = await freePort();
  const child = spawn(chromium.executablePath(), [
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${port}`,
    `--disable-extensions-except=${distDir}`,
    `--load-extension=${distDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    ...MODE_ARGS[mode],
    'about:blank',
  ], { stdio: 'ignore' });

  const http = async (pathname, method = 'GET') => {
    const response = await fetch(`http://127.0.0.1:${port}${pathname}`, { method });
    return await response.json();
  };

  const browserSend = async (method, params) => {
    const { webSocketDebuggerUrl } = await http('/json/version');
    return await send(webSocketDebuggerUrl, method, params);
  };

  const close = async () => {
    // Chromium's helper processes outlive the main one and keep the profile locked,
    // so stop everything that was started on this profile, and nothing else.
    if (process.platform === 'win32') {
      const script = `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${path.basename(userDataDir)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
      try { execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'ignore' }); } catch {}
    } else {
      child.kill('SIGKILL');
    }
    await sleep(1000);
    fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  };

  const browser = {
    port,
    userDataDir,
    executablePath: chromium.executablePath(),
    close,
    // Opens a tab in the focused window; like any new tab it comes to the front.
    async newTab(url) {
      // The endpoint decodes its query once, which would mangle the parameters of the URL.
      return await http(`/json/new?${encodeURIComponent(url)}`, 'PUT');
    },
    async closeTab(target) {
      await fetch(`http://127.0.0.1:${port}/json/close/${target.id}`);
    },
    async activateTab(target) {
      await fetch(`http://127.0.0.1:${port}/json/activate/${target.id}`);
    },
    async targets() {
      return (await http('/json/list')).filter(target => target.type === 'page');
    },
    async evaluate(target, expression) {
      const result = await send(target.webSocketDebuggerUrl, 'Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      if (result.exceptionDetails)
        throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    },
    // The state of the browser window that holds the tab: 'normal', 'minimized', ...
    async windowState(target) {
      const { windowId } = await browserSend('Browser.getWindowForTarget', { targetId: target.id });
      return (await browserSend('Browser.getWindowBounds', { windowId })).bounds.windowState;
    },
    async setWindowState(target, windowState) {
      const { windowId } = await browserSend('Browser.getWindowForTarget', { targetId: target.id });
      await browserSend('Browser.setWindowBounds', { windowId, bounds: { windowState } });
    },
    // The target for a tab, found again by its id: /json/list reflects navigations.
    async targetById(id) {
      return (await browser.targets()).find(target => target.id === id);
    },
  };

  try {
    for (let i = 0; ; i++) {
      try { await http('/json/version'); break; } catch (error) {
        if (i > 100)
          throw error;
        await sleep(200);
      }
    }
    // The status page creates the auth token that lets a connect page skip the approval click.
    const status = await browser.newTab(`${extensionOrigin}/status.html`);
    let token;
    for (let i = 0; i < 50 && !token; i++) {
      token = await browser.evaluate(status, `localStorage.getItem('auth-token')`).catch(() => null);
      if (!token)
        await sleep(200);
    }
    assert.ok(token, `the extension (${extensionId}) did not create an auth token`);
    await browser.closeTab(status);
    return { ...browser, token };
  } catch (error) {
    await close();
    throw error;
  }
}
