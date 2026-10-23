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
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

export const distDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist');
export const extensionId = 'mmlmfjhmonkocbjadbfplnigmagldckm';
export const extensionOrigin = `chrome-extension://${extensionId}`;

// Extensions loaded with --load-extension are allowed to access file URLs, but
// an extension installed from the Web Store or loaded through "Load unpacked"
// is not unless the user turns on "Allow access to file URLs". That is the
// setup most users have, and it is where file uploads break, so the harness
// switches it off the way chrome://extensions does and checks it took effect.
// Developer mode has to be on first, or Chrome disables the unpacked extension
// when the change reloads it.
async function setFileAccess(context, enabled) {
  const page = await context.newPage();
  await page.goto('chrome://extensions');
  // Changing it reloads the extension, so poll for the new value.
  const state = await page.evaluate(async ({ id, enabled }) => {
    await chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true });
    await chrome.developerPrivate.updateExtensionConfiguration({ extensionId: id, fileAccess: enabled });
    let info;
    for (let i = 0; i < 50; i++) {
      info = await chrome.developerPrivate.getExtensionInfo(id);
      if (info.fileAccess.isActive === enabled && info.state === 'ENABLED')
        break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { fileAccessActive: info.fileAccess.isActive, state: info.state };
  }, { id: extensionId, enabled });
  await page.close();
  assert.deepEqual(state, { fileAccessActive: enabled, state: 'ENABLED' }, 'could not set "Allow access to file URLs" for the extension');
  await new Promise(resolve => setTimeout(resolve, 1000));
}

// Playwright's Chromium with the built extension loaded and a persistent
// profile. Branded Chrome 137+ ignores --load-extension, so it cannot be used.
// The profile dir is returned so a second process can hand pages to this
// browser by launching the same executable on the same profile.
export async function launchBrowserWithExtension({ headless = true, fileAccess = false } = {}) {
  assert.ok(fs.existsSync(path.join(distDir, 'manifest.json')), `Build the extension first: ${distDir} is missing`);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-ext-e2e-'));
  const context = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chromium',
    headless,
    args: [`--disable-extensions-except=${distDir}`, `--load-extension=${distDir}`],
  });
  const close = async () => {
    await context.close().catch(() => {});
    fs.rmSync(userDataDir, { recursive: true, force: true });
  };
  try {
    if (!context.serviceWorkers().length)
      await context.waitForEvent('serviceworker');
    await setFileAccess(context, fileAccess);

    // The status page creates the auth token that lets a connect page skip the approval click.
    const helper = await context.newPage();
    await helper.goto(`${extensionOrigin}/status.html`);
    await helper.waitForFunction(() => localStorage.getItem('auth-token'));
    const token = await helper.evaluate(() => localStorage.getItem('auth-token'));
    return { context, helper, token, userDataDir, executablePath: chromium.executablePath(), close };
  } catch (error) {
    await close();
    throw error;
  }
}
