import * as vscode from 'vscode';
import { Article, Entry, Site, mergeSections, parseLink } from './model';
import { Providers } from './providers';
import { renderArticle, renderEmptyReader } from './render';
import { CommentView, commentTarget, loadComments, loadReplies } from './comments';
import { forumName } from './forums';
import { tiebaCommentTarget, loadTiebaComments, loadTiebaPreviews } from './tiebaComments';

type Node = { kind: 'group'; title: string; source: 'tieba' | 'tiebaHome' | 'zhihu' | 'recommend' | 'saved' | 'history'; forum?: string }
  | { kind: 'entry'; entry: Entry; source?: string }
  | { kind: 'more'; group: Extract<Node, {kind: 'group'}> }
  | { kind: 'error'; message: string; url: string }
  | { kind: 'notice'; message: string }
  | { kind: 'action'; title: string; command: string; forum?: string };

export function activate(context: vscode.ExtensionContext): void {
  const providers = new Providers(async site => context.secrets.get(`cookie.${site}`), (...args) => fetch(...args), () => vscode.workspace.getConfiguration('hnovaFish').get<string>('tiebaUserAgent'));
  const changes = new vscode.EventEmitter<void>();
  context.subscriptions.push(changes);
  const entries = (key: string) => context.globalState.get<Entry[]>(key, []);
  const lists = new Map<string, Entry[]>();
  const recommendationNext = new Map<string, string>();
  const loadingLists = new Set<string>();
  let listGeneration = 0;
  let browsingForum: string | undefined;
  let navigation: { key: string; items: Entry[]; selectedId: string } | undefined;
  let navigating = false;
  let navigationRun = 0;
  function resetLists() { listGeneration++; lists.clear(); recommendationNext.clear(); changes.fire(); }
  const config = () => vscode.workspace.getConfiguration('hnovaFish');
  const groupKey = (node: Extract<Node, {kind: 'group'}>) => `${node.source}:${node.forum || ''}`;
  const tree: vscode.TreeDataProvider<Node> = {
    onDidChangeTreeData: changes.event,
    getTreeItem(node) {
      if (node.kind === 'group') {
        const item = new vscode.TreeItem(node.title, node.source === 'tieba' && node.forum === browsingForum ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
        item.iconPath = new vscode.ThemeIcon(node.source === 'saved' ? 'star-full' : node.source === 'history' ? 'history' : 'list-unordered');
        return item;
      }
      if (node.kind === 'more') {
        const recommended = node.group.source === 'recommend' || node.group.source === 'tiebaHome';
        const label = recommended ? '刷新推荐 · 换一批' : node.group.source === 'zhihu' ? '刷新热榜' : '刷新帖子列表';
        const item = new vscode.TreeItem(label); item.iconPath = new vscode.ThemeIcon('refresh'); item.command = { command: 'hnovaFish.more', title: label, arguments: [node.group] }; return item;
      }
      if (node.kind === 'action') {
        const item = new vscode.TreeItem(node.title); item.iconPath = new vscode.ThemeIcon(node.command === 'browseForum' ? 'search' : 'star');
        item.command = { command: `hnovaFish.${node.command}`, title: node.title, arguments: node.forum ? [node.forum] : [] }; return item;
      }
      if (node.kind === 'notice') return new vscode.TreeItem(node.message);
      if (node.kind === 'error') {
        const item = new vscode.TreeItem('加载失败 · 点击查看原因');
        item.tooltip = node.message; item.description = node.message.match(/HTTP \d+/)?.[0];
        item.iconPath = new vscode.ThemeIcon('warning');
        item.command = { command: 'hnovaFish.loadError', title: '查看失败原因', arguments: [node.message, node.url] }; return item;
      }
      const item = new vscode.TreeItem(node.entry.title);
      item.description = node.entry.description;
      item.tooltip = `${node.entry.title}\n${node.entry.summary || node.entry.url}`;
      item.iconPath = new vscode.ThemeIcon('file-text');
      item.command = { command: 'hnovaFish.read', title: '阅读', arguments: [node.entry, false, undefined, node.source] }; return item;
    },
    async getChildren(node): Promise<Node[]> {
      if (!node) return [
        { kind: 'group', title: '知乎 · 个性化推荐', source: 'recommend' },
        { kind: 'group', title: '知乎 · 热榜', source: 'zhihu' },
        { kind: 'group', title: '贴吧 · 首页推荐', source: 'tiebaHome' },
        { kind: 'action', title: '浏览其他贴吧…', command: 'browseForum' },
        ...(browsingForum && !config().get<string[]>('forums', []).includes(browsingForum) ? [{ kind: 'group' as const, title: `临时浏览 · ${browsingForum}吧`, source: 'tieba' as const, forum: browsingForum }] : []),
        ...config().get<string[]>('forums', ['图拉丁']).map(forum => ({ kind: 'group' as const, title: `${forum}吧`, source: 'tieba' as const, forum })),
        { kind: 'group', title: '本机收藏', source: 'saved' }, { kind: 'group', title: '阅读历史', source: 'history' }
      ];
      if (node.kind !== 'group') return [];
      if (node.source === 'saved' || node.source === 'history') return entries(node.source).map(entry => ({ kind: 'entry', entry, source: groupKey(node) }));
      const key = groupKey(node);
      try {
        const ticket = listGeneration;
        if (!lists.has(key)) {
          if (node.source === 'recommend' || node.source === 'tiebaHome') {
            const page = await (node.source === 'recommend' ? providers.recommendations() : providers.tiebaHome());
            if (ticket !== listGeneration) return [];
            lists.set(key, page.entries);
            if (page.nextUrl) recommendationNext.set(key, page.nextUrl);
          } else {
            const result = await providers.list(node.source, node.forum);
            if (ticket !== listGeneration) return [];
            lists.set(key, result);
          }
        }
        const children: Node[] = lists.get(key)!.map(entry => ({ kind: 'entry', entry, source: key }));
        if (!children.length && (node.source === 'recommend' || node.source === 'tiebaHome')) children.push({ kind: 'notice', message: '本批没有可读推荐（视频、广告等已略过）' });
        if (node.source === 'tieba' && node.forum && node.forum === browsingForum && !config().get<string[]>('forums', []).includes(node.forum)) {
          children.push({ kind: 'action', title: '收藏这个贴吧', command: 'pinForum', forum: node.forum });
          children.push({ kind: 'action', title: '关闭临时浏览', command: 'closeBrowseForum' });
        }
        children.push({ kind: 'more', group: node });
        return children;
      } catch (error) {
        return [{ kind: 'error', message: errorMessage(error), url: node.source === 'tiebaHome' ? 'https://tieba.baidu.com/' : node.source === 'recommend' ? 'https://www.zhihu.com/' : node.source === 'zhihu' ? 'https://www.zhihu.com/hot' : `https://tieba.baidu.com/f?kw=${encodeURIComponent(node.forum || '')}` }];
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
  let fontChange: Promise<void> = Promise.resolve();
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
    else reader.show(false);
    draw();
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('hnovaFish.reader', {
    resolveWebviewView(view) {
      reader = view;
      view.webview.options = { enableScripts: true, localResourceRoots: [] };
      view.onDidDispose(() => { if (reader === view) { reader = undefined; generation++; void vscode.commands.executeCommand('setContext', 'hnovaFish.readerFocused', false); } }, null, context.subscriptions);
      view.onDidChangeVisibility?.(() => { if (!view.visible) void vscode.commands.executeCommand('setContext', 'hnovaFish.readerFocused', false); }, null, context.subscriptions);
      view.webview.onDidReceiveMessage(async (message: unknown) => {
        if (!message || typeof message !== 'object') return;
        if ('action' in message && message.action === 'readerFocus' && 'focused' in message && typeof message.focused === 'boolean') {
          await vscode.commands.executeCommand('setContext', 'hnovaFish.readerFocused', message.focused); return;
        }
        if (!current) return;
        const { action, url, section, comment } = message as { action?: string; url?: string; section?: number; comment?: string };
        try {
          if (action === 'fontDown' || action === 'fontUp' || action === 'fontReset') {
            fontChange = fontChange.catch(() => {}).then(async () => {
              const settings = config();
              const value = action === 'fontReset' ? 15 : Math.max(12, Math.min(24, settings.get<number>('fontSize', 15) + (action === 'fontUp' ? 1 : -1)));
              const scope = settings.inspect<number>('fontSize');
              const target = scope?.workspaceFolderValue !== undefined ? vscode.ConfigurationTarget.WorkspaceFolder : scope?.workspaceValue !== undefined ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
              await settings.update('fontSize', value, target); draw();
            });
            await fontChange; return;
          }
          if ((action === 'replies' || action === 'repliesMore') && typeof section === 'number' && typeof comment === 'string') { await readReplies(section, comment, action === 'repliesMore'); return; }
          if ((action === 'comments' || action === 'commentsMore') && typeof section === 'number') { await readComments(section, action === 'commentsMore'); return; }
          if (action === 'recoverReplies' && typeof section === 'number') { await recoverReplies(section); return; }
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
  async function recoverReplies(index: number) {
    const article = current, floor = article?.sections[index];
    if (!article || article.site !== 'tieba' || !floor) return;
    const ticket = generation + 1;
    await read(article, true);
    if (generation !== ticket || current?.id !== article.id) return;
    const matches = current.sections.map((section, i) => ({ section, i })).filter(({ section }) =>
      floor.id && section.id === floor.id || section.html === floor.html && section.author === floor.author);
    if (matches.length === 1 && tiebaCommentTarget(current, matches[0].i)) { await readComments(matches[0].i, false); return; }
    const choice = await vscode.window.showWarningMessage('贴吧返回了回复条数，但没有可用的楼层 ID，暂时无法准确定位这些楼中楼。请查看原文。', '查看原文');
    if (choice === '查看原文') await external(article.url);
  }
  async function readComments(index: number, more: boolean) {
    const article = current;
    if (!article) return;
    const target = commentTarget(article, index), tiebaTarget = tiebaCommentTarget(article, index), key = String(index), previous = commentViews[key];
    if ((!target && !tiebaTarget) || previous?.loading || (more && !previous?.nextUrl)) return;
    const ticket = generation;
    const initial = { items: article.sections[index].tiebaReplyPreview || [], total: article.sections[index].tiebaReplyCount };
    commentViews[key] = { ...(previous || initial), loading: true, error: undefined }; draw();
    try {
      const page = tiebaTarget
        ? await loadTiebaComments(tiebaTarget, await context.secrets.get('cookie.tieba'), more ? previous?.nextUrl : undefined, (...args) => fetch(...args), config().get<string>('tiebaUserAgent'))
        : await loadComments(target!, await context.secrets.get('cookie.zhihu'), more ? previous?.nextUrl : undefined);
      if (ticket !== generation || current !== article) return;
      const items = more ? [...new Map([...(previous?.items || []), ...page.items].map(item => [item.id, item])).values()] : page.items;
      commentViews[key] = { ...page, items, total: page.total ?? previous?.total ?? initial.total, replies: more ? previous?.replies : undefined };
    } catch (error) {
      if (ticket !== generation || current !== article) return;
      commentViews[key] = { ...(previous || initial), loading: false, error: `评论加载失败：${errorMessage(error)}` };
    } finally {
      if (ticket === generation && current === article) draw();
    }
  }
  async function readReplies(index: number, id: string, more: boolean) {
    const article = current, parent = commentViews[String(index)];
    const root = parent?.items.find(item => item.id === id);
    if (!article || !commentTarget(article, index) || !root || !/^\d+$/.test(id) || parent.loading) return;
    const views = parent.replies ||= {}, previous = views[id];
    if (previous?.loading || (more && !previous?.nextUrl)) return;
    const ticket = generation;
    views[id] = { ...(previous || { items: root.children }), loading: true, error: undefined }; draw();
    try {
      const page = await loadReplies(id, await context.secrets.get('cookie.zhihu'), more ? previous?.nextUrl : undefined);
      if (ticket !== generation || current !== article || commentViews[String(index)]?.replies !== views) return;
      const items = [...new Map([...(more ? previous?.items || [] : root.children), ...page.items].map(item => [item.id, item])).values()];
      views[id] = { ...page, items, total: page.total ?? previous?.total };
    } catch (error) {
      if (ticket !== generation || current !== article || commentViews[String(index)]?.replies !== views) return;
      views[id] = { ...(previous || { items: root.children }), loading: false, error: `回复加载失败：${errorMessage(error)}` };
    } finally {
      if (ticket === generation && current === article && commentViews[String(index)]?.replies === views) draw();
    }
  }
  async function read(entry: Entry, fresh = false, nextUrl?: string, source?: string) {
    if (nextUrl && loadingNext) return;
    // Validate command arguments as well as manually entered links.
    const validated = parseLink(entry.url);
    entry = { ...validated, title: entry.title };
    const ticket = ++generation;
    for (const view of Object.values(commentViews)) { view.loading = false; for (const replies of Object.values(view.replies || {})) replies.loading = false; }
    const previous = current;
    const selectNavigation = () => {
      if (source) {
        // Keep history order stable even though reading moves an item to the top.
        const items = navigating && source === navigation?.key && (source === 'history:' || source === 'saved:') ? navigation.items
          : source === 'history:' ? entries('history') : source === 'saved:' ? entries('saved') : lists.get(source);
        navigation = items?.some(item => item.id === entry.id) ? { key: source, items: [...items], selectedId: entry.id } : undefined;
      } else if (!fresh && !nextUrl) {
        const sameQuestion = previous?.questionUrl === entry.url || previous?.url.match(/^https:\/\/www\.zhihu\.com\/question\/\d+/)?.[0] === entry.url;
        if (!sameQuestion) navigation = undefined;
      }
    };
    const stored = context.globalState.get<Article[]>('articles', []).find(a => a.id === entry.id);
    const legacyQuestionCache = entry.site === 'zhihu' && /^\/question\/\d+\/?$/.test(new URL(entry.url).pathname) && !stored?.kind;
    const legacyTiebaCache = entry.site === 'tieba' && stored && stored.tiebaPreviewVersion !== 2;
    if (stored && !fresh && !legacyQuestionCache && !legacyTiebaCache) { selectNavigation(); await show(stored, true); await record(stored); return; }
    if (nextUrl) loadingNext = true;
    try {
      const article = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '随手读：正在加载正文…' }, async () => {
        const result = await providers.article(entry, nextUrl);
        if (result.site === 'tieba') await loadTiebaPreviews(result, await context.secrets.get('cookie.tieba'), nextUrl, (...args) => fetch(...args), config().get<string>('tiebaUserAgent'));
        return result;
      });
      if (disposed || ticket !== generation) return;
      if (!nextUrl) commentViews = {};
      if (nextUrl && previous?.id === article.id) {
        article.sections = article.site === 'zhihu' ? mergeSections(previous.sections, article.sections) : [...previous.sections, ...article.sections];
        article.totalAnswers ??= previous.totalAnswers;
      }
      selectNavigation(); await show(article, false); await cache(article); await record(article);
    } catch (error) {
      if (disposed || ticket !== generation) return;
      if (stored && !nextUrl) { selectNavigation(); await show(stored, true); await record(stored); }
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
  async function navigate(direction: number) {
    if (navigating || !navigation || !current) return;
    const items = lists.get(navigation.key) || navigation.items;
    const index = items.findIndex(item => item.id === navigation!.selectedId);
    const entry = index < 0 ? undefined : items[index + direction];
    if (!entry) return;
    navigating = true;
    const ticket = ++navigationRun;
    try { await read(entry, false, undefined, navigation.key); }
    finally { if (ticket === navigationRun) navigating = false; }
  }
  command('previousArticle', () => navigate(-1));
  command('nextArticle', () => navigate(1));
  command('bossKey', async () => {
    // Cancel pending reads so a late response cannot reopen the reader.
    generation++;
    navigationRun++; navigating = false;
    for (const view of Object.values(commentViews)) {
      view.loading = false;
      for (const replies of Object.values(view.replies || {})) replies.loading = false;
    }
    draw();
    await vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar');
    await vscode.commands.executeCommand('workbench.action.closeSidebar');
    await vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
  });
  command('configureShortcuts', () => vscode.commands.executeCommand('workbench.action.openGlobalKeybindings', '@ext:hnova.hnova-fish'));
  command('external', external);
  command('loadError', async (message: string, url: string) => {
    const choice = await vscode.window.showWarningMessage(message, '打开原站', '设置 Cookie');
    if (choice === '打开原站') await external(url);
    if (choice === '设置 Cookie') await vscode.commands.executeCommand('hnovaFish.cookie', new URL(url).hostname === 'tieba.baidu.com' ? 'tieba' : 'zhihu');
  });
  command('refresh', resetLists);
  command('hide', () => vscode.commands.executeCommand('workbench.action.closeAuxiliaryBar'));
  command('focusReader', () => vscode.commands.executeCommand('hnovaFish.reader.focus'));
  command('reloadReader', async () => { if (current) await read(current, true); });
  command('more', async (group: Extract<Node, {kind: 'group'}>) => {
    if (group.source === 'recommend' || group.source === 'tiebaHome') {
      const key = groupKey(group), next = recommendationNext.get(key), ticket = listGeneration;
      if (loadingLists.has(key)) return;
      loadingLists.add(key);
      try {
        const page = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: '随手读：刷新推荐…' }, () => group.source === 'recommend' ? providers.recommendations(next) : providers.tiebaHome(next));
        if (ticket !== listGeneration) return;
        lists.set(key, page.entries);
        if (page.nextUrl) recommendationNext.set(key, page.nextUrl);
        else recommendationNext.delete(key);
        changes.fire();
      } finally { loadingLists.delete(key); }
      return;
    }
    if (group.source !== 'tieba' && group.source !== 'zhihu') return;
    const key = groupKey(group), ticket = listGeneration;
    if (loadingLists.has(key)) return;
    loadingLists.add(key);
    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Window, title: group.source === 'zhihu' ? '随手读：刷新热榜…' : '随手读：刷新帖子列表…' }, () => providers.list(group.source as 'tieba' | 'zhihu', group.forum));
      if (ticket !== listGeneration) return;
      lists.set(key, result); changes.fire();
    } finally { loadingLists.delete(key); }
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
  command('browseForum', async () => {
    const input = await vscode.window.showInputBox({ title: '浏览其他贴吧', prompt: '输入准确吧名（例如：电影）或贴吧列表链接，下一步选择临时浏览或永久加入侧边栏。', validateInput: value => { try { forumName(value); return undefined; } catch (error) { return errorMessage(error); } } });
    if (!input) return;
    const name = forumName(input);
    const mode = await vscode.window.showQuickPick([
      { label: '临时浏览', description: '仅当前窗口保留，可稍后收藏', mode: 'temporary' as const },
      { label: '永久加入侧边栏', description: '保存到常用贴吧，重启后仍然保留', mode: 'permanent' as const }
    ], { title: `${name} · 选择浏览方式`, placeHolder: '选择临时浏览或永久加入浏览目录', ignoreFocusOut: true });
    if (!mode) return;
    if (mode.mode === 'permanent') await pinForum(name);
    const previous = browsingForum;
    browsingForum = name;
    if (previous && previous !== browsingForum && !config().get<string[]>('forums', []).includes(previous)) { lists.delete(`tieba:${previous}`); }
    changes.fire();
  });
  async function pinForum(input: string) {
    const name = forumName(input), forums = config().get<string[]>('forums', []);
    if (!forums.includes(name)) await config().update('forums', [...forums, name], vscode.ConfigurationTarget.Global);
    changes.fire();
  }
  command('pinForum', pinForum);
  command('closeBrowseForum', () => { browsingForum = undefined; changes.fire(); });
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
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(e => {
    if (e.affectsConfiguration('hnovaFish.forums') || e.affectsConfiguration('hnovaFish.tiebaUserAgent')) resetLists();
    if (e.affectsConfiguration('hnovaFish')) draw();
  }));
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
