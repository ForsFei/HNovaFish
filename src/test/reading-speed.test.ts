import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLink } from '../model';

test('body is visible before slow previews finish, and late previews cannot replace the next article', async () => {
  const Module = require('node:module'), originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  let html = '', position = 'right';
  let configChanged: any;
  const providers = new Map<string, any>(), resolved = new Set<string>();
  const actions: string[] = [];
  let release!: () => void;
  const slow = new Promise<void>(resolve => { release = resolve; });
  const subscriptions: { dispose(): void }[] = [];
  const view = { show() {}, onDidDispose: () => ({ dispose() {} }), webview: {
    options: {}, get html() { return html; }, set html(value: string) { html = value; },
    onDidReceiveMessage: () => ({ dispose() {} })
  } };
  const mock = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} }, ProgressLocation: { Window: 10 },
    workspace: { getConfiguration: () => ({ get: (key: string, fallback: any) => key === 'readerPosition' ? position : fallback }), onDidChangeConfiguration: (callback: any) => { configChanged = callback; return { dispose() {} }; } },
    window: {
      registerTreeDataProvider: () => ({ dispose() {} }),
      registerWebviewViewProvider: (id: string, value: any) => { providers.set(id, value); return { dispose() {} }; },
      withProgress: async (_options: any, action: any) => action(),
      showErrorMessage: async (message: string) => assert.fail(message),
      showWarningMessage: async (message: string) => assert.fail(message)
    },
    commands: {
      registerCommand: (id: string, callback: any) => { handlers.set(id, callback); return { dispose() {} }; },
      executeCommand: async (id: string) => { actions.push(id); const key = id.replace(/\.focus$/, ''); if (providers.has(key) && !resolved.has(key)) { resolved.add(key); providers.get(key).resolveWebviewView(view); } }
    }
  };
  Module._load = function(id: string, ...args: unknown[]) { return id === 'vscode' ? mock : originalLoad.call(this, id, ...args); };
  globalThis.fetch = (async (input: any) => {
    const url = new URL(String(input));
    if (url.pathname === '/p/totalComment') {
      await slow;
      return new Response(JSON.stringify({ data: { comment_list: { '999': { comment_num: 1, comment_info: [{ comment_id: '1000', content: '旧帖晚到的预览' }] } } } }));
    }
    return new Response(url.pathname === '/p/2' ? '<div class="pb-content-wrap">第二篇正文</div>' : '<h1>帖子</h1><div class="d_post_content" id="post_content_999">立即阅读的正文</div>');
  }) as typeof fetch;
  try {
    require('../extension').activate({ subscriptions, secrets: { get: async () => undefined }, globalState: { get: (_key: string, fallback: any) => fallback, update: async () => {} } });
    const first = handlers.get('hnovaFish.read')!(parseLink('https://tieba.baidu.com/p/1'));
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([first, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The body must not wait for the preview request')), 1000); })]);
    } finally { clearTimeout(timer); }
    assert.match(html, /立即阅读的正文/);
    assert.doesNotMatch(html, /旧帖晚到/);
    position = 'bottom';
    configChanged({ affectsConfiguration: (key: string) => key === 'hnovaFish.readerPosition' || key === 'hnovaFish' });
    assert.equal(actions.at(-1), 'hnovaFish.readerBottom.focus');
    assert.match(html, /立即阅读的正文/, 'Moving the reader preserves the current article');
    await handlers.get('hnovaFish.hide')!();
    assert.equal(actions.at(-1), 'workbench.action.closePanel');
    position = 'right';
    configChanged({ affectsConfiguration: (key: string) => key === 'hnovaFish.readerPosition' || key === 'hnovaFish' });
    assert.match(html, /立即阅读的正文/);

    const second = handlers.get('hnovaFish.read')!(parseLink('https://tieba.baidu.com/p/2'));
    release(); await second;
    await new Promise(resolve => setImmediate(resolve));
    assert.match(html, /data-page-url="https:\/\/tieba.baidu.com\/p\/2"/);
    assert.doesNotMatch(html, /旧帖晚到/);
  } finally {
    release(); subscriptions.forEach(item => item.dispose());
    Module._load = originalLoad; globalThis.fetch = originalFetch;
  }
});
