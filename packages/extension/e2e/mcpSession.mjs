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
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { extensionOrigin } from './harness.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A Playwright MCP server in --extension mode, talking to a browser from
// rawBrowser.mjs. The server under test is the published @playwright/mcp unless
// MCP_SERVER_COMMAND is a JSON array, e.g. ["node","C:/repo/packages/playwright-core/cli.js","mcp"].
//
// The server connects on a tool call by launching the browser with a connect page.
// The tests launch no browser; they open the connect page themselves, the way the
// launch would, which makes it the active tab.
export async function startMcpSession({ browser, workspace, token = browser.token, connectTimeout = 30_000 }) {
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
  const client = new Client({ name: 'e2e', version: '1.0.0' });
  await client.connect(transport);

  const announced = [];
  let serverId;
  transport.stderr.on('data', chunk => {
    const text = chunk.toString();
    for (const match of text.matchAll(/extension endpoint: (ws:\/\/\S+?)\.?\s/g))
      announced.push(match[1]);
    const id = /server id: (\S+)/.exec(text);
    if (id)
      serverId = id[1];
  });

  const callTool = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 60_000 });
    const text = result.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
    return { isError: !!result.isError, text };
  };

  // Answers the server's next connection attempt with a connect page, as the browser launch does.
  const callToolConnecting = async (name, args = {}) => {
    const attemptsBefore = announced.length;
    const result = callTool(name, args);
    for (let i = 0; i < 100 && announced.length === attemptsBefore; i++)
      await sleep(200);
    if (announced.length === attemptsBefore) {
      const outcome = await Promise.race([result, sleep(1000).then(() => 'pending')]);
      assert.fail(`the server made no attempt to connect to the extension; the call ${outcome === 'pending' ? 'is still pending' : 'returned: ' + JSON.stringify(outcome)}`);
    }
    const params = new URLSearchParams({
      mcpRelayUrl: announced[announced.length - 1],
      client: JSON.stringify({ name: 'e2e' }),
      protocolVersion: '2',
      token,
      ...(serverId ? { serverId } : {}),
    });
    await browser.newTab(`${extensionOrigin}/connect.html?${params}`);
    return await result;
  };

  return { callTool, callToolConnecting, close: () => client.close().catch(() => {}) };
}
