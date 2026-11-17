import { test } from 'node:test';
import assert from 'node:assert/strict';

test('browser mode reads a real tree list without accessing stored cookies or the direct transport', async () => {
  const Module = require('node:module');
  const originalLoad = Module._load, originalFetch = globalThis.fetch;
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  let tree: any, mode = 'direct', address = '';
  let cookieReads = 0;
  const secrets = new Map<string, string>();
  const secretStore = { get: async (key: string) => { if (key.startsWith("cookie.")) { cookieReads++; return "BDUSS=invalid\u0001cookie"; } return secrets.get(key); }, store: async (key: string, value: string) => { secrets.set(key, value); }, delete: async (key: string) => { secrets.delete(key); } };
  const subscriptions: { dispose(): void }[] = [];
  const mock = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    ConfigurationTarget: { Global: 1 }, ProgressLocation: { Window: 10 },
    workspace: {
      getConfiguration: () => ({ get: (key: string, fallback: any) => key === 'tiebaAccessMode' ? mode : fallback, update: async (_key: string, value: string) => { mode = value; } }),
      onDidChangeConfiguration: () => ({ dispose() {} })
    },
    window: {
      registerTreeDataProvider: (_id: string, value: any) => { tree = value; return { dispose() {} }; },
      registerWebviewViewProvider: () => ({ dispose() {} }),
      showInformationMessage: async () => undefined,
      showErrorMessage: async (message: string) => assert.fail(message)
    },
    env: { clipboard: { writeText: async (value: string) => { address = value; } } },
    commands: { registerCommand: (id: string, callback: any) => { handlers.set(id, callback); return { dispose() {} }; } }
  };
  Module._load = function(id: string, ...args: unknown[]) { return id === 'vscode' ? mock : originalLoad.call(this, id, ...args); };
  globalThis.fetch = (async (input: any, init: any) => {
    assert.equal(new URL(String(input)).hostname, '127.0.0.1', 'Browser mode must not issue direct platform requests');
    return originalFetch(input, init);
  }) as typeof fetch;
  try {
    require('../extension').activate({ subscriptions, secrets: secretStore, globalState: { get: (_key: string, fallback: any) => fallback } });
    await handlers.get('hnovaFish.connectBrowser')!();
    const endpoint = new URL(address);
    const headers = { Authorization: `Bearer ${endpoint.hash.slice(1)}` };
    assert.equal((await fetch(`${endpoint.origin}/next`, { headers })).status, 204);
    const roots = await tree.getChildren();
    const forum = roots.find((item: any) => item.source === 'tieba');
    const pending = tree.getChildren(forum);
    await new Promise(resolve => setImmediate(resolve));
    const task = await (await fetch(`${endpoint.origin}/next`, { headers })).json();
    assert.match(task.url, /^https:\/\/tieba\.baidu\.com\/f\?/);
    await fetch(`${endpoint.origin}/result`, { method: 'POST', headers, body: JSON.stringify({ id: task.id, status: 200, body: '<a href="/p/123">浏览器列表正常返回</a>' }) });
    const children = await pending;
    assert.equal(children[0].entry.title, '浏览器列表正常返回');
    assert.equal(cookieReads, 0, 'Stored Cookie and Cookie jar must be unused in browser mode');
    // Simulate a real extension-host reload with the same SecretStorage.
    subscriptions.forEach(item => item.dispose()); subscriptions.length = 0;
    address = '';
    require('../extension').activate({ subscriptions, secrets: secretStore, globalState: { get: (_key: string, fallback: any) => fallback } });
    const rootsAgain = await tree.getChildren();
    const listAgain = tree.getChildren(rootsAgain.find((item: any) => item.source === 'tieba'));
    let nextTask: any;
    for (let attempt = 0; attempt < 80 && !nextTask; attempt++) {
      try {
        const response = await fetch(`${endpoint.origin}/next`, { headers });
        if (response.status === 200) nextTask = await response.json();
      } catch { /* The old listener may still be closing. */ }
      if (!nextTask) await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.ok(nextTask, 'First read immediately after reload waits for automatic reconnect');
    assert.equal(address, '', 'Reload must not require copying a new address');
    await fetch(`${endpoint.origin}/result`, { method: 'POST', headers, body: JSON.stringify({ id: nextTask.id, status: 200, body: '<a href="/p/124">重载后自动读取</a>' }) });
    assert.equal((await listAgain)[0].entry.title, '重载后自动读取');
    assert.equal(cookieReads, 0);
    await handlers.get('hnovaFish.disconnectBrowser')!();
    assert.equal(secrets.has('browser.tieba.pairing'), false, 'Explicit disconnect revokes the persistent pairing');

  } finally {
    subscriptions.forEach(item => item.dispose()); Module._load = originalLoad; globalThis.fetch = originalFetch;
  }
});
