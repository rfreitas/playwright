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

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import debug from 'debug';
import { escapeRegExp, escapeWithQuotes } from '@isomorphic/stringUtils';
import { disposeAll } from '@isomorphic/disposable';
import { eventsHelper } from '@utils/eventsHelper';
import { gracefullyCloseSet } from '@utils/processLauncher';
import { isPathInside, isSystemDirectory, isWritable, resolveSymlinks, sanitizeForFilePath } from '@utils/fileUtils';
import { playwright } from '../../inprocess';

import { dedent, languageGeneratorId, secretCode } from './codegen';
import { deleteRecord, graceSessions, liveSessions, parkSession, readRecord, sessionsDir, takeSession, writeRecord } from './sessions';
import { Tab } from './tab';

import type { BrowserContextEx } from './browserContextEx';
import type { CodegenLanguage } from './codegen';
import type * as playwrightTypes from '../../..';
import type { SessionLog } from './sessionLog';
import type { SessionRecord } from './sessions';
import type { Disposable } from '@isomorphic/disposable';
import type { ToolCapability } from './tool';
import type { WebMCPToolDefinition } from './webmcp';

const testDebug = debug('pw:mcp:test');

export type ContextConfig = {
  allowUnrestrictedFileAccess?: boolean;
  capabilities?: ToolCapability[];
  codegen?: 'typescript' | 'python' | 'java' | 'csharp' | 'none';
  console?: { level?: 'error' | 'warning' | 'info' | 'debug' };
  imageResponses?: 'allow' | 'omit' | 'only';
  filePaths?: 'relative' | 'absolute';
  network?: {
    allowedOrigins?: string[];
    blockedOrigins?: string[];
  };
  outputDir?: string;
  outputMaxSize?: number;
  saveSession?: boolean;
  secrets?: Record<string, string>;
  redactUrlParams?: string[];
  sharedBrowserContext?: boolean;
  privateTabs?: boolean;
  resumeGrace?: number;
  resumeGraceMax?: number;
  snapshot?: {
    mode?: 'full' | 'none';
    boxes?: boolean;
  };
  testIdAttribute?: string;
  webmcp?: boolean;
  timeouts?: {
    action?: number;
    navigation?: number;
    expect?: number;
    settle?: number;
  };
  browser?: {
    contextOptions?: playwrightTypes.BrowserContextOptions;
    initScript?: string[];
    initPage?: string[];
  };
  skillMode?: boolean;
};

type ContextOptions = {
  config: ContextConfig;
  sessionLog?: SessionLog;
  cwd: string;
  clientName?: string;
  onWebMCPToolsChanged?: () => void;
  // Closes the browser connection: at dispose, or when the resume grace of a private-tabs session ends.
  closeBrowser?: () => Promise<void>;
};

export type RouteEntry = {
  pattern: string;
  status?: number;
  body?: string;
  contentType?: string;
  addHeaders?: Record<string, string>;
  removeHeaders?: string[];
  handler: (route: playwrightTypes.Route) => Promise<void>;
};

export type FilenameTemplate = {
  prefix: string;
  ext: string;
  suggestedFilename?: string;
  date?: Date;
};

type VideoParams = { size?: { width: number; height: number }, fps?: number, cursor?: boolean };

export type TraceInfo = { name: string, isolatedContext?: string };

// Actions are paced by this delay when the cursor is shown, giving it time to travel.
const kCursorDuration = 800;

const kResumeReminder = 'A session that disconnected recently is still open; browser_sessions lists it, browser_tabs resume takes it over.';

