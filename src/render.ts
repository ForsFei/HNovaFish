import * as cheerio from 'cheerio';
import { randomBytes } from 'node:crypto';
import { Article, Entry } from './model';
import { readerScript } from './readerScript';
import { CommentItem, CommentView, commentTarget } from './comments';
import { tiebaCommentTarget } from './tiebaComments';

export function escape(value: string): string { return value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!)); }
export function renderEmptyReader(): string {
  const nonce = randomBytes(24).toString('base64');
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'"><style nonce="${nonce}">body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-sideBar-background);padding:24px 16px;line-height:1.8}h2{font-size:18px;font-weight:500}p{color:var(--vscode-descriptionForeground);font-size:13px}</style></head><body><h2>随手读</h2><p>从左侧“随手读”列表选择知乎推荐、热榜或贴吧帖子，正文会显示在这里。</p><p>拖动侧栏分隔线可调整宽度。Ctrl+Alt+; 隐藏阅读侧栏。</p></body></html>`;
}
export function safeHtml(html: string, images: boolean): string {
  const $ = cheerio.load(html, {}, false);
  $('script,style,iframe,object,embed,form,input,button,svg,math,video,audio,link,meta,base,template').remove();
  const allowed = new Set(['p','br','div','span','strong','b','em','i','u','s','blockquote','pre','code','ul','ol','li','h1','h2','h3','h4','hr','a','img','table','thead','tbody','tr','td','th','figure','figcaption','sup','sub']);
  $('*').each((_, el) => {
    if (el.type !== 'tag') return;
    const node = $(el), tag = el.tagName;
    const href = node.attr('href'), src = node.attr('data-original') || node.attr('data-actualsrc') || node.attr('src');
    const alt = node.attr('alt') || '图片';
    for (const attr of Object.keys(el.attribs)) node.removeAttr(attr);
    if (!allowed.has(tag)) { node.replaceWith(node.contents()); return; }
    if (tag === 'a' && href) {
      try { const url = new URL(href, 'https://www.zhihu.com'); if (url.protocol === 'https:') node.attr('href', url.href); } catch { /* Omit unsafe links. */ }
    }
    if (tag === 'img') {
      if (!images) { node.replaceWith('<span class="image-placeholder">[图片已折叠]</span>'); return; }
      try {
        const url = new URL(src || '');
        if (url.protocol !== 'https:' || !/(^|\.)(zhimg\.com|baidu\.com|bdimg\.com|baidubcr\.com)$/.test(url.hostname)) throw new Error();
        node.attr('src', url.href).attr('alt', alt).attr('loading', 'lazy').attr('referrerpolicy', 'no-referrer');
      } catch { node.replaceWith('<span class="image-placeholder">[图片不可用]</span>'); }
    }
  });
  return $.html();
}

