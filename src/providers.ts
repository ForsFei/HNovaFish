import * as cheerio from 'cheerio';
import JSONbig from 'json-bigint';
import { Article, Entry, Site, assertSiteUrl, parseLink } from './model';

export const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
export class PlatformError extends Error {}
const platformJson = JSONbig({ storeAsString: true });
export const ZHIHU_RECOMMEND_URL = 'https://www.zhihu.com/api/v3/feed/topstory/recommend?desktop=true&limit=30&action=down&after_id=0&page_number=1';
export interface RecommendationPage { entries: Entry[]; nextUrl?: string; }

export const TIEBA_HOME_FEED = 'https://tieba.baidu.com/f/index/feedlist';
export function tiebaHomeUrl(page = 1, lastTid?: string): string {
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000) throw new Error('无效的贴吧首页页码。');
  const url = new URL(TIEBA_HOME_FEED);
  url.searchParams.set('is_new', '1');
  url.searchParams.set('tag_id', 'like');
  url.searchParams.set('pn', String(page));
  if (lastTid && /^\d+$/.test(lastTid)) url.searchParams.set('last_tid', lastTid);
  return url.href;
}
export function tiebaHomePage(input?: string): number {
  if (!input) return 1;
  const url = assertSiteUrl(input, 'tieba');
  const page = Number(url.searchParams.get('pn'));
  if (url.pathname !== '/f/index/feedlist' || !Number.isSafeInteger(page) || page < 1 || page > 100000) throw new Error('无效的贴吧首页分页地址。');
  return page;
}

export function parseTiebaHome(body: string, page = 1): RecommendationPage {
  const result = platformJson.parse(body);
  if ((result.no !== undefined && Number(result.no) !== 0) || !result.data || typeof result.data.html !== 'string') throw new PlatformError('贴吧首页接口未返回推荐列表。');
  const $ = cheerio.load(result.data.html), cards = $('.j_feed_li');
  const parsed = new Map<string, Entry>();
  cards.each((_, element) => {
    const card = $(element);
    if (card.hasClass('home-place-item')) return;
    const link = card.find('.thread-name-wraper a, a.feed-item-link').first();
    const title = link.attr('title')?.trim() || link.text().trim();
    if (!title) return;
    try {
      const entry = parseLink(new URL(link.attr('href') || '', 'https://tieba.baidu.com/').href);
      if (entry.site !== 'tieba') return;
      const forum = card.find('.feed-forum-link, .n_name').first();
      parsed.set(entry.id, { ...entry, title, summary: card.find('.n_txt').text().trim(), description: forum.attr('title') || forum.text().trim() || undefined });
    } catch { /* Ignore unsupported cards rather than collecting unrelated links. */ }
  });
  const entries = cards.length ? [...parsed.values()] : parseTiebaList(result.data.html);
  return { entries, nextUrl: result.data.has_more === true || result.data.has_more === 1 || result.data.has_more === '1' ? tiebaHomeUrl(page + 1, result.data.last_tid == null ? undefined : String(result.data.last_tid)) : undefined };
}

export function validateRecommendationUrl(input: string): string | undefined {
  try {
    const url = new URL(input, ZHIHU_RECOMMEND_URL);
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'www.zhihu.com' || url.pathname !== '/api/v3/feed/topstory/recommend' || url.username || url.password || url.port || input.length > 8192) return;
    url.protocol = 'https:'; url.hash = '';
    return url.href;
  } catch { return; }
}

