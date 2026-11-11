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

import * as z from 'zod';
import { defineTool } from './tool';
import { renderTabsMarkdown } from './response';
import { graceSessions, liveSessions, readRecords } from './sessions';

const browserTabs = defineTool({
  capability: 'core-tabs',

  schema: {
    name: 'browser_tabs',
    title: 'Manage tabs',
    description: 'List, create, close, or select a browser tab, or resume the tabs of an earlier session.',
    inputSchema: z.object({
      action: z.enum(['list', 'new', 'close', 'select', 'resume']).describe('Operation to perform'),
      index: z.number().optional().describe('Tab index, used for close/select. If omitted for close, current tab is closed.'),
      url: z.string().optional().describe('URL to navigate to in the new tab, used for new.'),
      isolatedContext: z.string().optional().describe('Name of an isolated browser context to create the new tab in, used for new. Tabs in the same isolated context share cookies and storage, tabs in different contexts are fully isolated. If omitted or "default", the tab is created in the default context.'),
      token: z.string().optional().describe('Session token, used for resume. The tabs of that session, as listed by browser_sessions, become this session\'s tabs.'),
    }),
    type: 'action',
  },

  handle: async (context, params, response) => {
    switch (params.action) {
      case 'list': {
        await context.ensureTab();
        response.setIncludeSession();
        break;
      }
      case 'new': {
        const tab = await context.newTab(params.isolatedContext);
        if (params.url) {
          const url = await tab.checkUrlAndNavigate(params.url);
          response.setIncludeSnapshot();
          response.addAction({ name: 'navigate', url });
        }
        break;
      }
      case 'close': {
        await context.closeTab(params.index);
        break;
      }
      case 'select': {
        if (params.index === undefined)
          throw new Error('Tab index is required');
        await context.selectTab(params.index);
        break;
      }
      case 'resume': {
        if (!params.token)
          throw new Error('Session token is required');
        if (await context.resumeSession(params.token))
          response.addTextResult(`Reopened from record; this session is ${context.sessionToken()}`);
        break;
      }
    }
    const tabHeaders = await Promise.all(context.tabs().map(tab => tab.headerSnapshot()));
    const result = renderTabsMarkdown(tabHeaders);
    response.addTextResult(result.join('\n'));
  },
});

export const browserSessions = defineTool({
  capability: 'core-tabs',

  schema: {
    name: 'browser_sessions',
    title: 'List sessions',
    description: 'List the sessions of this server, newest first: live ones, ones in grace, whose client disconnected and whose tabs are still open, and closed ones, whose tabs are recorded. browser_tabs resume with a session\'s token takes over the tabs of one in grace and reopens the tabs of a closed one.',
    inputSchema: z.object({}),
    type: 'readOnly',
  },

  handle: async (context, params, response) => {
    const lines: string[] = [];
    for (const record of await readRecords(context.sessionsDir())) {
      const grace = graceSessions.get(record.token);
      const state = liveSessions.has(record.token) ? 'live' : grace ? `grace until ${new Date(grace.closeAt).toISOString()}` : `closed ${record.updatedAt}`;
      lines.push(`- ${record.token} ${state} (${record.clientName})`);
      for (const tab of record.tabs)
        lines.push(`  - ${tab.url}`);
    }
    if (lines.length)
      lines.push('browser_tabs resume with a token takes over the tabs of a session in grace, and reopens a closed session\'s tabs from its record.');
    response.addTextResult(lines.length ? lines.join('\n') : 'No sessions');
  },
});

export default [
  browserTabs,
  browserSessions,
];
