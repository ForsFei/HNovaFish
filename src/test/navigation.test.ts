import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseLink } from '../model';

test('native shortcut defaults are editable commands and arrow bindings only apply to the reader', () => {
  const manifest = JSON.parse(readFileSync(resolve(__dirname, '../../package.json'), 'utf8'));
  const bindings = manifest.contributes.keybindings;
  for (const [command, key] of [['previousArticle', 'left'], ['nextArticle', 'right'], ['bossKey', 'numpad0']]) {
    const id = `hnovaFish.${command}`;
    assert.ok(manifest.contributes.commands.some((item: any) => item.command === id));
    const binding = bindings.find((item: any) => item.command === id);
    assert.equal(binding.key, key);
    if (command !== 'bossKey') {
      assert.match(binding.when, /hnovaFish\.readerFocused/);
      assert.match(binding.when, /focusedView == hnovaFish\.feed/);
      assert.match(binding.when, /!inputFocus/);
    }
  }
});

test('article navigation follows the clicked list, respects boundaries and boss key cancels pending reads', async () => {
  const Module = require('node:module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
  const handlers = new Map<string, (...args: any[]) => Promise<void>>();
  const state = new Map<string, any>();
  const actions: string[] = [], errors: string[] = [];
  let tree: any, provider: any, html = '', resolved = false, hidden = false, calls = 0;
  let fail = false, pause: Promise<void> | undefined;
  const view = {
    show() { hidden = false; }, onDidDispose() { return { dispose() {} }; },
    webview: { options: {}, get html() { return html; }, set html(value: string) { html = value; }, onDidReceiveMessage() { return { dispose() {} }; } }
  };
  const mock = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    TreeItem: class { constructor(public label: string) {} }, ThemeIcon: class {},
    TreeItemCollapsibleState: { Collapsed: 1, Expanded: 2 }, ProgressLocation: { Window: 10 },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: any) => fallback }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    commands: {
      registerCommand(id: string, handler: (...args: any[]) => Promise<void>) { handlers.set(id, handler); return { dispose() {} }; },
      async executeCommand(id: string, ...args: any[]) {
        actions.push(id);
        if (id === 'hnovaFish.reader.focus') { hidden = false; if (!resolved) { resolved = true; provider.resolveWebviewView(view); } }
        else if (id === 'workbench.action.closeAuxiliaryBar') hidden = true;
        else if (id === 'workbench.action.openGlobalKeybindings') assert.equal(args[0], '@ext:hnova.hnova-fish');
        else await handlers.get(id)?.(...args);
      }
    },
    window: {
      registerTreeDataProvider(_id: string, value: any) { tree = value; return { dispose() {} }; },
      registerWebviewViewProvider(_id: string, value: any) { provider = value; return { dispose() {} }; },
      withProgress: async (_: any, run: () => Promise<any>) => run(),
      showErrorMessage: async (message: string) => { errors.push(message); }, showWarningMessage: async () => undefined
    }
  };
  Module._load = function(id: string, ...args: unknown[]) { return id === 'vscode' ? mock : originalLoad.call(this, id, ...args); };
  globalThis.fetch = (async (input: unknown) => {
    calls++; const url = new URL(String(input));
    if (url.pathname.includes('/hot-lists/')) return new Response(JSON.stringify({ data: [1, 2, 3].map(id => ({ target: { id, title: `问题${id}` } })) }));
    if (url.pathname.includes('/recommend')) return new Response(JSON.stringify({ data: [1, 4].map(id => ({ target: { type: 'question', id, title: `推荐${id}` } })), paging: { is_end: true } }));
    if (pause) await pause;
    if (fail) return new Response('', { status: 403 });
    return new Response(JSON.stringify({ data: [{ id: '99', content: '测试正文', author: { name: '作者' } }], paging: { is_end: true } }));
  }) as typeof fetch;
  const subscriptions: { dispose(): void }[] = [];
  const run = (command: string, ...args: any[]) => handlers.get(`hnovaFish.${command}`)!(...args);
  const urlShown = (id: number) => assert.ok(html.includes(`data-page-url="https://www.zhihu.com/question/${id}"`));
  try {
    require('../extension').activate({ subscriptions, secrets: { get: async () => 'session=test' }, globalState: { get: (key: string, fallback: unknown) => state.get(key) ?? fallback, update: async (key: string, value: unknown) => { state.set(key, value); } } });
    const roots = await tree.getChildren();
    const hot = await tree.getChildren(roots.find((item: any) => item.source === 'zhihu'));
    const recommended = await tree.getChildren(roots.find((item: any) => item.source === 'recommend'));
    await run('read', ...tree.getTreeItem(hot[0]).command.arguments); urlShown(1);
    const before = calls;
    await run('previousArticle'); assert.equal(calls, before, 'First item has no previous article');
    await run('nextArticle'); urlShown(2);
    await run('nextArticle'); urlShown(3);
    const last = calls;
    await run('nextArticle'); assert.equal(calls, last, 'Do not wrap or fetch another batch at the boundary');
    await run('previousArticle'); urlShown(2);
    await run('read', ...tree.getTreeItem(recommended[0]).command.arguments); urlShown(1);
    await run('nextArticle'); urlShown(4);
    const history = await tree.getChildren(roots.find((item: any) => item.source === 'history'));
    await run('read', ...tree.getTreeItem(history[0]).command.arguments);
    await run('nextArticle');
    assert.ok(html.includes(`data-page-url="${history[1].entry.url}"`));
    await run('previousArticle');
    assert.ok(html.includes(`data-page-url="${history[0].entry.url}"`), 'History reordering must not trap next/previous on the same article');
    await run('read', ...tree.getTreeItem(hot[0]).command.arguments);
    state.set('articles', []);
    fail = true;
    await run('nextArticle'); urlShown(1);
    fail = false;
    await run('nextArticle'); urlShown(2);
    await run('configureShortcuts');
    let release!: () => void;
    pause = new Promise<void>(resolve => { release = resolve; });
    const pending = run('nextArticle');
    await run('nextArticle'); // Repeated presses do not start a second request.
    await run('bossKey');
    assert.equal(actions.at(-1), 'workbench.panel.output.focus');
    assert.equal(hidden, false, 'Boss key preserves sidebar visibility');
    const afterBoss = actions.length;
    release(); await pending; assert.equal(actions.length, afterBoss, 'A late article response cannot steal focus from Output'); urlShown(2);
    pause = undefined;
    await run('read', parseLink('https://www.zhihu.com/question/77'));
    const direct = calls;
    await run('nextArticle'); assert.equal(calls, direct, 'A standalone URL does not inherit an unrelated list');
    assert.deepEqual(errors, []);
  } finally {
    subscriptions.forEach(item => item.dispose()); Module._load = originalLoad; globalThis.fetch = originalFetch;
  }
});