export function parseRecommendations(body: string, currentUrl = ZHIHU_RECOMMEND_URL): RecommendationPage {
  const result = platformJson.parse(body);
  if (result.error) throw new PlatformError('知乎推荐接口拒绝访问，请更新知乎 Cookie 或在原站完成验证。');
  if (!Array.isArray(result.data)) throw new PlatformError('知乎推荐返回格式已变化，未读取到推荐列表。');
  const entries = new Map<string, Entry>();
  for (const feed of result.data) {
    if (!feed || /advert|promotion|commercial/i.test(String(feed.type)) || feed.ad || feed.is_ad || feed.promotion) continue;
    const target = feed.target;
    if (!target || target.is_ad || !/^\d+$/.test(String(target.id))) continue;
    let url: string, title: string, label: string;
    if (target.type === 'answer' && /^\d+$/.test(String(target.question?.id)) && typeof target.question?.title === 'string') {
      url = `https://www.zhihu.com/question/${target.question.id}/answer/${target.id}`;
      title = target.question.title; label = '回答';
    } else if (target.type === 'article' && typeof target.title === 'string') {
      url = `https://zhuanlan.zhihu.com/p/${target.id}`; title = target.title; label = '文章';
    } else if (target.type === 'question' && typeof target.title === 'string') {
      url = `https://www.zhihu.com/question/${target.id}`; title = target.title; label = '问题';
    } else continue;
    const entry = parseLink(url);
    const excerpt = typeof target.excerpt === 'string' ? cheerio.load(target.excerpt).text().trim() : '';
    const author = typeof target.author?.name === 'string' ? target.author.name : '';
    entries.set(entry.id, { ...entry, title, summary: excerpt, description: `${label}${author ? ` · ${author}` : ''}` });
  }
  let nextUrl: string | undefined;
  if (result.paging?.is_end !== true && typeof result.paging?.next === 'string') {
    const next = validateRecommendationUrl(result.paging.next);
    if (next && next !== validateRecommendationUrl(currentUrl)) nextUrl = next;
  }
  return { entries: [...entries.values()], nextUrl };
}

export async function request(url: string, site: Site, cookie?: string, fetcher: typeof fetch = fetch, userAgent?: string): Promise<string> {
  assertSiteUrl(url, site);
  const response = await fetcher(url, {
    redirect: 'manual', signal: AbortSignal.timeout(new URL(url).searchParams.has('hnova_after') ? 15000 : site === 'tieba' ? 45000 : 18000),
    headers: { 'User-Agent': userAgent?.trim() || USER_AGENT, 'Accept': 'application/json,text/html;q=0.9',
      ...(site === 'tieba' ? { 'Referer': 'https://tieba.baidu.com/', 'Accept-Language': 'zh-CN,zh;q=0.9' } : {}), ...(cookie ? { Cookie: cookie } : {}) }
  });
  if ([301, 302, 303, 307, 308, 401, 403, 429].includes(response.status)) throw new PlatformError(`平台要求登录或安全验证（${site === 'tieba' ? '贴吧' : '知乎'}，HTTP ${response.status}）。请在浏览器完成验证后重试；Cookie 也可能无法解除访问限制。`);
  if (!response.ok) throw new Error(`平台请求失败（HTTP ${response.status}）。`);
  // Bound responses before parsing or storing them.
  const reader = response.body?.getReader();
  if (!reader) throw new Error('平台返回了空内容。');
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { done, value } = await reader.read(); if (done) break;
    size += value.length;
    if (size > 8 * 1024 * 1024) { await reader.cancel(); throw new Error('页面超过 8 MB，已停止加载。'); }
    chunks.push(value);
  }
  const body = Buffer.concat(chunks).toString('utf8');
  if (/百度安全验证|<title>[^<]*(?:安全验证|登录知乎)|"name"\s*:\s*"AuthenticationError"/i.test(body)) throw new PlatformError(`平台返回安全验证页面（HTTP ${response.status}）。请在原站完成验证，或更新 Cookie。`);
  return body;
}

export function parseTiebaList(html: string): Entry[] {
  // Desktop Tieba sometimes wraps its thread list in HTML comments.
  const $ = cheerio.load(html.replace(/<!--([\s\S]*?)-->/g, (_, content: string) => content.includes('threadlist') ? content : ''));
  const found = new Map<string, Entry>();
  const cards = $('.thread-card');
  if (cards.length) {
    cards.each((_, element) => {
      const card = $(element), title = card.find('.thread-title').first().text().trim();
      const href = card.find('a.thread-content-link').first().attr('href');
      if (!title || !href) return;
      try {
        const entry = parseLink(new URL(href, 'https://tieba.baidu.com').href);
        if (entry.site === 'tieba') found.set(entry.url, { ...entry, title, summary: card.find('.thread-content').first().text().trim() });
      } catch { /* Ignore ads and unsupported links. */ }
    });
    return [...found.values()];
  }
  $('a[href]').each((_, el) => {
    const a = $(el), href = a.attr('href') || '';
    if (a.closest('.thread-action-area, .comment-link-zone').length) return;
    const match = href.match(/(?:\/p\/|[?&]kz=)(\d+)/);
    const title = (a.attr('title') || a.text()).trim();
    if (!match || title.length < 3 || /^(回复|点击|查看|\d+条)/.test(title) || !a.attr('title') && /^\d+$/.test(title)) return;
    const url = `https://tieba.baidu.com/p/${match[1]}`;
    if (!found.has(url)) found.set(url, { ...parseLink(url), title });
  });
  return [...found.values()];
}