export class Context {
  readonly config: ContextConfig;
  readonly sessionLog: SessionLog | undefined;
  readonly options: ContextOptions;
  private _defaultBrowserContext: playwrightTypes.BrowserContext;
  // Keyed by isolated context name, undefined for the default context.
  // Resolves once the context exists and has routes, init scripts and page listeners installed.
  private _browserContexts = new Map<string | undefined, Promise<playwrightTypes.BrowserContext>>();
  private _tabs: Tab[] = [];
  private _currentTab: Tab | undefined;
  private _browserSession: Promise<playwrightTypes.CDPSession> | undefined;
  private _routes: RouteEntry[] = [];
  private _video: {
    params: VideoParams;
    fileNames: string[];
    fileName: string;
  } | undefined;
  private _recording: {
    browserContext: playwrightTypes.BrowserContext;
    actions: string[];
  } | undefined;
  private _tracing: {
    name: string;
    traces: (TraceInfo & { browserContext: playwrightTypes.BrowserContext })[];
  } | undefined;
  private _disposables: Disposable[] = [];
  // Private tabs only: the session other clients can list and resume.
  private _session: { token: string, startedAt: string } | undefined;
  private _sessionAnnounced = false;
  private _resumed = false;
  private _recordTimer: NodeJS.Timeout | undefined;

  private _webmcpToolsSignature = '';
  private _redactUrlParamsRegex: RegExp | undefined;

  private _runningToolName: string | undefined;
  private _pendingUnhandledRejections: unknown[] = [];
  private _unhandledRejectionListeners = new Set<(reason: unknown) => void>();
  private _onUnhandledRejection = (reason: unknown) => {
    this._pendingUnhandledRejections.push(reason);
    for (const listener of this._unhandledRejectionListeners)
      listener(reason);
  };

  constructor(browserContext: playwrightTypes.BrowserContext, options: ContextOptions) {
    this.config = options.config;
    this.sessionLog = options.sessionLog;
    this.options = options;
    this._defaultBrowserContext = browserContext;
    if (this.config.testIdAttribute)
      playwright.selectors.setTestIdAttribute(this.config.testIdAttribute);
    const redactUrlParams = this.config.redactUrlParams?.filter(Boolean);
    // Matches `name=value` after `?`, `&` or `#`, so that both query and fragment parameters are covered.
    // The value ends where a URL would end inside markdown, YAML or JSON.
    if (redactUrlParams?.length)
      this._redactUrlParamsRegex = new RegExp(`([?&#](?:${redactUrlParams.map(escapeRegExp).join('|')})=)[^&#\\s"'<>()\\[\\]\`\\\\]+`, 'gi');
    testDebug('create context');
    process.on('unhandledRejection', this._onUnhandledRejection);
    // A stdio client that goes away ends the process through the exit watchdog, not through dispose().
    if (this.config.privateTabs) {
      gracefullyCloseSet.add(this._closeOwnTabs);
      this._session = { token: crypto.randomBytes(12).toString('hex'), startedAt: new Date().toISOString() };
      liveSessions.add(this._session.token);
    }
  }

  private _closeOwnTabs = async () => {
    await Promise.all(this._tabs.map(tab => tab.page.close().catch(() => {})));
  };

  async dispose() {
    process.off('unhandledRejection', this._onUnhandledRejection);
    await this.stopRecording();
    await this.stopVideoRecording();
    await disposeAll(this._disposables);
    let closeBrowser = this.options.closeBrowser;
    try {
      if (this.config.privateTabs) {
        gracefullyCloseSet.delete(this._closeOwnTabs);
        if (await this._endSession())
          closeBrowser = undefined;
        else
          await this._closeOwnTabs();
      }
      for (const tab of this._tabs)
        await tab.dispose();
      this._tabs.length = 0;
      this._setCurrentTab(undefined);
      await Promise.all([...this._browserContexts].filter(([isolatedContext]) => isolatedContext).map(([, browserContext]) => browserContext.then(c => c.close()).catch(() => {})));
      this._browserContexts.clear();
    } finally {
      await closeBrowser?.();
    }
  }

