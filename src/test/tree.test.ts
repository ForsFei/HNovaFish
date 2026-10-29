import { test } from 'node:test';
import assert from 'node:assert/strict';

test('recommendation refresh replaces the batch, retains it on failure and restarts after the final page', async () => {
  const Module = require('node:module');
  const originalLoad = Module._load;
  const originalFetch = globalThis.fetch;
  let tree: any;
  const commands = new Map<string, (...args: any[]) => Promise<void>>();
  const errors: string[] = [];
  let session = 'session=one';
  let fail = false;
  let calls = 0;
  let forums = ['图拉丁'];
  let forumInput = 'https://tieba.baidu.com/f?kw=%E7%94%B5%E5%BD%B1';
  let browseMode: 'temporary' | 'permanent' | undefined = 'temporary';
  const mock = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} },
    TreeItem: class { constructor(public label: string, public collapsibleState?: number) {} },
    ThemeIcon: class { constructor(public id: string) {} },
    TreeItemCollapsibleState: { Collapsed: 1, Expanded: 2 }, ProgressLocation: { Window: 10 }, ConfigurationTarget: { Global: 1 },
    workspace: { getConfiguration: () => ({
      get: (key: string, fallback: unknown) => key === 'forums' ? forums : fallback,
      update: async (key: string, value: string[], target: number) => { assert.equal(key, 'forums'); assert.equal(target, 1); forums = value; }
    }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    window: {
      registerWebviewViewProvider: () => ({ dispose() {} }),
      registerTreeDataProvider: (_id: string, provider: any) => { tree = provider; return { dispose() {} }; },
      withProgress: async (_options: unknown, action: () => Promise<unknown>) => action(),
      showErrorMessage: async (message: string) => { errors.push(message); },
      showInputBox: async () => forumInput,
      showQuickPick: async (items: any[]) => items.find(item => item.mode === browseMode)
    },
    commands: { registerCommand: (id: string, handler: (...args: any[]) => Promise<void>) => { commands.set(id, handler); return { dispose() {} }; } }
  };
  Module._load = function(id: string, ...args: unknown[]) { return id === 'vscode' ? mock : originalLoad.call(this, id, ...args); };
  globalThis.fetch = (async (input: unknown, options: RequestInit) => {
    calls++; assert.equal((options.headers as Record<string, string>).Cookie, session);
    if (fail) return new Response('', { status: 403 });
    const url = new URL(String(input));
    if (url.hostname === 'tieba.baidu.com') {
      if (url.pathname === '/f/index/feedlist') {
        const second = url.searchParams.get('pn') === '2';
        return new Response(JSON.stringify({ no: 0, data: { html: `<a href="/p/${second ? '102' : '101'}">${second ? '第二批首页推荐' : '第一批首页推荐'}</a>`, has_more: second ? 0 : 1 } }));
      }
      return new Response('<a href="/p/432">其他贴吧帖子</a>');
    }
    const second = new URL(String(input)).searchParams.get('page_number') === '2';
    return new Response(JSON.stringify({ data: second
      ? [{ target: { type: 'article', id: 3, title: '下一页文章' } }]
      : [{ target: { type: 'answer', id: 1, question: { id: 2, title: '推荐问题' }, author: { name: '作者' } } }],
      paging: { is_end: second, next: '/api/v3/feed/topstory/recommend?page_number=2&after_id=1' } }));
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
    assert.equal(tree.getTreeItem(children[1]).label, '刷新推荐 · 换一批');
    await tree.getChildren(recommend); assert.equal(calls, 1, 'Expanding a loaded group uses its current list');
    fail = true;
    await commands.get('hnovaFish.more')!(recommend);
    assert.equal(errors.length, 1); assert.equal((await tree.getChildren(recommend))[0].entry.title, '推荐问题');
    fail = false;
    await commands.get('hnovaFish.more')!(recommend);
    children = await tree.getChildren(recommend);
    assert.equal(children.length, 2, 'Only the new batch and a refresh button remain');
    assert.equal(children[0].entry.title, '下一页文章');
    assert.ok(!children.some((node: any) => node.entry?.title === '推荐问题'), 'Previous batch is removed');
    assert.equal(children[1].kind, 'more', 'Refresh remains available after the final page');
    await commands.get('hnovaFish.more')!(recommend);
    children = await tree.getChildren(recommend);
    assert.equal(children[0].entry.title, '推荐问题');
    assert.ok(!children.some((node: any) => node.entry?.title === '下一页文章'));
    session = 'session=two';
    await commands.get('hnovaFish.refresh')!();
    children = await tree.getChildren(recommend);
    assert.equal(children[1].kind, 'more'); assert.equal(calls, 5, 'Refresh starts a new recommendation request using current cookie');
    let updatedRoots = await tree.getChildren();
    const home = updatedRoots.find((node: any) => node.source === 'tiebaHome');
    assert.equal(home.title, '贴吧 · 首页推荐');
    let homeChildren = await tree.getChildren(home); assert.equal(homeChildren[0].entry.title, '第一批首页推荐');
    await commands.get('hnovaFish.more')!(home);
    homeChildren = await tree.getChildren(home);
    assert.equal(homeChildren[0].entry.title, '第二批首页推荐'); assert.equal(homeChildren.length, 2, 'Homepage refresh replaces old items');
    assert.ok(updatedRoots.some((node: any) => node.command === 'browseForum'));
    await commands.get('hnovaFish.browseForum')!();
    updatedRoots = await tree.getChildren();
    const temporary = updatedRoots.find((node: any) => node.forum === '电影');
    assert.match(temporary.title, /临时浏览/); assert.equal(forums.includes('电影'), false);
    const posts = await tree.getChildren(temporary); assert.equal(posts[0].entry.title, '其他贴吧帖子');
    assert.ok(posts.some((node: any) => node.command === 'pinForum'));
    await commands.get('hnovaFish.pinForum')!('电影');
    updatedRoots = await tree.getChildren();
    assert.equal(updatedRoots.filter((node: any) => node.forum === '电影').length, 1); assert.ok(forums.includes('电影')); assert.ok(forums.includes('图拉丁'));
    forumInput = '足球'; await commands.get('hnovaFish.browseForum')!();
    assert.ok((await tree.getChildren()).some((node: any) => node.forum === '足球'));
    await commands.get('hnovaFish.closeBrowseForum')!();
    assert.ok(!(await tree.getChildren()).some((node: any) => node.forum === '足球'));
    browseMode = 'permanent'; forumInput = '摄影';
    await commands.get('hnovaFish.browseForum')!();
    updatedRoots = await tree.getChildren();
    assert.ok(forums.includes('摄影'), 'Permanent choice persists the forum configuration');
    assert.equal(updatedRoots.find((node: any) => node.forum === '摄影').title, '摄影吧');
    await commands.get('hnovaFish.browseForum')!();
    assert.equal(forums.filter(name => name === '摄影').length, 1, 'Adding an existing forum never duplicates it');
    browseMode = undefined; forumInput = '体育';
    await commands.get('hnovaFish.browseForum')!();
    assert.ok(!forums.includes('体育')); assert.ok(!(await tree.getChildren()).some((node: any) => node.forum === '体育'), 'Canceling the mode picker leaves the directory unchanged');
    activate({ subscriptions, secrets: { get: async () => session }, globalState: { get: (_key: string, fallback: unknown) => fallback } });
    updatedRoots = await tree.getChildren();
    assert.ok(updatedRoots.some((node: any) => node.forum === '摄影'), 'Permanent forum survives extension reactivation');
    assert.ok(!updatedRoots.some((node: any) => node.title?.includes('临时浏览')), 'Temporary browsing state is not persisted');
  } finally {
    subscriptions.forEach(item => item.dispose());
    Module._load = originalLoad;
    globalThis.fetch = originalFetch;
  }
});