export function parseZhihuList(body: string): Entry[] {
  const data = platformJson.parse(body);
  return (data.data || []).flatMap((item: any) => {
    const target = item.target || {};
    if (!/^\d+$/.test(String(target.id)) || typeof target.title !== 'string') return [];
    return [{ ...parseLink(`https://www.zhihu.com/question/${target.id}`), title: target.title, summary: target.excerpt || '' }];
  });
}

export function validateTiebaPage(input: string, entry: Entry): string | undefined {
  try {
    const canonical = parseLink(entry.url);
    if (canonical.site !== 'tieba') return;
    const id = new URL(canonical.url).pathname.split('/').pop()!;
    const url = new URL(input, canonical.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.hostname !== 'tieba.baidu.com' || url.username || url.password || url.port) return;
    const after = url.searchParams.get('hnova_after');
    const floor = url.searchParams.get('hnova_floor');
    if (after !== null) {
      if (url.pathname !== `/p/${id}` || !/^\d{1,32}$/.test(after) || url.protocol !== 'https:' || url.searchParams.has('pn')) return;
      if (floor !== null && !/^[1-9]\d{0,8}$/.test(floor)) return;
      return `https://tieba.baidu.com/p/${id}?hnova_after=${after}${floor ? `&hnova_floor=${floor}` : ''}`;
    }
    const pn = url.searchParams.get('pn');
    if (pn !== null && !/^\d{1,9}$/.test(pn)) return;
    if (url.pathname === `/p/${id}`) return `https://tieba.baidu.com/p/${id}${pn === null ? '' : `?pn=${pn}`}`;
    if (url.pathname === '/mo/q/m' && url.searchParams.get('kz') === id) return `https://tieba.baidu.com/mo/q/m?kz=${id}${pn === null ? '' : `&pn=${pn}`}`;
  } catch { return; }
}

