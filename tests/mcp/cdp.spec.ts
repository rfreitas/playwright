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

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

import { test, expect, mcpServerPath } from './fixtures';

test.describe.configure({
  retries: 1,
});

test('cdp server', async ({ cdpServer, startClient, server }) => {
  await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`- generic [active] [ref=e1]: Hello, world!`),
  });
});

test('cdp server reuse tab', async ({ cdpServer, startClient, server }) => {
  const browserContext = await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });

  const [page] = browserContext.pages();
  await page.goto(server.HELLO_WORLD);

  expect(await client.callTool({
    name: 'browser_click',
    arguments: {
      element: 'Hello, world!',
      target: 'f0',
    },
  })).toHaveResponse({
    error: `Error: "f0" does not match any elements.`,
    isError: true,
  });

  expect(await client.callTool({
    name: 'browser_snapshot',
  })).toHaveResponse({
    page: `- Page URL: ${server.HELLO_WORLD}
- Page Title: Title`,
    inlineSnapshot: `- generic [active] [ref=e1]: Hello, world!`,
  });
});

test('cdp connection uses noDefaults', async ({ cdpServer, startClient }) => {
  test.info().annotations.push({ type: 'issue', description: 'https://github.com/microsoft/playwright/issues/41661' });
  const browserContext = await cdpServer.start();
  const [page] = browserContext.pages();
  await page.emulateMedia({ media: 'print' });
  expect(await page.evaluate(() => matchMedia('print').matches)).toBe(true);

  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });
  await client.callTool({ name: 'browser_snapshot' });

  expect(await page.evaluate(() => matchMedia('print').matches)).toBe(true);
});

test('should throw connection error and allow re-connecting', async ({ cdpServer, startClient, server }) => {
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });

  server.setContent('/', `
    <title>Title</title>
    <body>Hello, world!</body>
  `, 'text/html');

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    error: expect.stringContaining(`connect ECONNREFUSED`),
    isError: true,
  });
  await cdpServer.start();
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.PREFIX },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`- generic [active] [ref=e1]: Hello, world!`),
  });
});

test('auto-recover when remote browser disconnects mid-session', async ({ cdpServer, startClient, server }) => {
  const browserContext = await cdpServer.start();
  const { client } = await startClient({ args: [`--cdp-endpoint=${cdpServer.endpoint}`] });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`Hello, world!`),
  });

  // Simulate the remote browser dying mid-session (e.g. CDP endpoint session timeout).
  await browserContext.close();

  // The next call hits the dead backend; it must error and let the MCP server discard
  // the backend so the next call can transparently establish a fresh connection.
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    isError: true,
  });

  // Bring the CDP endpoint back. The next call should reconnect transparently —
  // no manual browser_close needed (regression test for playwright-mcp#1588).
  await cdpServer.start();
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`Hello, world!`),
  });
});

test('transparently reconnects when the remote browser is restarted', async ({ cdpServer, startClient, server }) => {
  const browserContext = await cdpServer.start();
  const { client, stderr } = await startClient({
    args: [`--cdp-endpoint=${cdpServer.endpoint}`],
    env: { DEBUG: 'pw:mcp:backend' },
  });

  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`Hello, world!`),
  });

  await browserContext.close();
  await expect.poll(() => stderr()).toContain('browser disconnected');
  await cdpServer.start();

  // The very next tool call must reconnect, with no failed call in between.
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    snapshot: expect.stringContaining(`Hello, world!`),
  });
});

test('does not support --device', async () => {
  const result = spawnSync('node', [
    ...mcpServerPath, '--device=Pixel 5', '--cdp-endpoint=http://localhost:1234',
  ]);
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(1);
  expect(result.stderr.toString()).toContain('Device emulation is not supported with cdpEndpoint.');
});

test('cdp server with headers', async ({ startClient, server }) => {
  let authHeader = '';
  server.setRoute('/json/version/', (req, res) => {
    authHeader = req.headers['authorization'];
    res.end();
  });

  const { client } = await startClient({ args: [`--cdp-endpoint=${server.PREFIX}`, '--cdp-header', 'Authorization: Bearer 1234567890'] });
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    isError: true,
  });
  expect(authHeader).toBe('Bearer 1234567890');
});

