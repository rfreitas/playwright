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

// Files over 50 MB cannot be sent as content, only by path, and a path is only
// accepted when the extension has "Allow access to file URLs". With that on, a
// big file has to upload; with it off, the error has to say what to turn on.
//
//   node --test packages/extension/e2e/upload-large.e2e.mjs
//
// MCP_SERVER_COMMAND selects the server under test, as in upload.e2e.mjs.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { extensionOrigin, launchBrowserWithExtension } from './harness.mjs';

const FILE_NAME = 'big-upload.bin';
const FILE_SIZE = 60 * 1024 * 1024;

const cleanups = [];
after(async () => {
  for (const cleanup of cleanups.reverse())
    await cleanup().catch(() => {});
});

async function startSession({ fileAccess }) {
  const siteServer = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(`<!doctype html><title>upload site</title>
      <button id="pick" onclick="document.getElementById('file').click()">Choose file</button>
      <input type="file" id="file" hidden>`);
  });
  await new Promise(resolve => siteServer.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise(resolve => siteServer.close(resolve)));
  const siteUrl = `http://127.0.0.1:${siteServer.address().port}/`;

  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-upload-large-'));
  fs.writeFileSync(path.join(workspace, FILE_NAME), Buffer.alloc(FILE_SIZE, 7));
  cleanups.push(async () => fs.rmSync(workspace, { recursive: true, force: true }));

  const browser = await launchBrowserWithExtension({ fileAccess });
  cleanups.push(() => browser.close());

  const [command, ...commandArgs] = process.env.MCP_SERVER_COMMAND
    ? JSON.parse(process.env.MCP_SERVER_COMMAND)
    : process.platform === 'win32' ? ['cmd', '/c', 'npx', '-y', '@playwright/mcp@latest'] : ['npx', '-y', '@playwright/mcp@latest'];
  const transport = new StdioClientTransport({
    command,
    args: [...commandArgs, '--extension', '--executable-path', process.execPath],
    env: { PLAYWRIGHT_MCP_EXTENSION_TOKEN: browser.token, DEBUG: 'pw:mcp:relay' },
    cwd: workspace,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'upload-large-e2e', version: '1.0.0' });
  await client.connect(transport);
  cleanups.push(() => client.close());

  const callTool = async (name, args) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120_000 });
    return { isError: !!result.isError, text: result.content.filter(c => c.type === 'text').map(c => c.text).join('\n') };
  };
  const callToolConnecting = async (name, args) => {
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
      client: JSON.stringify({ name: 'upload-large-e2e' }),
      protocolVersion: '2',
      token: browser.token,
    });
    const connectPage = await browser.context.newPage();
    await connectPage.goto(`${extensionOrigin}/connect.html?${params}`);
    return await result;
  };
  return { siteUrl, workspace, callTool, callToolConnecting };
}

async function chooseFile(session) {
  const navigate = await session.callToolConnecting('browser_navigate', { url: session.siteUrl });
  assert.equal(navigate.isError, false, navigate.text);
  const click = await session.callTool('browser_click', { element: 'Choose file button', target: '#pick' });
  assert.equal(click.isError, false, click.text);
  return await session.callTool('browser_file_upload', { paths: [path.join(session.workspace, FILE_NAME)] });
}

describe('uploading a file over 50 MB', () => {
  test('works when the extension may access file URLs', { timeout: 240_000 }, async () => {
    const session = await startSession({ fileAccess: true });
    const upload = await chooseFile(session);
    assert.equal(upload.isError, false, `browser_file_upload failed:\n${upload.text}`);

    const result = await session.callTool('browser_evaluate', {
      function: `() => { const f = document.getElementById('file').files[0]; return f ? { name: f.name, size: f.size } : null; }`,
    });
    assert.ok(result.text.includes(FILE_NAME) && result.text.includes(String(FILE_SIZE)), `the input has the wrong file:\n${result.text}`);
  });

  test('says what to turn on when the extension may not', { timeout: 240_000 }, async () => {
    const session = await startSession({ fileAccess: false });
    const upload = await chooseFile(session);
    assert.equal(upload.isError, true, 'a 60 MB upload cannot work without file access');
    assert.match(upload.text, /Allow access to file URLs/);
  });
});
