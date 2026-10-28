import * as vscode from 'vscode';
import { Article, Entry, Site, mergeSections, parseLink } from './model';
import { Providers } from './providers';
import { renderArticle, renderEmptyReader } from './render';
import { CommentView, commentTarget, loadComments } from './comments';

type Node = { kind: 'group'; title: string; source: 'tieba' | 'zhihu' | 'recommend' | 'saved' | 'history'; forum?: string }
  | { kind: 'entry'; entry: Entry }
  | { kind: 'more'; group: Extract<Node, {kind: 'group'}> }
  | { kind: 'error'; message: string; url: string }
  | { kind: 'notice'; message: string };

export function activate(context: vscode.ExtensionContext): void {
  const providers = new Providers(async site => context.secrets.get(`cookie.${site}`));
  const changes = new vscode.EventEmitter<void>();
  context.subscriptions.push(changes);
  const entries = (key: string) => context.globalState.get<Entry[]>(key, []);
  const lists = new Map<string, Entry[]>();
  const pages = new Map<string, number>();
  const recommendationNext = new Map<string, string>();
  const recommendationSeen = new Set<string>();
  const loadingLists = new Set<string>();
  let listGeneration = 0;
  function resetLists() { listGeneration++; lists.clear(); pages.clear(); recommendationNext.clear(); recommendationSeen.clear(); changes.fire(); }
  const config = () => vscode.workspace.getConfiguration('hnovaFish');
  const groupKey = (node: Extract<Node, {kind: 'group'}>) => `${node.source}:${node.forum || ''}`;
  const tree: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: changes.event,
    getTreeItem(node) {
      if (node.kind === 'group') {
        const item = new vscode.TreeItem(node.title, vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(node.source === 'saved' ? 'star-full' : node.source === 'history' ? 'history' : 'list-unordered');
        return item;
      }
      if (node.kind === 'more') {
        const item = new vscode.TreeItem(node.group.source === 'recommend' ? '加载更多推荐…' : '加载更多帖子…'); item.command = { command: 'hnovaFish.more', title: '加载更多', arguments: [node.group] }; return item;
      }
      if (node.kind === 'notice') return new vscode.TreeItem(node.message);
      if (node.kind === 'error') {
        const item = new vscode.TreeItem('加载失败 · 点击查看原站');
        item.tooltip = node.message; item.description = node.message;
        item.iconPath = new vscode.ThemeIcon('warning');
        item.command = { command: 'hnovaFish.external', title: '查看原站', arguments: [node.url] }; return item;
      }
      const item = new vscode.TreeItem(node.entry.title);
      item.description = node.entry.description;
      item.tooltip = `${node.entry.title}\n${node.entry.summary || node.entry.url}`;
      item.iconPath = new vscode.ThemeIcon('file-text');
      item.command = { command: 'hnovaFish.read', title: '阅读', arguments: [node.entry] }; return item;
    },
    async getChildren(node): Promise<Node[]> {
      if (!node) return [
        { kind: 'group', title: '知乎 · 个性化推荐', source: 'recommend' },
        { kind: 'group', title: '知乎 · 热榜', source: 'zhihu' },
        ...config().get<string[]>('forums', ['图拉丁']).map(forum => ({ kind: 'group' as const, title: `${forum}吧`, source: 'tieba' as const, forum })),
        { kind: 'group', title: '本机收藏', source: 'saved' }, { kind: 'group', title: '阅读历史', source: 'history' }
      ];
      if (node.kind !== 'group') return [];
      if (node.source === 'saved' || node.source === 'history') return entries(node.source).map(entry => ({ kind: 'entry', entry }));
      const key = groupKey(node);
      try {
        const ticket = listGeneration;
        if (!lists.has(key)) {
          if (node.source === 'recommend') {
            const page = await providers.recommendations();
            if (ticket !== listGeneration) return [];
            lists.set(key, page.entries);
            if (page.nextUrl) recommendationNext.set(key, page.nextUrl);
          } else {
            const result = await providers.list(node.source, node.forum);
            if (ticket !== listGeneration) return [];
            lists.set(key, result);
          }
        }
        const children: Node[] = lists.get(key)!.map(entry => ({ kind: 'entry', entry }));
        if (!children.length && node.source === 'recommend') children.push({ kind: 'notice', message: '本批没有可读推荐（视频、广告等已略过）' });
        if (node.source === 'tieba' || (node.source === 'recommend' && recommendationNext.has(key))) children.push({ kind: 'more', group: node });
        return children;
      } catch (error) {
        return [{ kind: 'error', message: errorMessage(error), url: node.source === 'recommend' ? 'https://www.zhihu.com/' : node.source === 'zhihu' ? 'https://www.zhihu.com/hot' : `https://tieba.baidu.com/f?kw=${encodeURIComponent(node.forum || '')}` }];
      }
    }
  };
  context.subscriptions.push(vscode.window.registerTreeDataProvider('hnovaFish.feed', tree));
  let reader: vscode.WebviewView | undefined;
  let current: Article | undefined;
  let cached = false;
  let generation = 0;
  let loadingNext = false;
  let commentViews: Record<string, CommentView> = {};
  let disposed = false;
  context.subscriptions.push({ dispose() { disposed = true; generation++; } });
  const draw = () => {
    if (!reader) return;
    reader.title = current?.title || '阅读';
    reader.webview.html = current ? renderArticle(current, { images: config().get('showImages', false), fontSize: config().get('fontSize', 15), saved: entries('saved').some(e => e.id === current!.id), cached, comments: commentViews }) : renderEmptyReader();
  };
  async function cache(article: Article) {
    // Keep a bounded local cache. Cookies are never stored here.
    const existing = context.globalState.get<Article[]>('articles', []).filter(a => a.id !== article.id);
    const next = [article, ...existing].slice(0, 30);
    while (JSON.stringify(next).length > 6 * 1024 * 1024 && next.length) next.pop();
    await context.globalState.update('articles', next);
  }
  async function record(article: Article) {
    const entry: Entry = { id: article.id, site: article.site, title: article.title, url: article.url };
    await context.globalState.update('history', [entry, ...entries('history').filter(e => e.id !== entry.id)].slice(0, 100));
    changes.fire();
  }
  async function show(article: Article, fromCache: boolean) {
    if (current?.id !== article.id) commentViews = {};
    current = article; cached = fromCache;
    if (!reader) await vscode.commands.executeCommand('hnovaFish.reader.focus');
    else reader.show(true);
    draw();
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('hnovaFish.reader', {
    resolveWebviewView(view) {
      reader = view;
      view.webview.options = { enableScripts: true, localResourceRoots: [] };
      view.onDidDispose(() => { if (reader === view) { reader = undefined; generation++; } }, null, context.subscriptions);
      view.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!current || !message || typeof message !== 'object') return;
        const { action, url, section } = message as { action?: string; url?: string; section?: number };
        try {
          if ((action === 'comments' || action === 'commentsMore') && typeof section === 'number') { await readComments(section, action === 'commentsMore'); return; }
          if (action === 'hide') { await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar'); return; }
          if (action === 'original') { await external(current.url); return; }
          if (action === 'link' && typeof url === 'string') { await external(url); return; }
          if (action === 'save') {
            const previous = entries('saved'), article = current;
            const item: Entry = { id: article.id, site: article.site, title: article.title, url: article.url };
            await context.globalState.update('saved', previous.some(e => e.id === item.id) ? previous.filter(e => e.id !== item.id) : [item, ...previous].slice(0, 200));
            changes.fire(); draw(); return;
          }
          if (action === 'refresh') await read(current, true);
          if (action === 'question') {
            const questionUrl = current.questionUrl || current.url.match(/^https:\/\/www\.zhihu\.com\/question\/\d+/)?.[0];
            if (questionUrl) await read({ ...parseLink(questionUrl), title: current.title });
          }
          if (action === 'next' && current.nextUrl) await read(current, true, current.nextUrl);
        } catch (error) { void vscode.window.showErrorMessage(errorMessage(error)); }
      }, null, context.subscriptions);
      draw();
    }
  }, { webviewOptions: { retainContextWhenHidden: true } }));
  async function readComments(index: number, more: boolean) {
    const article = current;
    if (!article) return;
    const target = commentTarget(article, index), key = String(index), previous = commentViews[key];
    if (!target || previous?.loading || (more && !previous?.nextUrl)) return;
    const ticket = generation;
    commentViews[key] = { ...(previous || { items: [] }), loading: true, error: undefined }; draw();
    try {
      const page = await loadComments(target, await context.secrets.get('cookie.zhihu'), more ? previous?.nextUrl : undefined);
      if (ticket !== generation || current !== article) return;
      const items = more ? [...new Map([...(previous?.items || []), ...page.items].map(item => [item.id, item])).values()] : page.items;
      commentViews[key] = { ...page, items, total: page.total ?? previous?.total };
    } catch (error) {
      if (ticket !== generation || current !== article) return;
      commentViews[key] = { ...(previous || { items: [] }), loading: false, error: `评论加载失败：${errorMessage(error)}` };
    } finally {
      if (ticket === generation && current === article) draw();
    }
  }
  async function read(entry: Entry, fresh = false, nextUrl?: string) {
    if (nextUrl && loadingNext) return;
    // Validate command arguments as well as manually entered links.
    const validated = parseLink(entry.url);
    entry = { ...validated, title: entry.title };
    const ticket = ++generation;
    for (const view of Object.values(commentViews)) view.loading = false;
    const previous = current;
    const stored = context.globalState.get<Article[]>('articles', []).find(a => a.id === entry.id);
    const legacyQuestionCache = entry.site === 'zhihu' && /^\/question\/\d+\/?$/.test(new URL(entry.url).pathname) && !stored?.kind;
    if (stored && !fresh && !legacyQuestionCache) { await show(stored, true); await record(stored); return; }
    if (nextUrl) loadingNext = true;
    try {
      const article = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '随手读：正在加载正文…' }, () => providers.article(entry, nextUrl));
      if (disposed || ticket !== generation) return;
      if (!nextUrl) commentViews = {};
      if (nextUrl && previous?.id === article.id) {
        article.sections = article.site === 'zhihu' ? mergeSections(previous.sections, article.sections) : [...previous.sections, ...article.sections];
        article.totalAnswers ??= previous.totalAnswers;
      }
      await show(article, false); await cache(article); await record(article);
    } catch (error) {
      if (disposed || ticket !== generation) return;
      if (stored && !nextUrl) { await show(stored, true); await record(stored); }
      const choice = await vscode.window.showWarningMessage(errorMessage(error), '查看原文', '设置 Cookie');
      if (choice === '查看原文') await external(entry.url);
      if (choice === '设置 Cookie') await vscode.commands.executeCommand('hnovaFish.cookie', entry.site);
    } finally {
      if (nextUrl) { loadingNext = false; void reader?.webview.postMessage({ type: 'loadingDone' }); }
    }
  }
  const command = (name: string, handler: (...args: any[]) => any) => context.subscriptions.push(vscode.commands.registerCommand(`hnovaFish.${name}`, async (...args) => {
    try { await handler(...args); } catch (error) { void vscode.window.showErrorMessage(errorMessage(error)); }
  }));
  command('read', read);
  command('external', external);
  command('refresh', resetLists);
  command('hide', () => vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar'));
  command('focusReader', () => vscode.commands.executeCommand('hnovaFish.reader.focus'));
  command('reloadReader', async () => { if (current) await read(current, true); });
  command('more', async (group: Extract<Node, {kind: 'group'}>) => {
    if (group.source === 'recommend') {
      const key = groupKey(group), next = recommendationNext.get(key), ticket = listGeneration;
      if (!next || loadingLists.has(key)) return;
      loadingLists.add(key);
      try {
        const page = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '随手读：加载更多推荐…' }, () => providers.recommendations(next));
        if (ticket !== listGeneration) return;
        lists.set(key, [...new Map([...(lists.get(key) || []), ...page.entries].map(entry => [entry.id, entry])).values()]);
        recommendationSeen.add(next);
        if (page.nextUrl && !recommendationSeen.has(page.nextUrl)) recommendationNext.set(key, page.nextUrl);
        else recommendationNext.delete(key);
        changes.fire();
      } finally { loadingLists.delete(key); }
      return;
    }
    if (group.source !== 'tieba') return;
    const key = groupKey(group), page = (pages.get(key) || 0) + 1;
    const more = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '随手读：加载更多帖子…' }, () => providers.list('tieba', group.forum, page));
    lists.set(key, [...new Map([...(lists.get(key) || []), ...more].map(e => [e.id, e])).values()]);
    pages.set(key, page); changes.fire();
  });
  command('openUrl', async () => {
    const url = await vscode.window.showInputBox({ title: '阅读帖子链接', prompt: '贴吧帖子 / 知乎问题、回答、专栏文章', placeHolder: 'https://tieba.baidu.com/p/…', ignoreFocusOut: true,
      validateInput: value => { try { parseLink(value); return undefined; } catch (error) { return errorMessage(error); } } });
    if (url) await read(parseLink(url));
  });
  command('addForum', async () => {
    const name = await vscode.window.showInputBox({ title: '添加贴吧', prompt: '输入贴吧名称，例如：图拉丁', validateInput: v => !v.trim() || v.trim().length > 60 ? '请输入 1–60 个字符。' : undefined });
    if (!name?.trim()) return;
    const forums = config().get<string[]>('forums', []);
    if (!forums.includes(name.trim())) await config().update('forums', [...forums, name.trim()], vscode.ConfigurationTarget.Global);
  });
  command('cookie', async (site?: Site) => {
    if (site !== 'tieba' && site !== 'zhihu') site = (await vscode.window.showQuickPick([{ label: '贴吧', site: 'tieba' as Site }, { label: '知乎', site: 'zhihu' as Site }], { title: '选择登录平台' }))?.site;
    if (!site) return;
    const action = await vscode.window.showQuickPick(['设置 Cookie', '清除 Cookie'], { title: `${site === 'tieba' ? '贴吧' : '知乎'} · 本机登录状态` });
    if (action === '清除 Cookie') await context.secrets.delete(`cookie.${site}`);
    else if (action === '设置 Cookie') {
      const value = await vscode.window.showInputBox({ title: '设置本机 Cookie', password: true, ignoreFocusOut: true, prompt: '仅粘贴本人浏览器该平台请求的 Cookie 值，使用 VS Code SecretStorage 保存。不要包含 Cookie: 前缀。', validateInput: value => /[\r\n]/.test(value) || /^cookie:/i.test(value) ? '请仅输入单行 Cookie 值。' : !value.trim() ? 'Cookie 不能为空。' : undefined });
      if (value === undefined) return;
      await context.secrets.store(`cookie.${site}`, value.trim());
    } else return;
    resetLists(); void vscode.window.showInformationMessage('本机登录状态已更新。');
  });
  command('clearHistory', async () => {
    await context.globalState.update('history', []); await context.globalState.update('articles', []); changes.fire();
    void vscode.window.showInformationMessage('阅读历史和正文缓存已清空，收藏保留。');
  });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => { if (e.affectsConfiguration('hnovaFish')) { resetLists(); draw(); } }));
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && /timeout|fetch failed/i.test(error.message)) return '网络连接失败或超时，请检查网络后重试。';
  return error instanceof Error ? error.message : '加载失败，请重试。';
}

async function external(input: string): Promise<void> {
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.username || url.password) return;
  await vscode.env.openExternal(vscode.Uri.parse(url.href));
}
