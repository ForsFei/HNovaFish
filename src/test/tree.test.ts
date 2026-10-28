import { test } from 'node:test';
import assert from 'node:assert/strict';

test('recommendation sidebar loads pages, deduplicates, retains results on errors and resets on refresh', async () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  let tree: any;
  const commands = new Map<string, (...args: any[]) => Promise<void>>();
  const errors: string[] = [];
  let session = 'session=one';
  let fail = false;
  let calls = 0;
  const mock = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
    ThemeIcon: class { constructor(public id: string) {} },
    TreeItemCollapsibleState: { Collapsed: 1 }, ProgressLocation: { Window: 10 },
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    window: {
      registerWebviewViewProvider: () => ({ dispose() {} }),
      registerTreeDataProvider: (_id: string, provider: any) => { tree = provider; return { dispose() {} }; },
      withProgress: async (_options: unknown, action: () => Promise<unknown>) => action(),
      showErrorMessage: async (message: string) => { errors.push(message); }
    },
    commands: { registerCommand: (id: string, handler: (...args: any[]) => Promise<void>) => { commands.set(id, handler); return { dispose() {} }; } }
  };
  Module._load = function(id: string, ...args: unknown[]) { return id === 'vscode' ? mock : originalLoad.call(this, id, ...args); };
  globalThis.fetch = (async (input: unknown, options: RequestInit) => {
    calls++; assert.equal((options.headers as Record<string, string>).Cookie, session);
    if (fail) return new Response('', { status: 403 });
    const second = new URL(String(input)).searchParams.get('page_number') === '2';
    return new Response(JSON.stringify({ data: [
      { target: { type: 'answer', id: 1, question: { id: 2, title: '推荐问题' }, author: { name: '作者' } } },
      ...(second ? [{ target: { type: 'article', id: 3, title: '下一页文章' } }] : [])
    ], paging: { is_end: second, next: '/api/v3/feed/topstory/recommend?page_number=2&after_id=1' } }));
  }) as typeof fetch;
  const subscriptions: { dispose(): void }[] = [];
  try {
    const { activate } = require('../extension');
    activate({ subscriptions, secrets: { get: async () => session }, globalState: { get: (_key: string, fallback: unknown) => fallback } });
    const roots = await tree.getChildren();
    const recommend = roots.find((node: any) => node.source === 'recommend');
    assert.equal(recommend.title, '知乎 · 个性化推荐'); assert.ok(roots.some((node: any) => node.source === 'zhihu'));
    let children = await tree.getChildren(recommend);
    assert.equal(children[0].entry.title, '推荐问题'); assert.equal(tree.getTreeItem(children[0]).description, '回答 · 作者');
    assert.equal(children[1].kind, 'more');
    await tree.getChildren(recommend); assert.equal(calls, 1, 'Expanding a loaded group uses its current list');
    fail = true;
    await commands.get('hnovaFish.more')!(recommend);
    assert.equal(errors.length, 1); assert.equal((await tree.getChildren(recommend))[0].entry.title, '推荐问题');
    fail = false;
    await commands.get('hnovaFish.more')!(recommend);
    children = await tree.getChildren(recommend);
    assert.equal(children.length, 2, 'Overlapping recommendation is deduplicated and end state removes more button');
    assert.equal(children[1].entry.title, '下一页文章');
    session = 'session=two';
    await commands.get('hnovaFish.refresh')!();
    children = await tree.getChildren(recommend);
    assert.equal(children[1].kind, 'more'); assert.equal(calls, 4, 'Refresh starts a new recommendation request using current cookie');
  } finally {
    subscriptions.forEach(item => item.dispose());
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
});