  // Closes the record and, when a client may still come back for the windows, parks them with the
  // connection in the grace registry instead of closing them. Returns whether it parked them.
  private async _endSession(): Promise<boolean> {
    liveSessions.delete(this._session!.token);
    clearTimeout(this._recordTimer);
    const tabs = this._sessionTabs();
    if (!tabs.length) {
      // Nothing to come back to: no record, and the caller closes whatever blank tabs there are.
      await deleteRecord(this.sessionsDir(), this._session!.token);
      return false;
    }
    const record = await this._writeRecord(new Date().toISOString());
    const grace = this.config.resumeGrace ?? 0;
    if (!grace || !this._defaultBrowserContext.browser()?.isConnected())
      return false;
    await this._closeBlankTabs();
    parkSession(record, tabs.map(tab => tab.page), grace, this.options.closeBrowser);
    return true;
  }

  // What a session is about, and so what its record and its grace keep: the tabs in the shared context that show a page.
  private _sessionTabs(): Tab[] {
    return this._tabs.filter(tab => !tab.isolatedContext && tab.page.url() !== 'about:blank');
  }

  private async _closeBlankTabs() {
    await Promise.all(this._tabs.filter(tab => !tab.isolatedContext && tab.page.url() === 'about:blank').map(tab => tab.page.close().catch(() => {})));
  }

  sessionToken(): string | undefined {
    return this._session?.token;
  }

  // The token goes out with the first response and with every tab listing; the reminder with the first response only.
  sessionLines(includeToken: boolean): string[] {
    if (!this._session)
      return [];
    const lines: string[] = [];
    if (includeToken || !this._sessionAnnounced)
      lines.push(this._session.token);
    if (!this._sessionAnnounced && !this._resumed && graceSessions.size)
      lines.push(kResumeReminder);
    this._sessionAnnounced = true;
    return lines;
  }

  // Takes over the windows of a session whose client went away, under its token, or reopens them
  // from its record under this session's own token. Returns whether it reopened them.
  async resumeSession(token: string): Promise<boolean> {
    if (!this._session)
      throw new Error('Resume needs --private-tabs');
    if (liveSessions.has(token))
      throw new Error(`Session ${token} is in use`);
    const dir = this.sessionsDir();
    // A fresh connection has at most the blank tab its first tool call opened; it goes once the real tabs are back.
    const blanks = this._tabs.filter(tab => !tab.isolatedContext && tab.page.url() === 'about:blank');
    const closeBlanks = () => Promise.all(blanks.map(tab => tab.page.close().catch(() => {})));
    const parked = takeSession(token);
    if (parked) {
      // The old connection goes, its windows stay.
      await parked.close?.().catch(() => {});
      const browserContext = await this.ensureBrowserContext();
      const recorded = new Map(parked.record.tabs.map(tab => [tab.targetId, tab]));
      let current: Tab | undefined;
      let adopted = false;
      for (const page of browserContext.pages()) {
        const targetId = await this._targetId(browserContext, page);
        const tab = targetId && recorded.get(targetId);
        if (!tab)
          continue;
        this._onPageCreated(page, undefined, targetId);
        adopted = true;
        if (tab.current)
          current = Tab.forPage(page);
      }
      if (adopted) {
        liveSessions.delete(this._session.token);
        await deleteRecord(dir, this._session.token);
        this._session = { token, startedAt: parked.record.startedAt };
        liveSessions.add(token);
        this._resumed = true;
        this._setCurrentTab(current ?? this._tabs[this._tabs.length - 1]);
        await closeBlanks();
        return false;
      }
    }
    const record = await readRecord(dir, token);
    if (!record)
      throw new Error(`Nothing to resume for ${token}`);
    let current: Tab | undefined;
    for (const recorded of record.tabs) {
      const tab = await this.newTab();
      await tab.checkUrlAndNavigate(recorded.url);
      if (recorded.current)
        current = tab;
    }
    if (record.tabs.length) {
      this._setCurrentTab(current ?? this._tabs[this._tabs.length - 1]);
      await closeBlanks();
    }
    await deleteRecord(dir, token);
    this._resumed = true;
    return true;
  }

  sessionsDir(): string {
    return sessionsDir(outputDir(this.options));
  }

