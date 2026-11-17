import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createContext, runInContext } from 'node:vm';

test('companion remembers pairing, automatically retries host reloads and forgets it on explicit disconnect', async () => {
  const address = `http://127.0.0.1:12345/#${'a'.repeat(64)}`;
  const storage = new Map([['hnovaFish.connection', address]]);
  const elements = new Map<string, any>();
  let denied = false;
  let calls = 0, resumed!: () => void;
  const reconnected = new Promise<void>(resolve => { resumed = resolve; });
  const context = createContext({
    URL, TextEncoder, AbortController, AbortSignal, TypeError, clearTimeout,
    setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay === 1500 ? 1 : delay),
    localStorage: { getItem: (key: string) => storage.get(key), setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) },
    document: { querySelector: (selector: string) => { if (!elements.has(selector)) elements.set(selector, { dataset: {} }); return elements.get(selector); } },
    chrome: { tabs: { create: async () => ({ id: 7, url: 'https://tieba.baidu.com/' }) } },
    fetch: async (input: string, options: any) => {
      assert.equal(input, 'http://127.0.0.1:12345/next?wait=1');
      assert.equal(options.headers.Authorization, `Bearer ${'a'.repeat(64)}`);
      calls++;
      if (denied) return { status: 401, ok: false };
      if (calls === 1) throw new TypeError('Host is restarting');
      if (calls === 2) { resumed(); return { status: 204, ok: true }; }
      return new Promise((_, reject) => options.signal.addEventListener('abort', () => reject(new TypeError('Stopped')), { once: true }));
    }
  });
  runInContext(readFileSync(resolve(__dirname, '../../browser-companion/connect.js'), 'utf8'), context);
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([reconnected, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Automatic reconnect did not run')), 2000); })]);
    assert.equal(elements.get('#address').value, address);
    assert.equal(storage.get('hnovaFish.connection'), address);
    assert.equal(elements.get('#connect').disabled, true);
    elements.get('#disconnect').onclick();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(storage.has('hnovaFish.connection'), false);
    assert.equal(elements.get('#status').textContent, '已断开');
    assert.equal(elements.get('#connect').disabled, false);
    denied = true;
    await elements.get('#connect').onclick();
    assert.equal(storage.has('hnovaFish.connection'), false, 'Rejected credentials require pairing again, never an endless retry');
    assert.match(elements.get('#status').textContent, /连接地址已过期/);
  } finally { clearTimeout(timeout); elements.get('#disconnect')?.onclick(); }
});

test('companion reads rendered content even while subresources keep loading and uses a dedicated tab for normal page navigation and enforces read URL scope', async () => {
  const elements = new Map<string, any>();
  const navigated: string[] = [];
  let tab = { id: 7, windowId: 1, status: 'loading', url: 'https://tieba.baidu.com/' };
  let created = 0;
  const context = createContext({
    URL, setTimeout, clearTimeout, TextEncoder,
    document: { querySelector: (selector: string) => { if (!elements.has(selector)) elements.set(selector, { dataset: {} }); return elements.get(selector); } },
    chrome: {
      tabs: {
        onUpdated: { addListener() {}, removeListener() {} },
        create: async () => { created++; return tab; },
        get: async () => tab,
        update: async (_id: number, update: { url?: string }) => { if (update.url) { navigated.push(update.url); tab = { ...tab, url: update.url }; } return tab; }
      },
      scripting: { executeScript: async (options: any) => {
        assert.equal(options.target.tabId, 7);
        assert.equal(options.args[0], tab.url);
        return [{ result: { status: 200, body: '<div class="d_post_content">来自浏览器页面的正文</div>' } }];
      } }
    }
  });
  runInContext(readFileSync(resolve(__dirname, '../../browser-companion/connect.js'), 'utf8'), context);
  const result = await runInContext('readPage("https://tieba.baidu.com/p/123?pn=2")', context);
  assert.equal(created, 1); assert.deepEqual(navigated, ['https://tieba.baidu.com/p/123?pn=2']);
  assert.match(result.body, /来自浏览器页面/);
  await assert.rejects(runInContext('readPage("https://evil.com/p/123")', context), /超出贴吧阅读范围/);
});


test('injected reader waits for rendered DOM mutations and rejects an empty shell', async () => {
  const { JSDOM } = require('jsdom');
  let injected: Function | undefined;
  const elements = new Map<string, any>();
  const context = createContext({ URL, TextEncoder, setTimeout, clearTimeout,
    document: { querySelector: (selector: string) => { if (!elements.has(selector)) elements.set(selector, {}); return elements.get(selector); } },
    chrome: { tabs: {
      create: async () => ({ id: 1, url: 'https://tieba.baidu.com/p/123', status: 'loading' }),
      get: async () => ({ id: 1, url: 'https://tieba.baidu.com/p/123', status: 'loading' }),
      onUpdated: { addListener() {}, removeListener() {} }
    }, scripting: { executeScript: async (options: any) => { injected = options.func; return [{ result: {} }]; } } }
  });
  runInContext(readFileSync(resolve(__dirname, '../../browser-companion/connect.js'), 'utf8'), context);
  await runInContext('readPage("https://tieba.baidu.com/p/123")', context);
  for (const content of [true, false]) {
    const dom = new JSDOM('<html><head><title>贴吧</title></head><body></body></html>', { url: 'https://tieba.baidu.com/p/123', runScripts: 'outside-only' });
    try {
      dom.window.TextEncoder = TextEncoder;
      if (!content) dom.window.setTimeout = (callback: Function) => setTimeout(callback, 5);
      const reader = dom.window.eval(`(${injected!.toString()})`);
      const pending = reader('https://tieba.baidu.com/p/123');
      if (content) dom.window.document.body.innerHTML = '<div class="pb-content-wrap">异步加载的真实正文</div>';
      const result = await pending;
      if (content) { assert.equal(result.status, 200); assert.match(result.body, /异步加载的真实正文/); }
      else { assert.match(result.error, /尚未出现可读取/); assert.equal(result.body, undefined); }
    } finally { dom.window.close(); }
  }
});