export function parseTiebaArticle(html: string, entry: Entry, pageUrl = entry.url): Article {
  const $ = cheerio.load(html.replace(/<!--([\s\S]*?)-->/g, (_, content: string) => /d_post_content|class=["'][^"']*l_post/.test(content) ? content : ''));
  const sections: Article['sections'] = [];
  const readable = (content: ReturnType<typeof $>) => content.text().trim() || content.find('img').length;
  const metadata = (raw?: string) => { try { return raw ? platformJson.parse(raw) : {}; } catch { return {}; } };
  const floorId = (node: ReturnType<typeof $>): string | undefined => {
    const data = metadata(node.attr('data-field'));
    const candidates = [data.content?.post_id, data.content?.pid, data.post_id, data.pid,
      node.attr('data-pid'), node.attr('data-post-id'), node.find('.d_post_content').first().attr('id')];
    for (const raw of candidates) {
      const id = String(raw ?? '').match(/^(?:post_content_|post[_-])?([1-9]\d*)$/)?.[1];
      if (id) return id;
    }
    for (const link of node.find('a[href*="pid="], a[href*="spid="]').toArray()) {
      try { const pid = new URL($(link).attr('href')!, pageUrl).searchParams.get('pid'); if (pid && /^[1-9]\d*$/.test(pid)) return pid; } catch { /* Ignore broken links. */ }
    }
    // A mobile floor's DOM index (floor_1) is not a post ID. Prefer reply links.
    return node.attr('id')?.match(/^(?:post_content_|post[_-])([1-9]\d*)$/)?.[1];
  };
  const replyCount = (node: ReturnType<typeof $>): number | undefined => {
    const data = metadata(node.attr('data-field'));
    const raw = data.content?.comment_num ?? data.content?.reply_num ?? data.comment_num ?? data.reply_num;
    const count = raw === undefined ? undefined : Number(raw);
    return Number.isSafeInteger(count) && count! >= 0 ? count : undefined;
  };
  const modernBody = $('.pb-content-wrap').first();
  if (modernBody.length && readable(modernBody)) sections.push({ author: $('.center-content .head-name').first().text().trim() || '楼主', html: modernBody.html() || '' });
  $('.pb-comment-item').each((_, element) => {
    const floor = $(element), content = floor.children('.comment-content').first().clone();
    content.find('.pc-pb-comments-desc, .lzl-wrapper, script, style').remove();
    if (!content.length || !readable(content)) return;
    const id = floor.attr('data-id');
    const replies = floor.find('.pb-lzl-item').toArray().map((reply, index) => {
      const node = $(reply), body = node.children('.comment-content').first().clone();
      body.find('.pc-pb-comments-desc, script, style').remove();
      return { id: node.attr('data-id') || `preview-${id}-${index}`, author: node.find('.head-name').first().text().trim() || '吧友', html: body.html() || '', children: [], moreReplies: 0 };
    }).filter(reply => reply.html.trim());
    const more = Number(floor.find('.show-more-lzl').text().match(/展开\s*(\d+)\s*条/)?.[1] || 0);
    sections.push({ id: id && /^\d+$/.test(id) ? id : undefined, author: floor.find('.head-name').first().text().trim() || '吧友', html: content.html() || '', tiebaReplyCount: replies.length + more, tiebaReplyPreview: replies.slice(0, 3) });
  });
  if (!sections.length) $('.l_post').each((_, el) => {
    const node = $(el), content = node.find('.d_post_content');
    const data = metadata(node.attr('data-field'));
    if (content.length && readable(content)) sections.push({ id: floorId(node), tiebaReplyCount: replyCount(node), author: node.find('.p_author_name').first().text().trim() || data.author?.user_name || '吧友', html: content.html() || '' });
  });
  // Some desktop responses omit the surrounding floor container.
  if (!sections.length) $('.d_post_content').each((_, el) => {
    const content = $(el);
    if (readable(content)) sections.push({ id: floorId(content), tiebaReplyCount: replyCount(content), author: '吧友', html: content.html() || '' });
  });
  if (!sections.length) $('.floor, .post-item, .list_item, .p_postlist > li').each((_, el) => {
    const floor = $(el), content = floor.find('.content-text, .post-content, .content').first();
    if (content.length && readable(content)) sections.push({ id: floorId(floor), tiebaReplyCount: replyCount(floor), author: floor.find('.user_name, .username, .author, .p_author_name').first().text().trim() || '吧友', html: content.html() || '' });
  });
  // Legacy WAP floors are .i blocks with a user link and a floor marker.
  if (!sections.length) $('.i').each((_, el) => {
    const floor = $(el);
    if (!/\d+\s*楼/.test(floor.text())) return;
    const author = floor.find('a[href*="un="], a[href*="/home"], .user_name').first();
    if (!author.length) return;
    const content = floor.clone(); content.find('script,style,form,.reply,.floor-info').remove();
    sections.push({ id: floorId(floor), tiebaReplyCount: replyCount(floor), author: author.text().trim() || '吧友', html: content.html() || '' });
  });
  if (!sections.length) {
    const text = $('body').text();
    if (/帖子不存在|贴子不存在|帖子已被删除|贴子已被删除|该贴已被删除|您要浏览的贴子暂时无法显示/.test(text)) throw new PlatformError('贴吧返回帖子不存在、已删除或当前账号不可见的提示。');
    throw new PlatformError('贴吧页面未返回可识别的正文楼层，可能是需浏览器运行脚本的页面、访问限制或页面结构变化。');
  }
  const next = $('a[rel="next"], a').filter((_, el) => $(el).attr('rel') === 'next' || /^下[一]?页(?:[>›»→]*)$/.test($(el).text().trim())).first().attr('href');
  let nextUrl: string | undefined;
  if (next) {
    try {
      const normalized = validateTiebaPage(new URL(next, pageUrl).href, entry);
      if (normalized && Number(new URL(normalized).searchParams.get('pn')) > Number(new URL(pageUrl).searchParams.get('pn') || 0)) nextUrl = normalized;
    } catch { /* A broken next link must not discard readable floors. */ }
  }
  const browserNext = $('meta[name="hnova-tieba-next"]').attr('content');
  if (browserNext && $('.pb-comment-item[data-id]').length) {
    const normalized = validateTiebaPage(browserNext, entry);
    if (normalized && normalized !== pageUrl && new URL(normalized).searchParams.has('hnova_after')) nextUrl = normalized;
  }
  return { ...entry, title: $('.pb-title, h3.core_title_txt, h1, .thread_title, .ti_title').first().text().trim() || $('title').text().replace(/_.*$/, '').trim() || entry.title, sections, nextUrl, fetchedAt: Date.now() };
}

export function parseZhihuArticle(html: string, entry: Entry): Article {
  const $ = cheerio.load(html);
  const sections: Article['sections'] = [];
  // Prefer normalized state: HTML selectors can duplicate collapsed answer previews.
  const initial = $('#js-initialData').text();
  if (initial) {
    try {
      const entities = platformJson.parse(initial).initialState?.entities;
      const answerId = entry.url.match(/\/answer\/(\d+)/)?.[1];
      const articleId = entry.url.includes('zhuanlan.') ? entry.url.match(/\/p\/(\d+)/)?.[1] : undefined;
      const items: any[] = articleId ? [entities?.articles?.[articleId]] : answerId ? [entities?.answers?.[answerId]] : Object.values(entities?.answers || {});
      for (const answer of items) if (answer?.content) sections.push({ id: answer.id ? String(answer.id) : undefined, author: answer.author?.name || '知乎用户', html: answer.content, votes: answer.voteupCount ?? answer.voteup_count });
    } catch { /* Fall back to server-rendered content. */ }
  }
  if (!sections.length) $('.AnswerItem, .Post-RichTextContainer').each((_, el) => {
    const node = $(el), content = node.hasClass('Post-RichTextContainer') ? node : node.find('.RichContent-inner .RichText').first();
    if (content.length && content.text().trim()) sections.push({ author: node.find('.AuthorInfo-name').text().trim() || '知乎用户', html: content.html() || '' });
  });
  if (!sections.length) throw new PlatformError('未获取到可读正文，可能需要登录、验证，或平台未返回完整内容。可在浏览器查看原文。');
  const kind = zhihuKind(entry);
  return { ...entry, title: $('h1').first().text().trim() || $('title').text().replace(/ - 知乎$/, '').trim() || entry.title, sections,
    kind, source: 'html', nextUrl: kind === 'question' ? zhihuContentUrl(entry) : undefined, fetchedAt: Date.now() };
}

export class Providers {
  constructor(private readonly cookie: (site: Site) => Promise<string | undefined>, private readonly fetcher: typeof fetch = (...args) => fetch(...args), private readonly tiebaUserAgent: () => string | undefined = () => undefined) {}
  async recommendationBatch(source: 'recommend' | 'tiebaHome', pageUrl?: string): Promise<RecommendationPage> {
    const found = new Map<string, Entry>();
    const visited = new Set<string>();
    let nextUrl = pageUrl;
    // Bound work even when the server returns duplicate cards or cyclic cursors.
    for (let page = 0; page < 4 && found.size < 30; page++) {
      const cursor = nextUrl || 'first';
      if (visited.has(cursor)) { nextUrl = undefined; break; }
      visited.add(cursor);
      let result: RecommendationPage;
      try { result = await (source === 'recommend' ? this.recommendations(nextUrl) : this.tiebaHome(nextUrl)); }
      catch (error) { if (!found.size) throw error; break; }
      for (const entry of result.entries) if (!found.has(entry.id) && found.size < 30) found.set(entry.id, entry);
      nextUrl = result.nextUrl;
      if (!nextUrl) break;
    }
    return { entries: [...found.values()], nextUrl };
  }
  async tiebaHome(pageUrl?: string): Promise<RecommendationPage> {
    const page = tiebaHomePage(pageUrl), cookie = await this.cookie('tieba');
    const lastTid = pageUrl ? new URL(pageUrl).searchParams.get('last_tid') || undefined : undefined;
    let apiError: unknown;
    try {
      const result = parseTiebaHome(await request(tiebaHomeUrl(page, lastTid), 'tieba', cookie, this.fetcher, this.tiebaUserAgent()), page);
      if (!result.entries.length) throw new PlatformError('本批未返回可读推荐，可能需要登录或首页只提供动态内容。');
      return result;
    } catch (error) { apiError = error; }
    if (page > 1) throw apiError;
    try {
      const entries = parseTiebaList(await request('https://tieba.baidu.com/', 'tieba', cookie, this.fetcher, this.tiebaUserAgent()));
      if (!entries.length) throw new PlatformError('首页网页没有可读帖子。');
      return { entries };
    } catch (error) {
      throw new PlatformError(`贴吧首页推荐加载失败。接口：${apiError instanceof Error ? apiError.message : '请求失败'} 网页：${error instanceof Error ? error.message : '请求失败'} 请检查贴吧登录状态及安全验证。`);
    }
  }
  async recommendations(pageUrl = ZHIHU_RECOMMEND_URL): Promise<RecommendationPage> {
    const url = validateRecommendationUrl(pageUrl);
    if (!url) throw new Error('无效的知乎推荐分页地址。');
    const cookie = await this.cookie('zhihu');
    if (!cookie?.trim()) throw new PlatformError('个性化推荐需要知乎登录状态，请先通过标题栏钥匙菜单设置知乎 Cookie。');
    return parseRecommendations(await request(url, 'zhihu', cookie, this.fetcher), url);
  }
  async list(site: Site, forum?: string, page = 0): Promise<Entry[]> {
    if (site === 'tieba') {
      const cookie = await this.cookie('tieba');
      const kw = encodeURIComponent(forum || '图拉丁');
      const urls = [
        `https://tieba.baidu.com/f?kw=${kw}&ie=utf-8&pn=${page * 50}`,
        `https://tieba.baidu.com/mo/q/m?kw=${kw}&pn=${page * 50}`
      ];
      const errors: string[] = [];
      for (const [index, url] of urls.entries()) {
        try {
          const list = parseTiebaList(await request(url, 'tieba', cookie, this.fetcher, this.tiebaUserAgent()));
          if (list.length) return list;
          throw new Error('页面未包含可读帖子列表，可能为验证页面或页面结构已变化。');
        } catch (error) { errors.push(`${index === 0 ? '桌面版' : '移动版'}：${error instanceof Error ? error.message : '请求失败'}`); }
      }
      const login = !cookie?.trim() ? '未设置贴吧 Cookie。' : /(?:^|;\s*)(?:BDUSS|BDUSS_BFESS)=/.test(cookie) ? 'Cookie 已设置，含百度登录字段。' : 'Cookie 已设置，但未发现 BDUSS / BDUSS_BFESS 登录字段，可能只复制了访客 Cookie。';
      throw new PlatformError(`贴吧列表加载失败。${login} ${errors.join(' ')} 如浏览器可正常浏览，可在设置 hnovaFish.tiebaUserAgent 中填写同一浏览器的 User-Agent；这仍不能保证解除设备验证。`);
    }
    const url = 'https://www.zhihu.com/api/v3/feed/topstory/hot-lists/total?limit=30&desktop=true';
    const body = await request(url, site, await this.cookie(site), this.fetcher);
    const list = parseZhihuList(body);
    if (!list.length) throw new Error('没有获取到帖子，可能是页面结构变化或访问受限。');
    return list;
  }
  async article(entry: Entry, pageUrl?: string): Promise<Article> {
    const cookie = await this.cookie(entry.site);
    if (entry.site === 'tieba') {
      const canonical = parseLink(entry.url);
      const id = new URL(canonical.url).pathname.split('/').pop()!;
      const validPage = pageUrl ? validateTiebaPage(pageUrl, entry) : undefined;
      if (pageUrl && !validPage) throw new Error('无效的贴吧正文分页地址。');
      // Mobile and desktop use different pagination schemes: never guess a
      // conversion when following subsequent pages.
      const urls = validPage ? [validPage] : [canonical.url, `https://tieba.baidu.com/mo/q/m?kz=${id}`];
      const errors: string[] = [];
      for (const url of urls) {
        try {
          const html = await request(url, 'tieba', cookie, this.fetcher, this.tiebaUserAgent());
          return parseTiebaArticle(html, entry, url);
        } catch (error) { errors.push(`${new URL(url).pathname.startsWith('/p/') ? '桌面版' : '移动版'}：${error instanceof Error ? error.message : '请求失败'}`); }
      }
      throw new PlatformError(`贴吧正文加载失败。${errors.join(' ')} 列表和正文的访问限制可能不同；如两种页面都未返回楼层，需要在原站确认该帖是否可见。`);
    }
    if (pageUrl) {
      const valid = validateZhihuPage(pageUrl, entry);
      if (!valid) throw new Error('无效的知乎回答分页地址。');
      return parseZhihuContent(await request(valid, 'zhihu', cookie, this.fetcher), entry, valid);
    }
    // Question HTML can be an empty client-rendered shell even with a valid login.
    // Read the answers endpoint first, then retain HTML as a compatibility fallback.
    const api = zhihuContentUrl(entry);
    let apiError: unknown;
    try {
      return parseZhihuContent(await request(api, 'zhihu', cookie, this.fetcher), entry, api);
    } catch (error) { apiError = error; }
    try {
      return parseZhihuArticle(await request(entry.url, 'zhihu', cookie, this.fetcher), entry);
    } catch (htmlError) {
      const detail = (error: unknown) => error instanceof Error ? error.message : '未知错误';
      throw new PlatformError(`知乎正文加载失败。回答接口：${detail(apiError)} 网页解析：${detail(htmlError)}`);
    }
  }
}

export function zhihuContentUrl(entry: Entry): string {
  const canonical = parseLink(entry.url);
  if (canonical.site !== 'zhihu') throw new Error('仅支持知乎正文地址。');
  const path = new URL(canonical.url).pathname;
  const answer = path.match(/\/answer\/(\d+)/)?.[1];
  const question = path.match(/^\/question\/(\d+)\/?$/)?.[1];
  const article = new URL(canonical.url).hostname === 'zhuanlan.zhihu.com' ? path.match(/^\/p\/(\d+)/)?.[1] : undefined;
  const include = encodeURIComponent(question ? 'data[*].content,voteup_count,author.name,question.title,question.answer_count' : 'content,voteup_count,author.name,question.title,question.answer_count,title');
  if (answer) return `https://www.zhihu.com/api/v4/answers/${answer}?include=${include}`;
  if (question) return `https://www.zhihu.com/api/v4/questions/${question}/answers?include=${include}&limit=10&offset=0&sort_by=default`;
  if (article) return `https://www.zhihu.com/api/v4/articles/${article}?include=${include}`;
  throw new Error('无法识别知乎内容地址。');
}

export function zhihuKind(entry: Entry): 'question' | 'answer' | 'article' {
  const url = new URL(entry.url);
  return url.hostname === 'zhuanlan.zhihu.com' ? 'article' : url.pathname.includes('/answer/') ? 'answer' : 'question';
}

export function validateZhihuPage(input: string, entry: Entry): string | undefined {
  if (zhihuKind(entry) !== 'question') return;
  try {
    const expected = new URL(zhihuContentUrl(entry));
    const next = new URL(input, expected);
    if (!['http:', 'https:'].includes(next.protocol) || next.hostname !== expected.hostname || next.pathname !== expected.pathname || next.username || next.password || next.port) return;
    const offset = next.searchParams.get('offset');
    if (!offset || !/^\d{1,9}$/.test(offset)) return;
    // Rebuild instead of forwarding arbitrary platform-supplied query parameters.
    expected.searchParams.set('offset', String(Number(offset)));
    return expected.href;
  } catch { return; }
}

export function parseZhihuContent(body: string, entry: Entry, pageUrl?: string): Article {
  const result = platformJson.parse(body);
  if (result.error) throw new PlatformError('知乎回答接口拒绝访问，可能需要重新登录或完成验证。');
  const items: any[] = Array.isArray(result.data) ? result.data : [result];
  const readable = items.filter(item => typeof item?.content === 'string' && item.content.trim());
  if (!readable.length) throw new PlatformError('回答接口未返回正文，可能尚无回答、回答受限或当前登录无权查看。');
  const kind = zhihuKind(entry);
  let nextUrl: string | undefined;
  if (kind === 'question' && result.paging?.is_end !== true && typeof result.paging?.next === 'string') {
    const next = validateZhihuPage(result.paging.next, entry);
    if (next && Number(new URL(next).searchParams.get('offset')) > Number(new URL(pageUrl || zhihuContentUrl(entry)).searchParams.get('offset'))) nextUrl = next;
  }
  const total = Number(readable[0].question?.answer_count ?? readable[0].question?.answerCount ?? result.paging?.totals);
  return { ...entry, title: readable[0].question?.title || readable[0].title || entry.title,
    sections: readable.map(item => ({ id: item.id ? String(item.id) : undefined, author: item.author?.name || '知乎用户', html: item.content,
      votes: typeof item.voteup_count === 'number' ? item.voteup_count : undefined,
      url: /^\d+$/.test(String(item.id)) && kind === 'question' ? `${entry.url.replace(/\/$/, '')}/answer/${item.id}` : undefined })),
    kind, source: 'api', nextUrl, totalAnswers: Number.isSafeInteger(total) && total >= 0 ? total : undefined,
    questionUrl: kind === 'answer' && /^\d+$/.test(String(readable[0].question?.id)) ? `https://www.zhihu.com/question/${readable[0].question.id}` : undefined, fetchedAt: Date.now() };
}
