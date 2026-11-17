import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { JSDOM } from 'jsdom';
import { Article, parseLink } from '../model';
import { renderArticle } from '../render';

const answer: Article = { ...parseLink('https://www.zhihu.com/question/12/answer/99'), title: '问题', sections: [{ author: '作者', html: '<p>回答正文</p><a href="https://www.zhihu.com/question/34">链接</a>' }], fetchedAt: 1 };

test('selecting another post retains the directory scroll but resets body scroll; a new list resets the directory', () => {
  const other = { ...answer, ...parseLink('https://tieba.baidu.com/p/123'), title: '另一个帖子' };
  let state: any;
  const open = (article: Article, directory: Article[]) => {
    const dom = new JSDOM(renderArticle(article, { images: false, fontSize: 15, saved: false, bottom: true, directory }), { runScripts: 'outside-only' });
    dom.window.scrollTo = ((options: ScrollToOptions) => { Object.defineProperty(dom.window, 'scrollY', { value: options.top, configurable: true }); }) as typeof dom.window.scrollTo;
    dom.window.requestAnimationFrame = callback => { callback(0); return 0; };
    (dom.window as any).acquireVsCodeApi = () => ({ getState: () => state, setState: (value: any) => { state = value; }, postMessage() {} });
    dom.window.eval(dom.window.document.querySelector('script')!.textContent!);
    return dom;
  };
  const first = open(answer, [answer, other]);
  const list = first.window.document.querySelector<HTMLElement>('.post-directory')!;
  list.scrollTop = 580; list.dispatchEvent(new first.window.Event('scroll'));
  Object.defineProperty(first.window, 'scrollY', { value: 1000, configurable: true });
  first.window.document.querySelectorAll<HTMLButtonElement>('.post-directory button[data-action=selectPost]')[1].click();
  assert.equal(state.directoryScroll, 580);
  first.window.close();
  const second = open(other, [answer, other]);
  assert.equal(second.window.document.querySelector<HTMLElement>('.post-directory')!.scrollTop, 580);
  assert.equal(second.window.scrollY, 0);
  second.window.close();
  const third = open(other, [other]);
  assert.equal(third.window.document.querySelector<HTMLElement>('.post-directory')!.scrollTop, 0);
  third.window.close();
});

