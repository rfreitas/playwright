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

// Uploads a file through a real Playwright MCP server in --extension mode,
// driving Playwright's Chromium with the built extension loaded. The extension
// has no "Allow access to file URLs", which is how it runs for most users, and
// that makes Chrome refuse DOM.setFileInputFiles with "Not allowed".
//
//   node --test packages/extension/e2e/upload.e2e.mjs
//
// The server under test defaults to the published @playwright/mcp. To test a
// local build, set MCP_SERVER_COMMAND to a JSON array, e.g.
//   MCP_SERVER_COMMAND='["node","C:/path/to/cli.js","run-mcp-server"]'

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { extensionOrigin, launchBrowserWithExtension } from './harness.mjs';

const FILE_NAME = 'upload-test.txt';
const FILE_CONTENT = 'hello from the e2e upload test';

let browser;
let siteServer;
let siteUrl;
let workspace;
let client;
let transport;

before(async () => {
  siteServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>upload site</title>
      <button id="pick" onclick="document.getElementById('file').click()">Choose file</button>
      <input type="file" id="file" hidden>`);
  });
  await new Promise(resolve => siteServer.listen(0, '127.0.0.1', resolve));
  siteUrl = `http://127.0.0.1:${siteServer.address().port}/`;

  // The file sits inside the MCP server's workspace root, the only place it may read from.
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-upload-'));
  fs.writeFileSync(path.join(workspace, FILE_NAME), FILE_CONTENT);

  browser = await launchBrowserWithExtension();

  const [command, ...commandArgs] = process.env.MCP_SERVER_COMMAND
    ? JSON.parse(process.env.MCP_SERVER_COMMAND)
    : process.platform === 'win32' ? ['cmd', '/c', 'npx', '-y', '@playwright/mcp@latest'] : ['npx', '-y', '@playwright/mcp@latest'];
  transport = new StdioClientTransport({
    command,
    args: [
      ...commandArgs,
      '--extension',
      // The server launches this to open the connect page. Node exits at once on
      // the URL it is given, so no real browser is touched; the test opens the
      // connect page itself, in the browser that has the extension.
      '--executable-path', process.execPath,
    ],
    env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: browser.token, DEBUG: 'pw:mcp:relay' },
    cwd: workspace,
    stderr: 'pipe',
  });
  client = new Client({ name: 'upload-e2e', version: '1.0.0' });
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

// The server connects to the extension on the first tool call. It announces the
// relay endpoint on stderr; opening the connect page in our browser, with the
// token, is what a user's browser does when the server launches it.
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
    client: JSON.stringify({ name: 'upload-e2e' }),
    protocolVersion: '2',
    token: browser.token,
  });
  const connectPage = await browser.context.newPage();
  await connectPage.goto(`${extensionOrigin}/connect.html?${params}`);
  return await result;
}

describe('file upload through the extension', () => {
  test('uploads a file from the workspace into a file input', { timeout: 150_000 }, async () => {
    const navigate = await callToolConnecting('browser_navigate', { url: siteUrl });
    assert.equal(navigate.isError, false, navigate.text);

    // Clicking the button opens the file chooser, which the next call fills.
    const click = await callTool('browser_click', { element: 'Choose file button', target: '#pick' });
    assert.equal(click.isError, false, click.text);
    assert.match(click.text, /file chooser/i);

    const upload = await callTool('browser_file_upload', { paths: [path.join(workspace, FILE_NAME)] });
    assert.equal(upload.isError, false, `browser_file_upload failed:\n${upload.text}`);

    const result = await callTool('browser_evaluate', {
      function: `async () => { const f = document.getElementById('file').files[0]; return f ? { name: f.name, text: await f.text() } : null; }`,
    });
    assert.equal(result.isError, false, result.text);
    assert.ok(result.text.includes(FILE_NAME), `the input has no file:\n${result.text}`);
    assert.ok(result.text.includes(FILE_CONTENT), `the file content did not arrive:\n${result.text}`);
  });
});