  private _scheduleRecord() {
    if (!this._session)
      return;
    clearTimeout(this._recordTimer);
    this._recordTimer = setTimeout(() => this._writeRecord().catch(e => debug('pw:tools:error')(e)), 1000);
  }

  private async _writeRecord(endedAt?: string): Promise<SessionRecord> {
    this._recordTimer = undefined;
    const tabs = this._sessionTabs();
    // Other clients read records: the client chose its name and a page chose its URL, so keep the name plain text
    // and redact the URL. A redacted URL reopens without its one-time parameters, which should not be replayed anyway.
    const record: SessionRecord = {
      token: this._session!.token,
      clientName: (this.options.clientName ?? '').replace(/[^A-Za-z0-9 ._-]/g, '').slice(0, 40),
      startedAt: this._session!.startedAt,
      updatedAt: new Date().toISOString(),
      endedAt,
      tabs: await Promise.all(tabs.map(async tab => ({
        url: this.redactSecrets(tab.page.url()),
        title: await tab.title().catch(() => ''),
        targetId: tab.targetId!,
        current: tab === this._currentTab,
      }))),
    };
    await writeRecord(this.sessionsDir(), record);
    return record;
  }

  drainPendingUnhandledRejections(): unknown[] {
    const reasons = this._pendingUnhandledRejections.slice();
    this._pendingUnhandledRejections.length = 0;
    return reasons;
  }

  onUnhandledRejection(listener: (reason: unknown) => void): () => void {
    this._unhandledRejectionListeners.add(listener);
    return () => this._unhandledRejectionListeners.delete(listener);
  }

  debugger() {
    return this._defaultBrowserContext.debugger;
  }

  tabs(): Tab[] {
    return this._tabs;
  }

  currentTab(): Tab | undefined {
    return this._currentTab;
  }

  currentTabOrDie(): Tab {
    if (!this._currentTab)
      throw new Error('No open pages available.');
    return this._currentTab;
  }

  async newTab(isolatedContext?: string): Promise<Tab> {
    const browserContext = await this.ensureBrowserContext(isolatedContext);
    let page: playwrightTypes.Page;
    if (this._hasPrivateTabs(isolatedContext)) {
      const created = await this._newWindowPage(browserContext);
      page = created.page;
      this._onPageCreated(page, isolatedContext, created.targetId);
    } else {
      page = await browserContext.newPage();
    }
    this._setCurrentTab(this._tabs.find(t => t.page === page)!);
    return this._currentTab!;
  }

