import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserBridge, browserReadUrl, parseBrowserPairing } from '../browserBridge';
import { Providers } from '../providers';
import { parseLink } from '../model';

const origin = `chrome-extension://${'a'.repeat(32)}`;

test('a conflicting VS Code listener fails without changing the saved port or replacing its owner', async () => {
  const owner = new BrowserBridge();
  const address = new URL(await owner.start());
  const conflict = new BrowserBridge(owner.pairing);
  try {
    await assert.rejects(conflict.start(), { code: 'EADDRINUSE' });
    conflict.dispose();
    assert.equal((await fetch(`${address.origin}/next`, { headers: { Authorization: `Bearer ${address.hash.slice(1)}` } })).status, 204);
  } finally { owner.dispose(); }
});

test('saved pairing validates data, restores the same listener and retains the paired extension origin', async () => {
  for (const value of ['', '{}', '{"port":0,"token":"bad"}', JSON.stringify({ port: 123, token: 'a'.repeat(64), origin: 'https://evil.com' })]) assert.equal(parseBrowserPairing(value), undefined);
  let saved: any;
  const first = new BrowserBridge(undefined, async pairing => { saved = pairing; });
  const address = new URL(await first.start());
  const headers = { Origin: origin, Authorization: `Bearer ${address.hash.slice(1)}` };
  await fetch(`${address.origin}/next`, { headers });
  assert.equal(saved.origin, origin);
  first.dispose();
  const restored = new BrowserBridge(parseBrowserPairing(JSON.stringify(saved)), undefined, 1000);
  try {
    assert.equal(await restored.start(), address.href);
    const pending = restored.fetch('https://tieba.baidu.com/p/1');
    assert.equal((await fetch(`${address.origin}/next`, { headers: { ...headers, Origin: `chrome-extension://${'b'.repeat(32)}` } })).status, 403);
    // The first read waits briefly for the browser to reconnect after reload.
    const task = await (await fetch(`${address.origin}/next?wait=1`, { headers })).json();
    await fetch(`${address.origin}/result`, { method: 'POST', headers, body: JSON.stringify({ id: task.id, status: 200, body: '自动重连正文' }) });
    assert.equal(await (await pending).text(), '自动重连正文');
  } finally { restored.dispose(); }
});

test('browser bridge only permits read endpoints on the exact Tieba HTTPS host', () => {
  for (const url of ['https://evil.com/p/1', 'http://tieba.baidu.com/p/1', 'https://tieba.baidu.com/logout', 'https://user@tieba.baidu.com/p/1']) assert.throws(() => browserReadUrl(url));
  assert.equal(browserReadUrl('https://tieba.baidu.com/p/1?pn=2'), 'https://tieba.baidu.com/p/1?pn=2');
});

test('browser bridge requires the pairing token and extension origin, transfers content and supports cancellation', async () => {
  const bridge = new BrowserBridge();
  const address = new URL(await bridge.start());
  const headers = { Origin: origin, Authorization: `Bearer ${address.hash.slice(1)}` };
  const endpoint = address.origin;
  try {
    await assert.rejects(bridge.fetch('https://tieba.baidu.com/p/1'), /尚未连接/);
    assert.equal((await fetch(`${endpoint}/next`, { headers: { Origin: origin } })).status, 401);
    assert.equal((await fetch(`${endpoint}/next`, { headers: { ...headers, Origin: 'https://evil.com' } })).status, 403);
    assert.equal((await fetch(`${endpoint}/next`, { headers })).status, 204);
    const pending = bridge.fetch('https://tieba.baidu.com/p/1?pn=2', { headers: { Cookie: 'secret=must-not-transfer' } });
    const task = await (await fetch(`${endpoint}/next`, { headers })).json();
    assert.deepEqual(Object.keys(task).sort(), ['id', 'url']);
    assert.equal(task.url, 'https://tieba.baidu.com/p/1?pn=2');
    assert.equal((await fetch(`${endpoint}/result`, { method: 'POST', headers, body: JSON.stringify({ id: task.id, status: 200, body: '<div>浏览器正文</div>' }) })).status, 204);
    assert.equal(await (await pending).text(), '<div>浏览器正文</div>');
    const controller = new AbortController();
    const cancelled = bridge.fetch('https://tieba.baidu.com/p/1', { signal: controller.signal });
    const rejected = assert.rejects(cancelled, /取消/);
    controller.abort(); await rejected;
    assert.equal((await fetch(`${endpoint}/next`, { headers })).status, 204);
    assert.equal((await fetch(`${endpoint}/next`, { headers: { ...headers, Origin: `chrome-extension://${'b'.repeat(32)}` } })).status, 403);
  } finally { bridge.dispose(); }
});

