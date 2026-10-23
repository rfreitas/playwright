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

import { recordDiagnostic } from './diagnostics';
import { debugLog } from './relayConnection';
import { PendingConnections } from './pendingConnection';
import { ConnectedTabGroup, cleanupStalePlaywrightGroups, isNonDebuggableUrl, ungroupTabs, uniqueGroupStyle } from './connectedTabGroup';

type PageMessage = {
  type: 'connectionRequested';
  mcpRelayUrl: string;
  // Identifies the MCP server process; absent from servers that do not send it.
  serverId?: string;
} | {
  type: 'getTabs';
} | {
  type: 'connectToTab';
  // Picked in the connect page; absent on the token-bypass path where no tab
  // selection happens.
  tab?: chrome.tabs.Tab;
  clientName?: string;
} | {
  type: 'getConnectionStatus';
} | {
  type: 'disconnect';
  connectionId: number;
} | {
  type: 'keepalive';
};

class PlaywrightExtension {
  private _connections = new Map<number, ConnectedTabGroup>();
  private _lastConnectionId = 0;
  private _pendingConnections = new PendingConnections();
  // Service worker restarts lose all connection state, so any existing
  // Playwright groups are stale. Connections wait on this before reconciling.
  private _cleanupPromise: Promise<void>;
  private _keepaliveTimer: ReturnType<typeof setInterval> | undefined;
  // Connect pages between `connectionRequested` and the group being created.
  private _connectingTabIds = new Set<number>();

  constructor() {
    chrome.runtime.onMessage.addListener(this._onMessage.bind(this));
    chrome.action.onClicked.addListener(this._onActionClicked.bind(this));
    recordDiagnostic('serviceWorker.start');
    this._cleanupPromise = cleanupStalePlaywrightGroups();
  }

