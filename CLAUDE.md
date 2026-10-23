@AGENTS.md

# This fork (rfreitas/playwright)

This checkout is not just upstream Playwright. It is the build that runs the user's live `playwright-chrome` MCP server (Playwright MCP in `--extension` mode, driving their real Chrome), so treat it as a working tool, not a scratch copy. Development is local: branch, change, test, merge to `main`. Push only when asked.

## What runs from here

- The `playwright-chrome` MCP server is `node <this repo>\packages\playwright-core\cli.js mcp --extension`, set in `~/.claude.json` with `PLAYWRIGHT_MCP_EXTENSION_TOKEN` in its env. The token is a secret: never print it or commit it.
- The extension is loaded unpacked from `packages/extension/dist` (id `mmlmfjhmonkocbjadbfplnigmagldckm`, same as the store build).
- Changes reach the user only after `npm run build`, then `/mcp` to reconnect the server. Extension changes also need a reload of the extension on `chrome://extensions`.
- Never kill processes by matching `cli.js mcp` or `chrome.exe` by name: that stops the user's live server or their browser. Kill by PID, or by a test's own profile directory.

## How this fork differs from upstream

- Extension survives repeated debugger detaches and tab discards; connect pages left by dead or retried attempts are closed (`packages/extension/src`).
- The MCP server turns focus emulation on in extension mode, so background and minimized tabs work without switching the user's tab or window. Do not reintroduce `bringToFront` to fix hidden tabs.
- `browser_file_upload` sends the path, and sends the content when Chrome refuses the path (no "Allow access to file URLs"). Content is capped at 50 MB.
- The connect page stays token-gated. The token auto-approves connections; do not remove the approval for the no-token case.

## Tests

Bug fixes here are test first: write the failing end-to-end test, commit it, then fix. The tests are in `packages/extension/e2e/`; setup and how to run them is in its `README.md`. They run headless and must not open windows on the user's screen. Run them with `MCP_SERVER_COMMAND` pointing at this repo's build, or they test the published package. Before merging also run `npm run tsc`, `npx eslint <changed files>` and `node utils/check_deps.js`.