test('extension requests without Origin still require a valid token and accept reply uploads', async () => {
  const bridge = new BrowserBridge();
  const address = new URL(await bridge.start());
  const headers = { Authorization: `Bearer ${address.hash.slice(1)}` };
  try {
    assert.equal((await fetch(`${address.origin}/next`)).status, 401);
    assert.equal((await fetch(`${address.origin}/next`, { headers })).status, 204);
    const pending = bridge.fetch('https://tieba.baidu.com/p/123');
    const task = await (await fetch(`${address.origin}/next`, { headers })).json();
    assert.equal((await fetch(`${address.origin}/result`, { method: 'POST', headers, body: JSON.stringify({ id: task.id, status: 200, body: '配对成功后的正文' }) })).status, 204);
    assert.equal(await (await pending).text(), '配对成功后的正文');
    assert.equal((await fetch(`${address.origin}/next`, { headers: { ...headers, Origin: 'null' } })).status, 403);
    assert.equal((await fetch(`${address.origin}/next`, { method: 'OPTIONS', headers: { Origin: 'https://evil.com' } })).status, 403);
  } finally { bridge.dispose(); }
});

test('existing Tieba list, article and pagination adapters read through the browser connection', async () => {
  const bridge = new BrowserBridge();
  const address = new URL(await bridge.start());
  const headers = { Origin: origin, Authorization: `Bearer ${address.hash.slice(1)}` };
  await fetch(`${address.origin}/next`, { headers });
  const provider = new Providers(async () => undefined, bridge.fetch);
  async function answer(body: string) {
    const task = await (await fetch(`${address.origin}/next`, { headers })).json();
    await fetch(`${address.origin}/result`, { method: 'POST', headers, body: JSON.stringify({ id: task.id, status: 200, body }) });
    return task.url;
  }
  try {
    const listing = provider.list('tieba', '图拉丁');
    await new Promise(resolve => setImmediate(resolve));
    await answer('<a href="/p/123">浏览器读取的帖子</a>');
    assert.equal((await listing)[0].title, '浏览器读取的帖子');
    const entry = parseLink('https://tieba.baidu.com/p/123');
    const article = provider.article(entry, 'https://tieba.baidu.com/p/123?pn=2');
    await new Promise(resolve => setImmediate(resolve));
    assert.match(await answer('<div class="d_post_content" id="post_content_99">第二页正文</div><a href="?pn=3">下一页</a>'), /pn=2/);
    const result = await article;
    assert.equal(result.sections[0].html, '第二页正文');
    assert.equal(result.nextUrl, 'https://tieba.baidu.com/p/123?pn=3');
  } finally { bridge.dispose(); }
});


test('long polling delivers work immediately without background-page timer polling', async () => {
  const bridge = new BrowserBridge();
  const address = new URL(await bridge.start());
  const headers = { Authorization: `Bearer ${address.hash.slice(1)}` };
  try {
    const waiting = fetch(`${address.origin}/next?wait=1`, { headers });
    // A second authenticated request proves the server has accepted the pairing.
    await fetch(`${address.origin}/next`, { headers });
    const pending = bridge.fetch('https://tieba.baidu.com/p/123');
    const task = await (await waiting).json();
    assert.equal(task.url, 'https://tieba.baidu.com/p/123');
    await fetch(`${address.origin}/result`, { method: 'POST', headers, body: JSON.stringify({ id: task.id, status: 200, body: '正文' }) });
    assert.equal(await (await pending).text(), '正文');
  } finally { bridge.dispose(); }
});