export function renderArticle(article: Article, options: { images: boolean; fontSize: number; saved: boolean; cached?: boolean; comments?: Record<string, CommentView>; bottom?: boolean; directory?: Entry[]; widths?: { directory: number; work: number }; problems?: { file: string; line: number; severity: string; message: string }[] }): string {
  const nonce = randomBytes(24).toString('base64');
  const directory = options.bottom ? `<aside class="post-directory" aria-label="帖子目录"><h2>帖子目录</h2>${(options.directory?.length ? options.directory : [article]).map((entry, i) => `<button data-action="selectPost" data-url="${escape(entry.url)}" title="${escape(entry.title)}" ${entry.id === article.id ? 'aria-current="page"' : ''}><span class="post-number">${i + 1}</span><span>${escape(entry.title)}</span></button>`).join('')}<button class="directory-refresh" data-action="refreshDirectory" title="刷新当前帖子列表">刷新帖子列表</button></aside>` : '';
  const directoryWidth = Math.max(120, Math.min(480, Number(options.widths?.directory) || 220));
  const workWidth = Math.max(180, Math.min(600, Number(options.widths?.work) || 300));
  const separator = (name: string, label: string) => `<div class="column-divider" data-resize="${name}" role="separator" aria-label="${label}" aria-orientation="vertical" tabindex="0"></div>`;
  const work = options.bottom ? `${separator('work', '调整工作栏宽度')}<aside class="work-pane" aria-label="工作区问题"><h2>问题 <span>${options.problems?.length || 0}</span></h2>${options.problems?.length ? options.problems.map(item => `<div class="work-problem"><div class="problem-file">${escape(item.file)}:${item.line} · ${escape(item.severity)}</div><p>${escape(item.message)}</p></div>`).join('') : '<p class="work-empty">当前工作区没有问题。</p>'}</aside>` : '';
  const fontSize = Math.max(12, Math.min(24, Number(options.fontSize) || 15));
  const question = article.site === 'zhihu' && /^\/question\/\d+\/?$/.test(new URL(article.url).pathname);
  const canOpenQuestion = article.site === 'zhihu' && !question && (article.questionUrl || /\/question\/\d+\/answer\//.test(article.url));
  const count = question ? `${article.totalAnswers === undefined ? '' : `共 ${article.totalAnswers} 个回答 · `}已加载 ${article.sections.length} 个回答` : `${article.sections.length} ${article.site === 'tieba' ? '条回复' : '篇正文'}`;
  const index = question ? `<details class="answer-index" open><summary>回答目录 · 点击跳转</summary><div>${article.sections.map((s, i) => `<a href="#answer-${i}">${i + 1}. ${escape(s.author)}${typeof s.votes === 'number' ? ` · ${s.votes} 赞同` : ''}</a>`).join('')}</div></details>` : '';
  const commentItem = (item: CommentItem, section: number, nested = false): string => {
    const view = nested ? undefined : options.comments?.[String(section)]?.replies?.[item.id];
    const children = view?.items || item.children;
    const attrs = `data-section="${section}" data-comment="${escape(item.id)}"`;
    const control = nested ? '' : view
      ? `${view.error ? `<p class="notice">${escape(view.error)}</p><button data-action="replies" ${attrs}>重试加载回复</button>` : ''}${view.loading ? '<p class="meta">正在加载回复…</p>' : view.nextUrl ? `<button data-action="repliesMore" ${attrs}>加载更多回复 →</button>` : view.error ? '' : '<p class="meta">已加载当前可见回复。</p>'}`
      : item.moreReplies || item.children.length ? `<button data-action="replies" ${attrs}>展开全部回复${item.moreReplies ? `（还有 ${item.moreReplies} 条）` : ''}</button>` : '';
    return `<div class="comment"><div class="author">${escape(item.author)}${item.replyTo ? ` 回复 ${escape(item.replyTo)}` : ''}${item.votes === undefined ? '' : ` · ${item.votes} 赞`}</div>${safeHtml(item.html, options.images)}${children.length || view ? `<details open><summary>回复 · 已加载 ${children.length} 条</summary>${children.map(child => commentItem(child, section, true)).join('')}${control}</details>` : control}</div>`;
  };
  const comments = (i: number): string => {
    const tieba = article.site === 'tieba';
    const view = options.comments?.[String(i)];
    if (tieba) {
      const section = article.sections[i];
      const items = view?.items ?? section.tiebaReplyPreview ?? [];
      const total = view?.total ?? section.tiebaReplyCount;
      if (!items.length && !view?.loading && !view?.error && (!total || view)) return '';
      const remaining = total === undefined ? undefined : Math.max(0, total - items.length);
      const canLoad = tiebaCommentTarget(article, i) && (!view ? (remaining === undefined || remaining > 0) : view.nextUrl);
      const recover = !tiebaCommentTarget(article, i) && remaining !== 0 && (total || items.length);
      const action = view?.nextUrl ? 'commentsMore' : 'comments';
      const button = view?.loading ? '<p class="meta">正在加载楼中楼…</p>' : recover ? `<button data-action="recoverReplies" data-section="${i}">重新识别并展开${remaining ? ` ${remaining} 条` : ''}回复</button>` : canLoad || view?.error
        ? `<button data-action="${view?.error ? 'comments' : action}" data-section="${i}">${view?.error ? '重试加载楼中楼' : remaining ? `展开剩余 ${remaining} 条回复` : '展开更多回复'}</button>` : '';
      return `<div class="comments tieba-replies"><div class="meta">${total === undefined ? '楼中楼' : `共 ${total} 条楼中楼回复`}</div>${items.map(item => commentItem(item, i, true)).join('')}${view?.error ? `<p class="notice">${escape(view.error)}</p>` : ''}${button}</div>`;
    }
    if (!commentTarget(article, i)) return '';
    const label = tieba ? '楼中楼' : '评论';
    return `<div class="comments"><button data-action="comments" data-section="${i}" ${view?.loading ? 'disabled' : ''}>${view ? '刷新' : '查看'}${label}</button>${view ? `<details open><summary>${label} · 已加载 ${view.items.length} 条${view.total === undefined ? '' : ` / 共 ${view.total} 条`}</summary>${view.error ? `<p class="notice">${escape(view.error)}</p>` : ''}${view.items.map(item => commentItem(item, i)).join('')}${view.loading ? `<p class="meta">正在加载${label}…</p>` : !view.items.length && !view.error ? `<p class="meta">暂无可见${label}。</p>` : ''}${view.nextUrl ? `<button data-action="commentsMore" data-section="${i}" ${view.loading ? 'disabled' : ''}>加载更多${label} →</button>` : ''}</details>` : ''}</div>`;
  };
  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src https://*.zhimg.com https://*.baidu.com https://*.bdimg.com https://*.baidubcr.com; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
  :root{color-scheme:light dark}*{box-sizing:border-box}body{margin:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);font-family:var(--vscode-editor-font-family);font-size:${fontSize}px;line-height:1.9}main{max-width:820px;margin:auto;padding:36px 40px 100px}nav{position:sticky;top:0;display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:12px 20px;border-bottom:1px solid var(--vscode-panel-border);background:var(--vscode-editor-background);z-index:1}button{background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground);border:1px solid var(--vscode-panel-border);border-radius:5px;padding:5px 11px;cursor:pointer;font:inherit;font-size:12px}button:hover{background:var(--vscode-button-secondaryHoverBackground)}button:focus-visible,a:focus-visible{outline:2px solid var(--vscode-focusBorder)}.label{margin-right:auto;font-size:11px;color:var(--vscode-descriptionForeground);letter-spacing:1px}h1{font-family:var(--vscode-font-family);font-size:25px;line-height:1.5;font-weight:600;margin:10px 0 15px}.meta,.author,.image-placeholder{color:var(--vscode-descriptionForeground);font-size:12px}.meta{margin-bottom:32px}.author{border-bottom:1px solid var(--vscode-panel-border);padding-bottom:8px;margin-bottom:18px}section{margin-top:30px;overflow-wrap:anywhere}img{max-width:100%;height:auto;border-radius:4px}a{color:var(--vscode-textLink-foreground)}blockquote{border-left:3px solid var(--vscode-textBlockQuote-border);margin:12px 0;padding:4px 16px;color:var(--vscode-descriptionForeground)}pre{white-space:pre-wrap;background:var(--vscode-textCodeBlock-background);padding:16px;overflow:auto}table{border-collapse:collapse;max-width:100%}td,th{border:1px solid var(--vscode-panel-border);padding:6px}.notice{background:var(--vscode-textBlockQuote-background);padding:10px 14px;border-left:3px solid var(--vscode-textLink-foreground);font-size:12px}p{margin:0 0 16px}@media(max-width:600px){main{padding:22px 18px}h1{font-size:21px}}
  .answer-index{border:1px solid var(--vscode-panel-border);padding:12px 16px;border-radius:6px;margin-bottom:28px;font-size:13px}.answer-index summary{cursor:pointer;color:var(--vscode-descriptionForeground)}.answer-index a{display:block;padding:5px 0;text-decoration:none}.answer-card{border-top:1px solid var(--vscode-panel-border);padding-top:22px;scroll-margin-top:90px}.answer-card>details>summary{cursor:pointer;font-size:13px;color:var(--vscode-descriptionForeground);padding-bottom:16px}.answer-body{padding-top:12px}.end-note{margin-top:24px}.load-more{display:block;margin:26px auto;padding:10px 28px}button:disabled{opacity:.6;cursor:wait}
  .comments{margin:24px 0;padding:16px 0;border-top:1px dashed var(--vscode-panel-border);font-size:1em}.comments>details{margin-top:16px}.comments summary{cursor:pointer;color:var(--vscode-descriptionForeground)}.comment{padding:14px 0;border-bottom:1px solid var(--vscode-panel-border)}.comment .author{border:0;padding:0;margin-bottom:6px}.comment .comment{margin-left:18px;padding-left:14px;border-left:2px solid var(--vscode-panel-border)}
  nav{max-width:820px;margin-inline:auto;padding-inline:40px}nav .label{letter-spacing:0}
  .reader-column{min-width:0}.reader-layout.split{display:grid;grid-template-columns:var(--directory-width,${directoryWidth}px) 6px minmax(220px,1fr) 6px var(--work-width,${workWidth}px);align-items:start}
  .post-directory{position:sticky;top:0;height:100vh;overflow-y:auto;overscroll-behavior:contain;border-right:1px solid var(--vscode-panel-border);background:var(--vscode-sideBar-background);padding:14px 8px;min-width:0}
  .post-directory h2{font-family:var(--vscode-font-family);font-size:12px;color:var(--vscode-descriptionForeground);font-weight:500;margin:0 10px 12px}
  .post-directory button{display:flex;gap:10px;width:100%;text-align:left;border:0;border-radius:3px;background:transparent;color:var(--vscode-foreground);padding:9px 10px;line-height:1.5;margin:2px 0;overflow-wrap:anywhere}
  .post-directory button>span:last-child{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}.post-number{color:var(--vscode-descriptionForeground);font-size:11px;flex-shrink:0}
  .post-directory button:hover{background:var(--vscode-list-hoverBackground)}.post-directory button[aria-current="page"]{background:var(--vscode-list-activeSelectionBackground);color:var(--vscode-list-activeSelectionForeground)}
  @media(max-width:600px){nav{padding-inline:18px}.reader-layout.split{min-width:700px}.split main{padding-inline:16px}.split nav{padding-inline:16px;gap:5px}.split nav button{padding:4px 7px}}
  .post-directory .directory-refresh{justify-content:center;margin-top:16px;border:1px solid var(--vscode-panel-border);background:var(--vscode-button-secondaryBackground);color:var(--vscode-button-secondaryForeground)}
  .column-divider{position:sticky;top:0;height:100vh;cursor:col-resize;background:var(--vscode-panel-border);touch-action:none}.column-divider:hover,.column-divider:focus-visible{background:var(--vscode-focusBorder);outline:none}.work-pane{position:sticky;top:0;height:100vh;overflow:auto;padding:14px 16px;background:var(--vscode-panel-background,var(--vscode-editor-background));font-family:var(--vscode-font-family);font-size:12px;min-width:0;overscroll-behavior:contain}.work-pane h2{margin:0 0 18px;font-size:12px;font-weight:500}.work-pane h2 span{color:var(--vscode-descriptionForeground)}.work-problem{padding:10px 0;border-bottom:1px solid var(--vscode-panel-border);overflow-wrap:anywhere}.problem-file,.work-empty{color:var(--vscode-descriptionForeground)}.work-problem p{margin:6px 0}
  </style></head><body data-page-url="${escape(article.url)}" data-next-label="${question ? '加载更多回答 →' : '下一页回复 →'}"><div class="reader-layout${options.bottom ? ' split' : ''}">${directory}${options.bottom ? separator('directory', '调整目录宽度') : ''}<div class="reader-column"><nav><span class="label">${article.site === 'tieba' ? 'TIEBA' : question ? 'ZHIHU / 问题回答' : 'ZHIHU'} / 随手读</span>${canOpenQuestion ? '<button data-action="question">查看问题的其他回答</button>' : ''}<button data-action="fontDown" title="减小字号" aria-label="减小字号" ${fontSize <= 12 ? 'disabled' : ''}>A−</button><button data-action="fontReset" title="恢复默认字号">${fontSize}px</button><button data-action="fontUp" title="增大字号" aria-label="增大字号" ${fontSize >= 24 ? 'disabled' : ''}>A+</button><button data-action="save">${options.saved ? '取消收藏' : '收藏'}</button><button data-action="refresh">重新加载</button><button data-action="original">查看原文 ↗</button><button data-action="hide">隐藏 · Ctrl+Alt+;</button></nav><main>
  ${options.cached ? '<p class="notice">当前显示本机缓存，正文可能不是最新内容。</p>' : ''}
  <h1>${escape(article.title)}</h1><div class="meta">${count} · 获取于 ${escape(new Date(article.fetchedAt).toLocaleString('zh-CN'))} · ${options.images ? '图片已开启' : '图片已折叠'}</div>
  ${question && article.source === 'html' ? '<p class="notice">回答接口暂不可用，当前显示网页返回的回答，可能只有一条。可尝试下方“加载更多回答”。</p>' : ''}
  ${index}
  ${article.sections.map((s, i) => question
    ? `<section class="answer-card" id="answer-${i}"><details open><summary>回答 ${String(i + 1).padStart(2, '0')} / ${escape(s.author)}${typeof s.votes === 'number' ? ` · ${s.votes} 赞同` : ''} · 点击折叠</summary><div class="answer-body">${safeHtml(s.html, options.images)}</div>${s.url ? `<a href="${escape(s.url)}">查看这条回答的原文 ↗</a>` : ''}${comments(i)}</details></section>`
    : `<section><div class="author">${String(i + 1).padStart(2, '0')} / ${escape(s.author)}</div>${safeHtml(s.html, options.images)}${comments(i)}</section>`).join('')}
  ${article.nextUrl ? `<button class="load-more" data-action="next">${question ? '加载更多回答' : '下一页回复'} →</button>` : ''}<p class="meta end-note">${question ? '回答按知乎默认顺序展示，仅展示当前登录可获取的内容。' : '仅展示当前登录可获取的内容。'}</p></main></div>${work}</div>
  <script nonce="${nonce}">${readerScript()}</script></body></html>`;
}
