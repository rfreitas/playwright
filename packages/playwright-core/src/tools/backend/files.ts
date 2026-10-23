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

import fs from 'fs';
import path from 'path';

import * as z from 'zod';
import { formatObject } from '@isomorphic/stringUtils';
import { getMimeTypeForPath } from '@isomorphic/mimeType';
import { defineTabTool } from './tool';
import { elementSchema } from './snapshot';

import type * as playwright from '../../..';

// Playwright refuses to send more than this as content.
const contentUploadLimit = 50 * 1024 * 1024;

// By path first, which has no size limit. Chrome refuses paths over chrome.debugger ("Not allowed")
// unless the user turned on "Allow access to file URLs" for the extension; then send the content.
async function setFiles(fileChooser: playwright.FileChooser, paths: string[]) {
  try {
    await fileChooser.setFiles(paths);
    return;
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('Not allowed'))
      throw error;
  }
  const sizes = await Promise.all(paths.map(async filePath => (await fs.promises.stat(filePath)).size));
  if (sizes.reduce((a, b) => a + b, 0) > contentUploadLimit)
    throw new Error('Files over 50 MB can only be uploaded by path, and the browser refused the path. Turn on "Allow access to file URLs" for the Playwright extension in chrome://extensions and try again.');
  await fileChooser.setFiles(await Promise.all(paths.map(async filePath => ({
    name: path.basename(filePath),
    mimeType: getMimeTypeForPath(filePath) ?? 'application/octet-stream',
    buffer: await fs.promises.readFile(filePath),
  }))));
}

export const uploadFile = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_file_upload',
    title: 'Upload files',
    description: 'Upload one or multiple files',
    inputSchema: z.object({
      paths: z.array(z.string()).optional().describe('The absolute paths to the files to upload. Can be single file or multiple files. If omitted, file chooser is cancelled.'),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    response.setIncludeSnapshot();

    const modalState = tab.modalStates().find(state => state.type === 'fileChooser');
    if (!modalState)
      throw new Error('No file chooser visible');

    const paths = params.paths ? await Promise.all(params.paths.map(filePath => response.resolveClientFilename(filePath))) : undefined;

    response.addCode(`await fileChooser.setFiles(${JSON.stringify(paths)})`);

    tab.clearModalState(modalState);
    try {
      await tab.waitForCompletion(async () => {
        if (paths)
          await setFiles(modalState.fileChooser, paths);
      });
    } catch (e) {
      tab.setModalState(modalState);
      response.addError(e instanceof Error ? e.message : String(e));
      return;
    }
  },

  clearsModalState: 'fileChooser',
});

export const drop = defineTabTool({
  capability: 'core',

  schema: {
    name: 'browser_drop',
    title: 'Drop files or data onto an element',
    description: 'Drop files or MIME-typed data onto an element, as if dragged from outside the page. At least one of "paths" or "data" must be provided.',
    inputSchema: elementSchema.extend({
      paths: z.array(z.string()).optional().describe('Absolute paths to files to drop onto the element.'),
      data: z.record(z.string(), z.string()).optional().describe('Data to drop, as a map of MIME type to string value (e.g. {"text/plain": "hello", "text/uri-list": "https://example.com"}).'),
    }),
    type: 'action',
  },

  handle: async (tab, params, response) => {
    if (!params.paths?.length && !params.data)
      throw new Error('At least one of "paths" or "data" must be provided.');

    response.setIncludeSnapshot();
    const { locator, resolved } = await tab.targetLocator(params);

    const paths = params.paths ? await Promise.all(params.paths.map(p => response.resolveClientFilename(p))) : undefined;

    const payload: { files?: string | string[], data?: Record<string, string> } = {};
    if (paths?.length)
      payload.files = paths.length === 1 ? paths[0] : paths;
    if (params.data)
      payload.data = params.data;

    await tab.waitForCompletion(async () => {
      await locator.drop(payload, tab.actionTimeoutOptions);
    });

    response.addCode(`await page.${resolved}.drop(${formatObject(payload)});`);
  },
});

export default [
  uploadFile,
  drop,
];