test('cdp server with empty and complex headers', async ({ startClient, server }) => {
  let customHeader = '';
  let emptyHeader = '';
  server.setRoute('/json/version/', (req, res) => {
    customHeader = req.headers['x-forwarded-proto'] as string;
    emptyHeader = req.headers['x-empty'] as string;
    res.end();
  });

  const { client } = await startClient({
    args: [
      `--cdp-endpoint=${server.PREFIX}`,
      '--cdp-header', 'X-Forwarded-Proto: value:with:colons',
      '--cdp-header', 'X-Empty'
    ]
  });
  expect(await client.callTool({
    name: 'browser_navigate',
    arguments: { url: server.HELLO_WORLD },
  })).toHaveResponse({
    isError: true,
  });
  expect(customHeader).toBe('value:with:colons');
  expect(emptyHeader).toBe('');
});

test('private tabs: each client has its own tabs in its own window, and they share the profile', async ({ cdpServer, startClient, server }) => {
  const browserContext = await cdpServer.start();
  const [existing] = browserContext.pages();
  await existing.goto(server.HELLO_WORLD);
  await existing.evaluate(() => { localStorage.setItem('who', 'shared'); document.cookie = 'who=shared'; });
  const args = [`--cdp-endpoint=${cdpServer.endpoint}`, '--private-tabs'];

  // A's client advertises a root of its own; private tabs do not take it as a workspace.
  const elsewhere = test.info().outputPath('elsewhere');
  const cwd = test.info().outputPath('cwd');
  await fs.promises.mkdir(elsewhere, { recursive: true });
  await fs.promises.mkdir(cwd, { recursive: true });
  const { client: a } = await startClient({ args, cwd, roots: [{ name: 'elsewhere', uri: pathToFileURL(elsewhere).toString() }] });
  const { client: b } = await startClient({ args });
  await a.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/a' } });
  await b.callTool({ name: 'browser_navigate', arguments: { url: server.PREFIX + '/b' } });

  // Neither client took the existing tab, and each one lists only its own.
  expect(existing.url()).toBe(server.HELLO_WORLD);
  expect(await a.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })).toHaveResponse({
    result: `- 0: (current) [](${server.PREFIX}/a)`,
  });
  expect(await b.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })).toHaveResponse({
    result: `- 0: (current) [](${server.PREFIX}/b)`,
  });

  // Same profile: storage written in the existing tab is visible to the clients.
  const pageA = browserContext.pages().find(p => p.url() === server.PREFIX + '/a')!;
  const pageB = browserContext.pages().find(p => p.url() === server.PREFIX + '/b')!;
  expect(await pageA.evaluate(() => localStorage.getItem('who'))).toBe('shared');
  expect(await pageB.evaluate(() => document.cookie)).toContain('who=shared');

  // Own windows, so bringing one tab to the front does not hide the other client's tab.
  const windowOf = async (page: typeof pageA) => {
    const session = await browserContext.newCDPSession(page);
    const { windowId } = await session.send('Browser.getWindowForTarget');
    await session.detach();
    return windowId;
  };
  expect(await windowOf(pageA)).not.toBe(await windowOf(existing));
  expect(await windowOf(pageA)).not.toBe(await windowOf(pageB));

  // A popup belongs to the client whose tab opened it.
  await a.callTool({ name: 'browser_evaluate', arguments: { function: `() => window.open('${server.PREFIX}/popup')` } });
  await expect.poll(async () => (await a.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })).content[0].text).toContain('popup');
  expect((await b.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })).content[0].text).not.toContain('popup');

  expect(await a.callTool({ name: 'browser_console_messages', arguments: { filename: path.join(elsewhere, '.bashrc') } })).toHaveResponse({
    error: expect.stringContaining('File access denied'),
    isError: true,
  });
  expect(fs.readdirSync(elsewhere)).toEqual([]);

  // Code run in the server process would reach every client's tabs, so that tool is not offered.
  expect((await a.listTools()).tools.map(t => t.name)).not.toContain('browser_run_code_unsafe');
  expect(await a.callTool({ name: 'browser_run_code_unsafe', arguments: { code: 'async page => page.context().pages().length' } })).toHaveResponse({
    error: 'Tool "browser_run_code_unsafe" not found',
    isError: true,
  });

  // A client that disconnects takes its tabs with it, and leaves everyone else's alone.
  await a.close();
  await expect.poll(() => browserContext.pages().map(p => p.url()).sort()).toEqual([server.HELLO_WORLD, server.PREFIX + '/b'].sort());
});