  async selectTab(index: number) {
    const tab = this._tabs[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    await tab.page.bringToFront();
    await tab.updateWebMCPTools();
    this._setCurrentTab(tab);
    return tab;
  }

  async ensureTab(): Promise<Tab> {
    await this.ensureBrowserContext();
    const crashed = this._currentTab?.crashed;
    if (crashed) {
      await this._currentTab!.page.close().catch(() => {});
      this._setCurrentTab(undefined);
    }
    if (!this._currentTab)
      await this.newTab();
    if (crashed)
      this._currentTab!.logErrorMessage('Page crashed and was reset to about:blank.');
    await this._currentTab!.waitForInitialized();
    return this._currentTab!;
  }

  async closeTab(index: number | undefined): Promise<string> {
    const tab = index === undefined ? this._currentTab : this._tabs[index];
    if (!tab)
      throw new Error(`Tab ${index} not found`);
    const url = tab.page.url();
    await tab.page.close();
    return url;
  }

  async workspaceFile(fileName: string, perCallWorkspaceDir: string | undefined): Promise<string> {
    return await workspaceFile(this.options, fileName, perCallWorkspaceDir);
  }

  async outputFile(template: FilenameTemplate, options: { origin: 'code' | 'llm' }): Promise<string> {
    const baseName = template.suggestedFilename || `${template.prefix}-${(template.date ?? new Date()).toISOString().replace(/[:.]/g, '-')}${template.ext ? '.' + template.ext : ''}`;
    return await outputFile(this.options, baseName, options);
  }

  async startVideoRecording(fileName: string, params: VideoParams) {
    if (this._video)
      throw new Error('Video recording has already been started.');
    await this.ensureBrowserContext();
    this._video = { params, fileName, fileNames: [] };
    for (const tab of this._tabs)
      await this._startPageVideo(tab.page);
  }

  async stopVideoRecording(): Promise<string[]> {
    if (!this._video)
      return [];
    const video = this._video;
    for (const tab of this._tabs)
      await tab.page.screencast.stop();
    this._video = undefined;
    return [...video.fileNames];
  }

  async startRecording() {
    if (this._recording)
      throw new Error('Recording is already in progress.');
    const browserContext = await this.currentBrowserContext() as BrowserContextEx;
    if (typeof browserContext._startRecording !== 'function')
      throw new Error('Recording requires a newer version of Playwright, please upgrade.');
    const recordedActions: string[] = [];
    await browserContext._startRecording({
      language: languageGeneratorId(this.codegenLanguage()),
    }, {
      actionAdded: (page, action, code) => {
        recordedActions.push(code);
      },
      actionUpdated: (page, action, code) => {
        if (recordedActions.length)
          recordedActions[recordedActions.length - 1] = code;
        else
          recordedActions.push(code);
      },
      signalAdded: (page, signal, code) => {
        if (recordedActions.length && code)
          recordedActions[recordedActions.length - 1] = code;
      },
    });
    this._recording = { browserContext, actions: recordedActions };
  }

  async stopRecording(): Promise<string[] | undefined> {
    const recording = this._recording;
    if (!recording)
      return undefined;
    this._recording = undefined;
    await (recording.browserContext as BrowserContextEx)._stopRecording();
    return recording.actions.filter(code => code.trim()).map(dedent);
  }

  async startTracing(): Promise<TraceInfo[]> {
    if (this._tracing)
      throw new Error('Tracing has already been started.');
    await this.ensureBrowserContext();
    const tracing = this._tracing = { name: 'trace-' + Date.now(), traces: [] };
    for (const [isolatedContext, browserContext] of this._browserContexts)
      await this._startContextTracing(isolatedContext, await browserContext);
    return tracing.traces;
  }

  async stopTracing(): Promise<TraceInfo[] | undefined> {
    const tracing = this._tracing;
    if (!tracing)
      return undefined;
    this._tracing = undefined;
    await Promise.all(tracing.traces.filter(trace => !trace.browserContext.isClosed()).map(trace => trace.browserContext.tracing.stop()));
    return tracing.traces;
  }

  private async _startContextTracing(isolatedContext: string | undefined, browserContext: playwrightTypes.BrowserContext) {
    const tracing = this._tracing;
    if (!tracing || tracing.traces.some(trace => trace.browserContext === browserContext))
      return;
    let name = isolatedContext ? `${tracing.name}-${sanitizeForFilePath(isolatedContext)}` : tracing.name;
    if (tracing.traces.some(trace => trace.name === name))
      name += `-${tracing.traces.length}`;
    tracing.traces.push({ name, isolatedContext, browserContext });
    await browserContext.tracing.start({ name, screenshots: true, snapshots: true, live: true });
  }

  codegenLanguage(): CodegenLanguage {
    const codegen = this.config.codegen ?? 'typescript';
    return codegen === 'none' ? 'typescript' : codegen;
  }

  private async _startPageVideo(page: playwrightTypes.Page) {
    if (!this._video)
      return;
    const suffix = this._video.fileNames.length ? `-${this._video.fileNames.length}` : '';
    let fileName = this._video.fileName;
    if (fileName && suffix) {
      const dir = path.dirname(fileName);
      const ext = path.extname(fileName);
      fileName = path.join(dir, path.basename(fileName, ext) + suffix + ext);
    }
    this._video.fileNames.push(fileName);
    const { cursor, ...startParams } = this._video.params;
    await page.screencast.start({ path: fileName, ...startParams });
    if (cursor) {
      // Show the cursor only, the action title is what `browser_video_show_actions` is for.
      await page.screencast.showActions({ cursor: 'pointer', duration: kCursorDuration, style: { title: 'display: none' } });
    }
  }

  private _onPageCreated(page: playwrightTypes.Page, isolatedContext: string | undefined, targetId?: string) {
    const tab = new Tab(this, page, isolatedContext, tab => this._onPageClosed(tab), targetId);
    this._tabs.push(tab);
    if (!this._currentTab)
      this._setCurrentTab(tab);
    this._startPageVideo(page).catch(() => {});
    if (this._session && !isolatedContext) {
      this._disposables.push(eventsHelper.addEventListener(page, 'framenavigated', frame => {
        if (frame === page.mainFrame())
          this._scheduleRecord();
      }));
      this._scheduleRecord();
    }
  }

  private _onPageClosed(tab: Tab) {
    const index = this._tabs.indexOf(tab);
    if (index === -1)
      return;
    this._tabs.splice(index, 1);

    if (this._currentTab === tab)
      this._setCurrentTab(this._tabs[Math.min(index, this._tabs.length - 1)]);
    this._scheduleRecord();
  }

  currentWebMCPTools(): WebMCPToolDefinition[] {
    // Handlers are bound to a tab and frame, always take the fresh ones.
    return this._currentTab?.webmcpTools()?.tools.map(tool => tool.mcpTool) ?? [];
  }

  maybeNotifyWebMCPToolsChanged() {
    const signature = JSON.stringify(this.currentWebMCPTools().map(tool => tool.schema));
    if (signature === this._webmcpToolsSignature)
      return;
    this._webmcpToolsSignature = signature;
    this.options.onWebMCPToolsChanged?.();
  }

  private _setCurrentTab(tab: Tab | undefined) {
    if (this._currentTab === tab)
      return;
    this._currentTab = tab;
    this.maybeNotifyWebMCPToolsChanged();
  }

  routes(): RouteEntry[] {
    return this._routes;
  }

  async addRoute(entry: RouteEntry): Promise<void> {
    for (const browserContext of await this._allBrowserContexts())
      await browserContext.route(entry.pattern, entry.handler);
    this._routes.push(entry);
  }

  async removeRoute(pattern?: string): Promise<number> {
    const toRemove = pattern ? this._routes.filter(r => r.pattern === pattern) : this._routes;
    for (const browserContext of await this._allBrowserContexts()) {
      for (const route of toRemove)
        await browserContext.unroute(route.pattern, route.handler);
    }
    this._routes = this._routes.filter(r => !toRemove.includes(r));
    return toRemove.length;
  }

  isRunningTool() {
    return this._runningToolName !== undefined;
  }

  setRunningTool(name: string | undefined) {
    this._runningToolName = name;
  }

  private async _setupRequestInterception(context: playwrightTypes.BrowserContext, disposables: Disposable[]) {
    if (this.config.network?.allowedOrigins?.length) {
      disposables.push(await context.route('**', route => route.abort('blockedbyclient')));

      for (const origin of this.config.network.allowedOrigins) {
        const glob = originOrHostGlob(origin);
        disposables.push(await context.route(glob, route => route.continue()));
      }
    }

    if (this.config.network?.blockedOrigins?.length) {
      for (const origin of this.config.network.blockedOrigins)
        disposables.push(await context.route(originOrHostGlob(origin), route => route.abort('blockedbyclient')));
    }
  }

  async ensureBrowserContext(isolatedContext?: string): Promise<playwrightTypes.BrowserContext> {
    if (!isolatedContext || isolatedContext === 'default')
      isolatedContext = undefined;
    let browserContext = this._browserContexts.get(isolatedContext);
    if (!browserContext) {
      browserContext = this._initializeBrowserContext(isolatedContext);
      this._browserContexts.set(isolatedContext, browserContext);
      browserContext.catch(() => this._browserContexts.delete(isolatedContext));
    }
    return await browserContext;
  }

  async currentBrowserContext(): Promise<playwrightTypes.BrowserContext> {
    return this._currentTab?.page.context() ?? await this.ensureBrowserContext();
  }

  private async _allBrowserContexts(): Promise<playwrightTypes.BrowserContext[]> {
    await this.ensureBrowserContext();
    return await Promise.all(this._browserContexts.values());
  }

  private async _initializeBrowserContext(isolatedContext: string | undefined): Promise<playwrightTypes.BrowserContext> {
    const browserContext = isolatedContext ? await this._createIsolatedContext(isolatedContext) : this._defaultBrowserContext;
    // Isolated contexts are closed in dispose(), which tears down their routes, scripts and listeners.
    const disposables = isolatedContext ? [] : this._disposables;
    await this._setupRequestInterception(browserContext, disposables);

    for (const initScript of this.config.browser?.initScript || [])
      disposables.push(await browserContext.addInitScript({ path: path.resolve(this.options.cwd, initScript) }));

    for (const route of this._routes)
      await browserContext.route(route.pattern, route.handler);

    if (this._hasPrivateTabs(isolatedContext)) {
      // Other clients' tabs are not ours; only popups from our own tabs join them.
      disposables.push(eventsHelper.addEventListener(browserContext, 'page', page => this._adoptPopup(page, isolatedContext)));
    } else {
      for (const page of browserContext.pages())
        this._onPageCreated(page, isolatedContext);
      disposables.push(eventsHelper.addEventListener(browserContext, 'page', page => this._onPageCreated(page, isolatedContext)));
    }
    await this._startContextTracing(isolatedContext, browserContext);
    return browserContext;
  }

  // Isolated contexts belong to this client alone, so private tabs only concern the shared default context.
  private _hasPrivateTabs(isolatedContext: string | undefined) {
    return !!this.config.privateTabs && !isolatedContext;
  }

  private async _adoptPopup(page: playwrightTypes.Page, isolatedContext: string | undefined) {
    const opener = await page.opener().catch(() => null);
    if (opener && this._tabs.some(tab => tab.page === opener))
      this._onPageCreated(page, isolatedContext, await this._targetId(page.context(), page));
  }

  // A window of its own, so bringing this tab to the front does not hide another client's tab in a shared window.
  private async _newWindowPage(browserContext: playwrightTypes.BrowserContext): Promise<{ page: playwrightTypes.Page, targetId: string }> {
    const browser = browserContext.browser();
    if (!browser)
      throw new Error('Private tabs are not supported for this browser.');
    this._browserSession ??= browser.newBrowserCDPSession();
    const session = await this._browserSession;
    const seen = new Set(browserContext.pages());
    const { targetId } = await session.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    for (;;) {
      let onPage!: () => void;
      const nextPage = new Promise<void>(resolve => onPage = resolve);
      const listener = eventsHelper.addEventListener(browserContext, 'page', onPage);
      try {
        for (const page of browserContext.pages()) {
          if (seen.has(page))
            continue;
          seen.add(page);
          if (await this._targetId(browserContext, page) === targetId)
            return { page, targetId };
        }
        await nextPage;
      } finally {
        eventsHelper.removeEventListeners([listener]);
      }
    }
  }

  // Undefined for a page that is closing: it cannot be ours.
  private async _targetId(browserContext: playwrightTypes.BrowserContext, page: playwrightTypes.Page): Promise<string | undefined> {
    const session = await browserContext.newCDPSession(page).catch(() => undefined);
    if (!session)
      return undefined;
    try {
      return (await session.send('Target.getTargetInfo')).targetInfo.targetId;
    } catch {
      return undefined;
    } finally {
      await session.detach().catch(() => {});
    }
  }

  private async _createIsolatedContext(name: string): Promise<playwrightTypes.BrowserContext> {
    await this.ensureBrowserContext();
    const browser = this._defaultBrowserContext.browser();
    if (!browser)
      throw new Error('Isolated contexts are not supported for this browser.');
    const browserContext = await browser.newContext(this.config.browser?.contextOptions);
    browserContext.once('close', () => this._browserContexts.delete(name));
    return browserContext;
  }

  checkUrlAllowed(url: string) {
    if (this.config.allowUnrestrictedFileAccess)
      return;
    if (!URL.canParse(url))
      return;
    if (new URL(url).protocol === 'file:')
      throw new Error(`Access to "file:" protocol is blocked. Attempted URL: "${url}"`);
  }

  lookupSecret(secretName: string): { value: string, code: string, isSecret: boolean } {
    if (!this.config.secrets?.[secretName])
      return { value: secretName, code: escapeWithQuotes(secretName, '\''), isSecret: false };
    return {
      value: this.config.secrets[secretName]!,
      code: secretCode(this.codegenLanguage(), secretName),
      isSecret: true,
    };
  }

  redactSecrets(text: string): string {
    for (const [secretName, secretValue] of Object.entries(this.config.secrets ?? {})) {
      if (!secretValue)
        continue;
      text = text.replaceAll(secretValue, `<secret>${secretName}</secret>`);
    }
    if (this._redactUrlParamsRegex)
      text = text.replace(this._redactUrlParamsRegex, '$1<redacted>');
    return text;
  }
}

function originOrHostGlob(originOrHost: string) {
  // Support wildcard port patterns like "http://localhost:*" or "https://example.com:*"
  const wildcardPortMatch = originOrHost.match(/^(https?:\/\/[^/:]+):\*$/);
  if (wildcardPortMatch)
    return `${wildcardPortMatch[1]}:*/**`;

  try {
    const url = new URL(originOrHost);
    // localhost:1234 will parse as protocol 'localhost:' and 'null' origin.
    if (url.origin !== 'null')
      return `${url.origin}/**`;
  } catch {
  }
  // Support for legacy host-only mode.
  return `*://${originOrHost}/**`;
}

export async function workspaceFile(options: ContextOptions, fileName: string, perCallWorkspaceDir?: string): Promise<string> {
  const workspace = perCallWorkspaceDir ?? options.cwd;
  const resolvedName = path.resolve(workspace, fileName);
  await checkFile(options, resolvedName, { origin: 'llm' });
  return resolvedName;
}

export function outputDir(options: ContextOptions): string {
  if (options.config.outputDir)
    return path.resolve(options.config.outputDir);
  const baseName = options.config.skillMode ? '.playwright-cli' : '.playwright-mcp';
  if (isSystemDirectory(options.cwd) || !isWritable(options.cwd))
    return path.join(os.tmpdir(), baseName);
  return path.join(options.cwd, baseName);
}

export async function outputFile(options: ContextOptions, fileName: string, flags: { origin: 'code' | 'llm' }): Promise<string> {
  const resolvedFile = path.resolve(outputDir(options), fileName);
  await checkFile(options, resolvedFile, flags);
  await fs.promises.mkdir(path.dirname(resolvedFile), { recursive: true });
  debug('pw:mcp:file')(resolvedFile);
  return resolvedFile;
}

async function checkFile(options: ContextOptions, resolvedFilename: string, flags: { origin: 'code' | 'llm' }) {
  // Trust code and unrestricted file access.
  if (flags.origin === 'code' || options.config.allowUnrestrictedFileAccess || options.config.skillMode)
    return;

  // Trust llm to use valid characters in file names.
  const output = outputDir(options);
  const workspace = options.cwd;
  // Follow symlinks, an unresolvable root cannot be traversed anyway.
  const [realOutput, realWorkspace, realFilename] = await Promise.all([
    resolveSymlinks(output).catch(() => output),
    resolveSymlinks(workspace).catch(() => workspace),
    resolveSymlinks(resolvedFilename),
  ]);
  if (!isPathInside(realOutput, realFilename) && !isPathInside(realWorkspace, realFilename))
    throw new Error(`File access denied: ${resolvedFilename} is outside allowed roots. Allowed roots: ${output}, ${workspace}`);
}