test('bottom reader has a separate post directory, aligned toolbar and clickable safe entries', () => {
  const other = { ...parseLink('https://tieba.baidu.com/p/123'), title: '<script>标题</script>' };
  const messages: any[] = [];
  const dom = new JSDOM(renderArticle(answer, { images: false, fontSize: 15, saved: false, bottom: true, directory: [answer, other], problems: [{ file: 'app.ts', line: 9, severity: '错误', message: '<script>诊断内容</script>' }] }), { runScripts: 'outside-only' });
  try {
    dom.window.scrollTo = () => {};
    dom.window.requestAnimationFrame = callback => { callback(0); return 0; };
    (dom.window as any).acquireVsCodeApi = () => ({ getState: () => undefined, setState() {}, postMessage: (message: any) => messages.push(message) });
    dom.window.eval(dom.window.document.querySelector('script')!.textContent!);
    assert.ok(dom.window.document.querySelector('.reader-layout.split > .reader-column > nav'));
    assert.ok(dom.window.document.querySelector('.reader-column > main'));
    assert.equal(dom.window.document.querySelectorAll('[role=separator]').length, 2);
    assert.ok(dom.window.document.querySelector('.work-pane'));
    assert.match(dom.window.document.querySelector('.work-pane')!.textContent!, /app.ts:9/);
    assert.equal(dom.window.document.querySelector('.work-pane script'), null);
    const layout = dom.window.document.querySelector<HTMLElement>('.reader-layout')!;
    Object.defineProperty(layout, 'clientWidth', { value: 1200 });
    const directory = dom.window.document.querySelector<HTMLElement>('.post-directory')!;
    const work = dom.window.document.querySelector<HTMLElement>('.work-pane')!;
    directory.getBoundingClientRect = () => ({ width: parseFloat(layout.style.getPropertyValue('--directory-width')) || 220 } as DOMRect);
    work.getBoundingClientRect = () => ({ width: parseFloat(layout.style.getPropertyValue('--work-width')) || 300 } as DOMRect);
    dom.window.document.querySelector('[data-resize="directory"]')!.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    assert.equal(layout.style.getPropertyValue('--directory-width'), '240px');
    const resized = messages.find(item => item.action === 'resizeColumns');
    assert.equal(resized.directoryWidth, 240); assert.equal(resized.workWidth, 300);

    assert.equal(dom.window.document.querySelector('[aria-current="page"]')!.textContent, '1问题');
    const button = dom.window.document.querySelectorAll<HTMLButtonElement>('.post-directory button[data-action=selectPost]')[1];
    assert.equal(button.querySelector('script'), null);
    button.click();
    assert.equal(messages.filter(item => item.action === 'selectPost').length, 1);
    assert.equal(messages.find(item => item.action === 'selectPost').url, other.url);
    const refresh = dom.window.document.querySelector<HTMLButtonElement>('[data-action=refreshDirectory]')!;
    assert.equal(refresh.parentElement!.lastElementChild, refresh, 'Refresh follows the last post');
    refresh.click(); refresh.click();
    assert.equal(messages.filter(item => item.action === 'refreshDirectory').length, 1);
    assert.equal(refresh.disabled, true);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'directoryRefreshDone' } }));
    assert.equal(refresh.disabled, false);

  } finally { dom.window.close(); }
});
function createReader(article: Article, postMessage: (message: any) => void) {
  const html = renderArticle(article, { images: false, fontSize: 15, saved: false });
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://reader.test/' });
  dom.window.scrollTo = () => {};
  dom.window.requestAnimationFrame = callback => { callback(0); return 0; };
  (dom.window as any).acquireVsCodeApi = () => ({ getState: () => undefined, setState: () => {}, postMessage });
  const script = dom.window.document.querySelector('script')!;
  new Script(script.textContent!);
  const nonce = script.getAttribute('nonce');
  assert.ok(nonce); assert.ok(dom.window.document.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')!.includes(`script-src 'nonce-${nonce}'`));
  dom.window.eval(script.textContent!);
  return dom;
}

test('every toolbar button actually posts its action when clicked', () => {
  const messages: any[] = [];
  const dom = createReader(answer, message => messages.push(message));
  try {
    for (const action of ['question', 'fontDown', 'fontUp', 'fontReset', 'save', 'refresh', 'original', 'hide']) dom.window.document.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)!.click();
    assert.deepEqual(messages.map(m => m.action), ['question', 'fontDown', 'fontUp', 'fontReset', 'save', 'refresh', 'original', 'hide']);
  } finally { dom.window.close(); }
});

test('reader iframe reports actual keyboard focus and resets it on blur', () => {
  const messages: any[] = [];
  const dom = createReader(answer, message => messages.push(message));
  try {
    dom.window.dispatchEvent(new dom.window.FocusEvent('focus'));
    dom.window.document.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }));
    dom.window.dispatchEvent(new dom.window.FocusEvent('blur'));
    assert.deepEqual(messages.map(message => ({ ...message })), [{ action: 'readerFocus', focused: true }, { action: 'readerFocus', focused: false }]);
  } finally { dom.window.close(); }
});

test('load more posts once while disabled and recovers on completion', () => {
  const messages: any[] = [];
  const dom = createReader({ ...answer, ...parseLink('https://www.zhihu.com/question/12'), nextUrl: 'https://www.zhihu.com/api/v4/questions/12/answers?offset=10' }, message => messages.push(message));
  try {
    const button = dom.window.document.querySelector<HTMLButtonElement>('button[data-action="next"]')!;
    button.click(); button.click(); assert.equal(messages.length, 1); assert.equal(button.disabled, true);
    dom.window.dispatchEvent(new dom.window.MessageEvent('message', { data: { type: 'loadingDone' } }));
    assert.equal(button.disabled, false); assert.equal(button.textContent, '加载更多回答 →');
    button.click(); assert.equal(messages.length, 2);
  } finally { dom.window.close(); }
});

test('answer index scrolls locally and ordinary links post a safe link action', () => {
  const messages: any[] = [];
  const dom = createReader({ ...answer, ...parseLink('https://www.zhihu.com/question/12') }, message => messages.push(message));
  let scrolled = false;
  try {
    (dom.window.document.getElementById('answer-0') as any).scrollIntoView = () => { scrolled = true; };
    dom.window.document.querySelector<HTMLAnchorElement>('a[href="#answer-0"]')!.click();
    assert.equal(scrolled, true); assert.equal(messages.length, 0);
    dom.window.document.querySelector<HTMLAnchorElement>('a[href="https://www.zhihu.com/question/34"]')!.click();
    assert.equal(messages[0].action, 'link'); assert.equal(messages[0].url, 'https://www.zhihu.com/question/34');
  } finally { dom.window.close(); }
});