  // Promise-based message handling is not supported in Chrome: https://issues.chromium.org/issues/40753031
  private _onMessage(message: PageMessage, sender: chrome.runtime.MessageSender, sendResponse: (response: any) => void) {
    switch (message.type) {
      case 'connectionRequested': {
        const selectorTabId = sender.tab!.id!;
        recordDiagnostic('connectionRequested', { selectorTabId, mcpRelayUrl: message.mcpRelayUrl });
        this._releaseConnectPage(selectorTabId).then(async () => {
          this._pendingConnections.create(selectorTabId, message.mcpRelayUrl, message.serverId);
          const superseded = message.serverId ? this._pendingConnections.supersede(selectorTabId, message.serverId) : [];
          if (superseded.length) {
            recordDiagnostic('connectPages.superseded', { tabIds: superseded, serverId: message.serverId });
            await chrome.tabs.remove(superseded).catch(() => {});
          }
          await this._closeStaleConnectPages(selectorTabId);
          sendResponse({ success: true });
        });
        return true;
      }
      case 'getTabs':
        this._getTabs(sender.tab?.id).then(
            tabs => sendResponse({ success: true, tabs, currentTabId: sender.tab?.id }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true;
      case 'connectToTab': {
        // Token-bypass (no specific pick) falls back to the connect page itself
        // so `ConnectedTabGroup` always has a concrete tab to start from. Both
        // sender.tab and UI-supplied tabs come from chrome.tabs.query / runtime
        // message sender, where `id` is always defined.
        const selectedTab = (message.tab ?? sender.tab!) as chrome.tabs.Tab & { id: number };
        this._connectTab(sender.tab!.id!, selectedTab, message.clientName).then(
            () => sendResponse({ success: true }),
            (error: any) => sendResponse({ success: false, error: error.message }));
        return true; // Return true to indicate that the response will be sent asynchronously
      }
      case 'getConnectionStatus':
        sendResponse({
          connections: [...this._connections].map(([id, group]) => ({
            id,
            clientName: group.clientName,
            connectedTabIds: group.connectedTabIds(),
          })),
        });
        return false;
      case 'disconnect':
        this._connections.get(message.connectionId)?.close('User disconnected');
        sendResponse({ success: true });
        return false;
      case 'keepalive':
        // Connect page pings us every ~20s so receiving this message resets
        // the MV3 service worker idle timer and keeps the relay WebSocket alive.
        return false;
    }
  }

  private async _connectTab(selectorTabId: number, tab: chrome.tabs.Tab & { id: number }, clientName: string | undefined): Promise<void> {
    this._connectingTabIds.add(selectorTabId);
    try {
      await this._cleanupPromise;
      this._releaseTab(selectorTabId);
      if (tab.id !== selectorTabId && this._connectedTabIds().has(tab.id))
        throw new Error('This tab is already connected to another client');

      const connection = await this._pendingConnections.take(selectorTabId);
      if (!connection)
        throw new Error('Pending client connection closed');

      const id = ++this._lastConnectionId;
      const taken = [...this._connections.values()].map(group => group.groupStyle);
      const group = new ConnectedTabGroup(connection, tab, clientName, uniqueGroupStyle(clientName, taken), tabId => this._pendingConnections.has(tabId));
      group.onclose = () => {
        recordDiagnostic('connection.closed', { id, clientName });
        this._connections.delete(id);
        this._updateKeepalive();
      };
      this._connections.set(id, group);
      this._updateKeepalive();
      recordDiagnostic('connection.opened', { id, clientName, tabId: tab.id });

      await Promise.all([
        chrome.tabs.update(tab.id, { active: true }),
        chrome.windows.update(tab.windowId, { focused: true }),
      ]).catch(() => {});

      if (tab.id !== selectorTabId)
        await chrome.tabs.remove(selectorTabId).catch(() => {});
    } catch (error: any) {
      recordDiagnostic('connectTab.failed', { tabId: tab.id, message: error.message });
      debugLog(`Failed to connect tab ${tab.id}:`, error.message);
      throw error;
    } finally {
      this._connectingTabIds.delete(selectorTabId);
    }
  }

  // Chrome may create the connect page inside the active client's group.
  private async _releaseConnectPage(tabId: number): Promise<void> {
    this._releaseTab(tabId);
    await ungroupTabs([tabId]);
  }

  // Every retry on the MCP side opens a fresh connect page, and the pages of
  // dead relays are never closed. Drop any connect page that is neither
  // connected, awaiting approval, nor the one that is connecting now.
  private async _closeStaleConnectPages(currentTabId: number): Promise<void> {
    try {
      const pages = await chrome.tabs.query({ url: chrome.runtime.getURL('connect.html') + '*' });
      const connected = this._connectedTabIds();
      const stale = pages.map(page => page.id).filter((id): id is number =>
        id !== undefined && id !== currentTabId && !connected.has(id) && !this._pendingConnections.has(id) && !this._connectingTabIds.has(id));
      if (!stale.length)
        return;
      recordDiagnostic('connectPages.closeStale', { tabIds: stale });
      await chrome.tabs.remove(stale);
    } catch (error: any) {
      debugLog('Error closing stale connect pages:', error);
    }
  }

  // MV3 suspends the service worker after ~30s without extension API activity,
  // which kills the relay WebSocket. While any client is connected, a cheap API
  // call every 20s keeps it running even when the connect page is gone.
  private _updateKeepalive(): void {
    if (this._connections.size && !this._keepaliveTimer) {
      this._keepaliveTimer = setInterval(() => void chrome.runtime.getPlatformInfo(), 20_000);
    } else if (!this._connections.size && this._keepaliveTimer) {
      clearInterval(this._keepaliveTimer);
      this._keepaliveTimer = undefined;
    }
  }

  private _releaseTab(tabId: number): void {
    for (const group of this._connections.values())
      group.releaseTab(tabId);
  }

  private async _getTabs(selectorTabId: number | undefined): Promise<chrome.tabs.Tab[]> {
    const tabs = await chrome.tabs.query({});
    const connectedTabIds = this._connectedTabIds();
    return tabs.filter(tab => !isNonDebuggableUrl(tab.url) && (tab.id === selectorTabId || !connectedTabIds.has(tab.id!)));
  }

  private _connectedTabIds(): Set<number> {
    return new Set([...this._connections.values()].flatMap(group => group.connectedTabIds()));
  }

  private async _onActionClicked(): Promise<void> {
    await chrome.tabs.create({
      url: chrome.runtime.getURL('status.html'),
      active: true
    });
  }
}

new PlaywrightExtension();
