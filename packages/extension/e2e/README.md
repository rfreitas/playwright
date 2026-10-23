# Extension end-to-end tests

These start a real Chromium with the built extension and, for most of them, a
real Playwright MCP server in `--extension` mode. Nothing here runs in the
normal `npm test`; run it by hand.

## One-time setup

```
npm install
npm install --no-save playwright ws @modelcontextprotocol/sdk
node packages/playwright-core/cli.js install chromium
```

Install the three extra packages in one command: a later `npm install --no-save`
removes the ones from an earlier one.

## Every time

```
npm run build        # builds the extension (dist/) and the MCP server (lib/)
```

Point the tests at the server you just built. Without this they run the
published `@playwright/mcp`, which is how you check that a test fails before a
fix:

```
# PowerShell
$env:MCP_SERVER_COMMAND = '["node","C:/path/to/repo/packages/playwright-core/cli.js","mcp"]'
# bash
export MCP_SERVER_COMMAND='["node","/path/to/repo/packages/playwright-core/cli.js","mcp"]'
```

Then run a file, or all of them:

```
node --test packages/extension/e2e/upload.e2e.mjs
node --test packages/extension/e2e/*.e2e.mjs
```

(`node --test` takes file paths, not a directory. Add `--test-force-exit` to `focus.e2e.mjs`: the process does not exit on its own after it.)

## What each file covers

| File | Covers |
| --- | --- |
| `extension.e2e.mjs` | Token connect without a click, tab discard recovery, stale connect pages. Talks to the extension through a fake relay (`fakeRelay.mjs`). |
| `upload.e2e.mjs` | `browser_file_upload` without "Allow access to file URLs". |
| `upload-large.e2e.mjs` | Files over 50 MB, with and without that setting. Writes a 60 MB temp file. |
| `background-tab.e2e.mjs` | A tab behind another tab, and a minimized window: actions finish and nothing is brought forward. |
| `focus.e2e.mjs` | The user's tab stays in front, with a connection already open and while connecting for the first time or reconnecting. Connecting is red until the extension puts the user's tab back. |
| `reconnect.e2e.mjs` | Reconnecting after a lost connection, and retries that fail leaving no pile of connect pages. |

## Browsers

- `harness.mjs` uses Playwright's Chromium (headless). Branded Chrome 137+
  ignores `--load-extension`, so it cannot be used.
- `rawBrowser.mjs` starts Chromium itself, because Playwright fakes focus and
  visibility for browsers it launches and would hide the bugs these tests are
  about. It runs headless by default. `PW_E2E_BROWSER_MODE` can be `headless`,
  `minimized`, `offscreen` or `headed` if you need to watch it.
