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

import http from 'http';
import { randomUUID } from 'crypto';
import { WebSocketServer } from 'ws';

// Stands in for the MCP server's CDP relay. It speaks just enough of the
// extension protocol to attach every tab the extension announces, and records
// everything the extension sends so tests can assert on it.
export class FakeRelay {
  constructor() {
    this.messages = [];
    this.attachedTabIds = new Set();
    // tabId -> error text for debugger.attach commands the extension rejected.
    this.attachErrors = new Map();
    this.closed = undefined;
    this._ws = undefined;
    this._nextId = 1;
    this._pendingAttach = new Map();
    this._listeners = new Set();
  }

  async start() {
    this._server = http.createServer();
    this._wss = new WebSocketServer({ server: this._server });
    this._wss.on('connection', ws => {
      this._ws = ws;
      ws.on('message', data => this._onMessage(JSON.parse(data.toString())));
      ws.on('close', (code, reason) => {
        this.closed = { code, reason: reason.toString() };
        this._notify();
      });
    });
    await new Promise(resolve => this._server.listen(0, '127.0.0.1', resolve));
    this._path = `/extension/${randomUUID()}`;
  }

  url() {
    return `ws://127.0.0.1:${this._server.address().port}${this._path}`;
  }

  // One line per message, for failure output.
  summary() {
    return this.messages.map(m => {
      if (m.method === 'chrome.tabs.onCreated')
        return `onCreated tab=${m.params[0].id} status=${m.params[0].status} url=${(m.params[0].url || m.params[0].pendingUrl || '').slice(0, 60)}`;
      if (m.method === 'chrome.debugger.onDetach')
        return `onDetach tab=${m.params[0].tabId} reason=${m.params[1]}`;
      if (m.method)
        return m.method;
      return `response id=${m.id} ${m.error ? 'error=' + JSON.stringify(m.error) : 'ok'}`;
    }).join('\n');
  }

  async stop() {
    this._wss?.clients.forEach(ws => ws.terminate());
    this._wss?.close();
    await new Promise(resolve => this._server?.close(resolve) ?? resolve());
  }

  // Resolves with the first recorded message matching `predicate`, including
  // ones that arrived before the call.
  waitForMessage(predicate, description, timeout = 10_000) {
    return this._waitFor(() => this.messages.find(predicate), description, timeout);
  }

  waitForClose(description, timeout = 10_000) {
    return this._waitFor(() => this.closed, description, timeout);
  }

  async expectStaysOpen(durationMs) {
    await new Promise(resolve => setTimeout(resolve, durationMs));
    if (this.closed)
      throw new Error(`Relay connection closed unexpectedly: ${JSON.stringify(this.closed)}`);
  }

  _waitFor(check, description, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._listeners.delete(listener);
        reject(new Error(`Timed out after ${timeout}ms waiting for ${description}. Messages so far:\n${JSON.stringify(this.messages, null, 1)}`));
      }, timeout);
      const listener = () => {
        const value = check();
        if (!value)
          return;
        clearTimeout(timer);
        this._listeners.delete(listener);
        resolve(value);
      };
      this._listeners.add(listener);
      listener();
    });
  }

  _notify() {
    for (const listener of [...this._listeners])
      listener();
  }

  _onMessage(message) {
    this.messages.push(message);
    if (message.method === 'chrome.tabs.onCreated') {
      // Same as the real relay's reaction to a new tab: attach the debugger.
      const tabId = message.params[0].id;
      const id = this._nextId++;
      this._pendingAttach.set(id, tabId);
      this._ws.send(JSON.stringify({ id, method: 'chrome.debugger.attach', params: [{ tabId }, '1.3'] }));
    } else if (message.id !== undefined && this._pendingAttach.has(message.id)) {
      const tabId = this._pendingAttach.get(message.id);
      if (message.error)
        this.attachErrors.set(tabId, message.error);
      else
        this.attachedTabIds.add(tabId);
      this._pendingAttach.delete(message.id);
    } else if (message.method === 'chrome.debugger.onDetach') {
      this.attachedTabIds.delete(message.params[0].tabId);
    }
    this._notify();
  }
}
