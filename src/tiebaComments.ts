import * as cheerio from 'cheerio';
import JSONbig from 'json-bigint';
import { Article } from './model';
import { CommentItem, CommentPage } from './comments';
import { PlatformError, request } from './providers';

const json = JSONbig({ storeAsString: true });
export interface TiebaCommentTarget { tid: string; pid: string; }

// The page-wide endpoint supplies counts and short previews in one request.
export function applyTiebaPreviews(article: Article, body: string): void {
  const result = json.parse(body);
  if (Number(result.errno ?? result.no ?? 0) !== 0 || !result.data || typeof result.data.comment_list !== 'object' || result.data.comment_list === null) throw new PlatformError('贴吧楼中楼预览不可用。');
  for (const [index, section] of article.sections.entries()) {
    const target = tiebaCommentTarget(article, index);
    if (!target) continue;
    const floor = result.data.comment_list[target.pid];
    if (!floor) continue; // Omitted floors are unknown, not necessarily empty.
    const raw = Array.isArray(floor.comment_info) ? floor.comment_info : [];
    const items = new Map<string, CommentItem>();
    for (const item of raw) {
      const id = String(item.comment_id ?? item.spid ?? '');
      if (!/^\d+$/.test(id) || typeof item.content !== 'string') continue;
      items.set(id, { id, author: item.show_nickname || item.username || '吧友', html: item.content, children: [], moreReplies: 0 });
    }
    section.tiebaReplyPreview = [...items.values()].slice(0, 3);
    const count = Number(floor.comment_num);
    if (Number.isSafeInteger(count) && count >= 0) section.tiebaReplyCount = Math.max(count, items.size);
  }
}

export async function loadTiebaPreviews(article: Article, cookie?: string, pageUrl?: string, fetcher: typeof fetch = fetch, userAgent?: string): Promise<boolean> {
  article.tiebaPreviewVersion = 5;
  // Modern DOM already includes previews/counts; do not request the legacy API again.
  const needsPreview = article.sections.some((section, index) => tiebaCommentTarget(article, index)
    && section.tiebaReplyCount !== 0 && section.tiebaReplyPreview === undefined);
  if (!needsPreview) return false;
  const target = article.sections.map((_, index) => tiebaCommentTarget(article, index)).find(Boolean);
  if (!target) return false;
  const source = new URL(pageUrl || article.url);
  // Mobile continuation offsets cannot be converted reliably to desktop pages.
  if (source.pathname === '/mo/q/m' && source.searchParams.has('pn')) return false;
  const page = Number(source.searchParams.get('pn') || 1);
  if (!Number.isSafeInteger(page) || page < 1) return false;
  try {
    const body = await request(`https://tieba.baidu.com/p/totalComment?tid=${target.tid}&pn=${page}&see_lz=0`, 'tieba', cookie, fetcher, userAgent);
    applyTiebaPreviews(article, body);
    return true;
  } catch { return false; /* Preserve the readable post and any known counts if previews are blocked. */ }
}

export function tiebaCommentTarget(article: Article, index: number): TiebaCommentTarget | undefined {
  if (article.site !== 'tieba' || !Number.isInteger(index)) return;
  const tid = article.url.match(/^https:\/\/tieba\.baidu\.com\/p\/(\d+)\/?$/)?.[1];
  const pid = article.sections[index]?.id?.match(/^(?:post_content_)?(\d+)$/)?.[1];
  if (tid && pid) return { tid, pid };
}

export function tiebaCommentUrl(target: TiebaCommentTarget, page = 1): string {
  if (!/^\d+$/.test(target.tid) || !/^\d+$/.test(target.pid) || !Number.isSafeInteger(page) || page < 1 || page > 100000) throw new Error('无效的贴吧楼中楼目标。');
  return `https://tieba.baidu.com/p/comment?tid=${target.tid}&pid=${target.pid}&pn=${page}`;
}

export function validateTiebaCommentPage(input: string, target: TiebaCommentTarget): string | undefined {
  try {
    const url = new URL(input, tiebaCommentUrl(target));
    if (url.protocol !== 'https:' || url.hostname !== 'tieba.baidu.com' || url.pathname !== '/p/comment' || url.username || url.password || url.port || url.searchParams.get('tid') !== target.tid || url.searchParams.get('pid') !== target.pid || !/^\d+$/.test(url.searchParams.get('pn') || '')) return;
    return tiebaCommentUrl(target, Number(url.searchParams.get('pn')));
  } catch { return; }
}

export function parseTiebaComments(body: string, target: TiebaCommentTarget, page = 1): CommentPage {
  const $ = cheerio.load(body);
  const items = new Map<string, CommentItem>();
  $('.lzl_single_post').each((_, element) => {
    const node = $(element), content = node.find('.lzl_content_main').first();
    if (!content.length) return;
    let field: any = {};
    try { field = json.parse(node.attr('data-field') || '{}'); } catch { /* Use the DOM ID when metadata is absent. */ }
    const id = String(field.spid ?? field.comment_id ?? node.attr('data-spid') ?? node.attr('id')?.match(/(?:^|_)(\d+)$/)?.[1] ?? '');
    if (!/^\d+$/.test(id)) return;
    items.set(id, { id, author: node.find('.j_user_card, .lzl_cnt > a').first().text().trim() || field.showname || field.username || '吧友', html: content.html() || '', children: [], moreReplies: 0 });
  });
  // An unrecognized verification/login page must not be presented as zero replies.
  if (!items.size && !$('.lzl_single_post, .lzl_cnt, .lzl_list, .j_lzl_container, .lzl_container, .lzl_pager').length && !/暂无(?:回复|评论)|还没有(?:回复|评论)/.test($('body').text())) {
    throw new PlatformError('贴吧未返回可识别的楼中楼，可能需要登录或安全验证，请在原站确认后重试。');
  }
  let nextPage: number | undefined;
  $('.lzl_pager, .j_lzl_pager').each((_, element) => {
    try {
      const field = json.parse($(element).attr('data-field') || '{}');
      const total = Number(field.total_page);
      if (Number.isSafeInteger(total) && total > page && total <= 100000) nextPage = page + 1;
    } catch { /* Link pagination below may still be available. */ }
  });
  $('.lzl_pager a, .j_pager a, a[rel="next"]').each((_, element) => {
    const node = $(element);
    let field: any = {};
    try { field = json.parse(node.attr('data-field') || '{}'); } catch { /* Try the page link. */ }
    const href = node.attr('href') || '';
    const candidate = Number(field.pn ?? (href.match(/^#(\d+)$/)?.[1]) ?? (/^\d+$/.test(node.text().trim()) ? node.text().trim() : undefined) ?? (validateTiebaCommentPage(href, target) ? new URL(href, tiebaCommentUrl(target)).searchParams.get('pn') : undefined));
    if (Number.isSafeInteger(candidate) && candidate > page && candidate <= 100000 && (nextPage === undefined || candidate < nextPage)) nextPage = candidate;
  });
  return { items: [...items.values()], nextUrl: nextPage ? tiebaCommentUrl(target, nextPage) : undefined };
}

export async function loadTiebaComments(target: TiebaCommentTarget, cookie?: string, nextUrl?: string, fetcher: typeof fetch = fetch, userAgent?: string): Promise<CommentPage> {
  const url = nextUrl ? validateTiebaCommentPage(nextUrl, target) : tiebaCommentUrl(target);
  if (!url) throw new Error('无效的贴吧楼中楼分页地址。');
  return parseTiebaComments(await request(url, 'tieba', cookie, fetcher, userAgent), target, Number(new URL(url).searchParams.get('pn')));
}
