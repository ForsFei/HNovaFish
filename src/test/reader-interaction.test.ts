import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script } from 'node:vm';
import { JSDOM } from 'jsdom';
import { Article, parseLink } from '../model';
import { renderArticle } from '../render';

const answer: Article = { ...parseLink('https://www.zhihu.com/question/12/answer/99'), title: '问题', sections: [{ author: '作者', html: '<p>回答正文</p><a href="https://www.zhihu.com/question/34">链接</a>' }], fetchedAt: 1 };
function createReader(article: Article, postMessage: (message: any) => void) {
  const html = renderArticle(article, { images: false, fontSize: 15, saved: false });
  const dom = new JSDOM(html, { runScripts: 'outside-only', url: 'https://reader.test/' });
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
    for (const action of ['question', 'save', 'refresh', 'original', 'hide']) dom.window.document.querySelector<HTMLButtonElement>(`button[data-action="${action}"]`)!.click();
    assert.deepEqual(messages.map(m => m.action), ['question', 'save', 'refresh', 'original', 'hide']);
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
  const panel = {
    title: '', show(_preserveFocus?: boolean) { closed = false; },
    dispose() { closed = true; dom?.window.close(); onDispose?.(); },
    onDidDispose(callback: () => void) { onDispose = callback; return { dispose() {} }; },
    webview: {
      set html(html: string) {
        dom?.window.close(); dom = new JSDOM(html, { runScripts: 'outside-only' });
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
    workspace: { getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }), onDidChangeConfiguration: () => ({ dispose() {} }) },
    window: {
      registerTreeDataProvider: () => ({ dispose() {} }),
      createWebviewPanel: () => assert.fail('Reading must never open or replace an editor tab'),
      registerWebviewViewProvider: (id: string, value: any, options: any) => {
        assert.equal(id, 'hnovaFish.reader'); assert.equal(options.webviewOptions.retainContextWhenHidden, true);
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
    if (url.pathname.includes('/root_comment')) return new Response(JSON.stringify({ data: [{ id: url.searchParams.get('offset') === 'next' ? '102' : '101', content: '<p>测试评论</p>', author: { name: '评论作者' } }], paging: { is_end: url.searchParams.get('offset') === 'next', next: '/api/v4/comment_v5/answers/99/root_comment?offset=next' } }));
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
    await click('comments'); assert.equal(calls, 3); assert.equal(dom!.window.document.querySelectorAll('.comment').length, 1);
    await click('commentsMore'); assert.equal(calls, 4); assert.equal(dom!.window.document.querySelectorAll('.comment').length, 2);
    await click('question'); assert.equal(calls, 5); assert.equal(dom!.window.document.querySelectorAll('.answer-card').length, 2);
    await click('next'); assert.equal(calls, 6); assert.equal(dom!.window.document.querySelectorAll('.answer-card').length, 3);
    const previousDom = dom;
    await click('hide'); assert.equal(closed, true);
    await commands.get('hnovaFish.focusReader')!();
    assert.equal(closed, false); assert.equal(dom, previousDom, 'Hiding the sidebar retains the reader DOM');
  } finally {
    subscriptions.forEach(item => item.dispose()); dom?.window.close();
    Module._load = originalLoad; globalThis.fetch = originalFetch;
  }
});