test('right sidebar preserves editor area and supports toolbar, comments, pagination, hide and reopen', async () => {
  const Module = require('node:module'), originalLoad = Module._load, originalFetch = globalThis.fetch;
  const commands = new Map<string, (...args: any[]) => Promise<void>>();
  const state = new Map<string, any>(), subscriptions: { dispose(): void }[] = [];
  const pending: Promise<void>[] = [], external: string[] = [], errors: string[] = [];
  let dom: JSDOM | undefined, onMessage: (m: any) => Promise<void>, onDispose: () => void;
  let calls = 0, closed = false;
  let provider: any, resolved = false;
  let fontSize = 15;
  let recoveryReads = 0;
  const panel = {
    title: '', show(_preserveFocus?: boolean) { closed = false; },
    dispose() { closed = true; dom?.window.close(); onDispose?.(); },
    onDidDispose(callback: () => void) { onDispose = callback; return { dispose() {} }; },
    webview: {
      set html(html: string) {
        dom?.window.close(); dom = new JSDOM(html, { runScripts: 'outside-only' });
        dom.window.scrollTo = () => {};
        dom.window.requestAnimationFrame = callback => { callback(0); return 0; };
        (dom.window as any).acquireVsCodeApi = () => ({ getState: () => undefined, setState: () => {}, postMessage: (m: any) => { pending.push(Promise.resolve(onMessage(m))); } });
        const script = dom.window.document.querySelector('script');
        if (script) dom.window.eval(script.textContent!);
      },
      onDidReceiveMessage(callback: (m: any) => Promise<void>) { onMessage = callback; return { dispose() {} }; },
      async postMessage(message: any) { dom?.window.dispatchEvent(new dom.window.MessageEvent('message', { data: message })); return true; }
    }
  };
  const mock = {
    EventEmitter: class { event = () => {}; fire() {} dispose() {} }, ViewColumn: { Active: 1 }, ProgressLocation: { Window: 10 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    workspace: { getConfiguration: () => ({
      get: (key: string, fallback: unknown) => key === 'fontSize' ? fontSize : fallback,
      inspect: () => ({}),
      update: async (key: string, value: number, target: number) => { assert.equal(key, 'fontSize'); assert.equal(target, 1); fontSize = value; }
    }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    window: {
      registerTreeDataProvider: () => ({ dispose() {} }),
      createWebviewPanel: () => assert.fail('Reading must never open or replace an editor tab'),
      registerWebviewViewProvider: (id: string, value: any, options: any) => {
        assert.ok(['hnovaFish.reader', 'hnovaFish.readerBottom'].includes(id)); assert.equal(options.webviewOptions.retainContextWhenHidden, true);
        provider = value; return { dispose() {} };
      },
      withProgress: async (_: unknown, callback: () => Promise<unknown>) => callback(),
      showErrorMessage: async (m: string) => { errors.push(m); }, showWarningMessage: async (m: string) => { errors.push(m); }
    },
    commands: {
      registerCommand: (id: string, handler: (...args: any[]) => Promise<void>) => { commands.set(id, handler); return { dispose() {} }; },
      executeCommand: async (id: string) => {
        if (id === 'hnovaFish.reader.focus') { closed = false; if (!resolved) { resolved = true; provider.resolveWebviewView(panel); } return; }
        if (id === 'workbench.action.closeAuxiliaryBar') { closed = true; return; }
        await commands.get(id)?.();
      }
    },
    Uri: { parse: (url: string) => url }, env: { openExternal: async (url: string) => { external.push(url); return true; } }
  };
  Module._load = function(id: string, ...args: unknown[]) { return id === 'vscode' ? mock : originalLoad.call(this, id, ...args); };
  globalThis.fetch = (async (input: unknown) => {
    calls++; const url = new URL(String(input));
    if (url.hostname === 'tieba.baidu.com') {
      if (url.pathname === '/p/456') {
        recoveryReads++;
        return new Response(`<div class="l_post" data-field='{"content":{"comment_num":6${recoveryReads > 1 ? ',"post_id":"800"' : ''}}}'><div class="d_post_content">需要恢复的楼层</div></div>`);
      }
      if (url.pathname === '/p/totalComment' && url.searchParams.get('tid') === '456') return new Response(JSON.stringify({ data: { comment_list: { '800': { comment_num: 6, comment_info: [] } } } }));
      if (url.pathname === '/p/comment' && url.searchParams.get('tid') === '456') {
        assert.equal(url.searchParams.get('pid'), '800');
        return new Response('<li class="lzl_single_post" data-field=\'{"spid":"801"}\'><span class="lzl_content_main">恢复后的楼中楼</span></li>');
      }
      if (url.pathname === '/p/totalComment') return new Response(JSON.stringify({ errno: 0, data: { comment_list: { '900': { comment_num: 2, comment_info: [{ comment_id: '901', username: '吧友', content: '贴吧楼中楼 1' }] } } } }));
      if (url.pathname === '/p/comment') {
        assert.equal(url.searchParams.get('tid'), '123'); assert.equal(url.searchParams.get('pid'), '900');
        const page = url.searchParams.get('pn');
        return new Response(`<li class="lzl_single_post" data-field='{"spid":"${page === '2' ? '902' : '901'}"}'><div class="lzl_cnt"><a class="j_user_card">吧友</a><span class="lzl_content_main">贴吧楼中楼 ${page}</span></div></li>${page === '1' ? '<div class="lzl_pager"><a href="#2">下一页</a></div>' : ''}`);
      }
      return new Response('<div class="l_post" data-field=\'{"content":{"post_id":"900"}}\'><div class="d_post_content">贴吧正文</div></div>');
    }
    if (url.pathname.includes('/child_comment')) return new Response(JSON.stringify({ data: (url.searchParams.get('offset') === 'next' ? ['202', '203'] : ['201', '202']).map(id => ({ id, content: '<p>楼中楼回复</p>', author: { name: '回复作者' }, reply_to_author: { name: '评论作者' } })), paging: { is_end: url.searchParams.get('offset') === 'next', next: '/api/v4/comment_v5/comment/101/child_comment?offset=next' } }));
    if (url.pathname.includes('/root_comment')) return new Response(JSON.stringify({ data: [{ id: url.searchParams.get('offset') === 'next' ? '102' : '101', content: '<p>测试评论</p>', author: { name: '评论作者' }, child_comment_count: 3, child_comments: [{ id: '201', content: '<p>楼中楼回复</p>', author: { name: '回复作者' } }] }], paging: { is_end: url.searchParams.get('offset') === 'next', next: '/api/v4/comment_v5/answers/99/root_comment?offset=next' } }));
    const item = (id: string) => ({ id, content: `<p>回答 ${id}</p>`, author: { name: `作者 ${id}` }, question: { id: '12', title: '问题', answer_count: 3 } });
    return new Response(JSON.stringify(url.pathname.includes('/questions/')
      ? { data: url.searchParams.get('offset') === '10' ? [item('3')] : [item('1'), item('2')], paging: { is_end: url.searchParams.get('offset') === '10', next: '/api/v4/questions/12/answers?offset=10' } }
      : item('99')));
  }) as typeof fetch;
  const click = async (action: string) => {
    const button = dom!.window.document.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`);
    assert.ok(button, `${action} exists`); button.click();
    while (pending.length) await pending.shift();
    assert.deepEqual(errors, []);
  };
  try {
    const { activate } = require('../extension');
    activate({ subscriptions, secrets: { get: async () => 'session=test' }, globalState: { get: (key: string, fallback: unknown) => state.get(key) ?? fallback, update: async (key: string, value: unknown) => { state.set(key, value); } } });
    await commands.get('hnovaFish.focusReader')!();
    assert.match(dom!.window.document.body.textContent!, /选择知乎推荐/);
    assert.equal(calls, 0, 'Opening an empty reading sidebar does not fetch content');
    await commands.get('hnovaFish.read')!(answer);
    assert.equal(calls, 1);
    await click('save'); assert.equal(state.get('saved').length, 1); assert.equal(dom!.window.document.querySelector('button[data-action="save"]')!.textContent, '取消收藏');
    await click('save'); assert.equal(state.get('saved').length, 0);
    await click('refresh'); assert.equal(calls, 2);
    await click('original'); assert.equal(external[0], answer.url);
    await click('comments'); assert.equal(calls, 3); assert.equal(dom!.window.document.querySelectorAll('.comments>details>.comment').length, 1);
    await click('replies'); assert.equal(calls, 4); assert.equal(dom!.window.document.querySelectorAll('.comment .comment').length, 2);
    await click('repliesMore'); assert.equal(calls, 5); assert.equal(dom!.window.document.querySelectorAll('.comment .comment').length, 3);
    await click('fontUp'); assert.equal(fontSize, 16); assert.equal(dom!.window.document.querySelector('button[data-action="fontReset"]')!.textContent, '16px');
    assert.equal(dom!.window.document.querySelectorAll('.comment .comment').length, 3, 'Changing font preserves loaded replies');
    for (let i = 0; i < 12; i++) await click('fontUp'); assert.equal(fontSize, 24);
    await click('fontReset'); assert.equal(fontSize, 15);
    for (let i = 0; i < 6; i++) await click('fontDown'); assert.equal(fontSize, 12);
    await click('fontReset'); assert.equal(fontSize, 15); assert.equal(calls, 5, 'Font controls do not reload platform data');
    await click('commentsMore'); assert.equal(calls, 6); assert.equal(dom!.window.document.querySelectorAll('.comments>details>.comment').length, 2);
    assert.equal(dom!.window.document.querySelectorAll('.comment .comment').length, 4, 'Loading more root comments preserves previously loaded replies');
    await click('question'); assert.equal(calls, 7); assert.equal(dom!.window.document.querySelectorAll('.answer-card').length, 2);
    await click('next'); assert.equal(calls, 8); assert.equal(dom!.window.document.querySelectorAll('.answer-card').length, 3);
    const previousDom = dom;
    await click('hide'); assert.equal(closed, true);
    await commands.get('hnovaFish.focusReader')!();
    assert.equal(closed, false); assert.equal(dom, previousDom, 'Hiding the sidebar retains the reader DOM');
    await commands.get('hnovaFish.read')!(parseLink('https://tieba.baidu.com/p/123'));
    assert.match(dom!.window.document.body.textContent!, /贴吧正文/, 'Show the body before optional previews');
    const previewDeadline = Date.now() + 3000;
    while (!dom!.window.document.body.textContent!.includes('贴吧楼中楼 1') && Date.now() < previewDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(dom!.window.document.querySelector('button[data-action="comments"]')!.textContent, '展开剩余 1 条回复');
    assert.match(dom!.window.document.body.textContent!, /贴吧楼中楼 1/);
    await click('comments');
    assert.match(dom!.window.document.body.textContent!, /贴吧楼中楼 1/);
    await click('commentsMore');
    assert.equal(dom!.window.document.querySelectorAll('.tieba-replies>.comment').length, 2);
    assert.match(dom!.window.document.body.textContent!, /贴吧楼中楼 2/);
    assert.equal(dom!.window.document.querySelector('button[data-action="commentsMore"]'), null, 'No more button after the final reply');
    await commands.get('hnovaFish.read')!(parseLink('https://tieba.baidu.com/p/456'));
    assert.match(dom!.window.document.body.textContent!, /重新识别并展开 6 条回复/);
    await click('recoverReplies');
    assert.match(dom!.window.document.body.textContent!, /恢复后的楼中楼/);
  } finally {
    subscriptions.forEach(item => item.dispose()); dom?.window.close();
    Module._load = originalLoad; globalThis.fetch = originalFetch;
  }
});

test('switching articles explicitly resets inherited scroll, while the same article retains its position', () => {
  for (const [previousUrl, expected] of [[answer.url, 1800], ['https://tieba.baidu.com/p/123', 0], [undefined, 0]] as const) {
    const html = renderArticle(answer, { images: false, fontSize: 15, saved: false });
    const dom = new JSDOM(html, { runScripts: 'outside-only' });
    const positions: number[] = [], frames: FrameRequestCallback[] = [];
    let state = { url: previousUrl, scroll: 1800 };
    dom.window.scrollTo = ((options: ScrollToOptions) => { positions.push(options.top || 0); }) as typeof dom.window.scrollTo;
    dom.window.requestAnimationFrame = callback => { frames.push(callback); return 0; };
    (dom.window as any).acquireVsCodeApi = () => ({ getState: () => state, setState: (value: typeof state) => { state = value; }, postMessage: () => {} });
    try {
      dom.window.eval(dom.window.document.querySelector('script')!.textContent!);
      while (frames.length) frames.shift()!(0);
      dom.window.dispatchEvent(new dom.window.Event('load'));
      while (frames.length) frames.shift()!(0);
      assert.ok(positions.length >= 3);
      assert.ok(positions.every(value => value === expected));
      assert.equal(state.url, answer.url);
      assert.equal(state.scroll, expected);
      dom.window.dispatchEvent(new dom.window.Event('pointerdown'));
      const count = positions.length;
      dom.window.dispatchEvent(new dom.window.Event('load'));
      while (frames.length) frames.shift()!(0);
      assert.equal(positions.length, count, 'Late load must not override user navigation');
    } finally { dom.window.close(); }
  }
});
