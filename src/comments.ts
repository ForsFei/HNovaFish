import JSONbig from 'json-bigint';
import { Article } from './model';
import { PlatformError, request } from './providers';

const json = JSONbig({ storeAsString: true });
export interface CommentTarget { type: 'answers' | 'articles'; id: string; }
export interface CommentItem { id: string; author: string; html: string; votes?: number; replyTo?: string; children: CommentItem[]; moreReplies: number; }
export interface CommentPage { items: CommentItem[]; nextUrl?: string; total?: number; }
export interface CommentView extends CommentPage { loading?: boolean; error?: string; }

export function commentTarget(article: Article, index: number): CommentTarget | undefined {
  if (article.site !== 'zhihu' || !Number.isInteger(index) || !article.sections[index]) return;
  const url = new URL(article.url);
  const post = url.hostname === 'zhuanlan.zhihu.com' ? url.pathname.match(/^\/p\/(\d+)/)?.[1] : undefined;
  const answer = url.pathname.match(/\/answer\/(\d+)/)?.[1];
  const id = post || answer || article.sections[index].id;
  if (!id || !/^\d+$/.test(id)) return;
  return { type: post ? 'articles' : 'answers', id };
}

export function commentUrl(target: CommentTarget, legacy = false): string {
  if (!['answers', 'articles'].includes(target.type) || !/^\d+$/.test(target.id)) throw new Error('无效的评论目标。');
  return legacy
    ? `https://www.zhihu.com/api/v4/${target.type}/${target.id}/root_comments?order=normal&limit=20&offset=0&status=open`
    : `https://www.zhihu.com/api/v4/comment_v5/${target.type}/${target.id}/root_comment?order_by=score&limit=20&offset=`;
}

export function validateCommentPage(input: string, target: CommentTarget): string | undefined {
  try {
    const url = new URL(input, commentUrl(target));
    const paths = [new URL(commentUrl(target)).pathname, new URL(commentUrl(target, true)).pathname];
    if (!['http:', 'https:'].includes(url.protocol) || url.hostname !== 'www.zhihu.com' || !paths.includes(url.pathname) || url.port || url.username || url.password || input.length > 8192) return;
    url.protocol = 'https:'; url.hash = ''; return url.href;
  } catch { return; }
}

export function parseComments(body: string, target: CommentTarget, pageUrl: string): CommentPage {
  const result = json.parse(body);
  if (result.error || !Array.isArray(result.data)) throw new PlatformError('评论接口未返回可读评论，可能已关闭评论或当前账号无权查看。');
  const parseItem = (item: any, nested = false): CommentItem | undefined => {
    if (!item || !/^\d+$/.test(String(item.id)) || typeof item.content !== 'string') return;
    const children: CommentItem[] = nested ? [] : (Array.isArray(item.child_comments) ? item.child_comments : []).flatMap((child: any) => { const value = parseItem(child, true); return value ? [value] : []; });
    const count = Number(item.child_comment_count ?? 0);
    return { id: String(item.id), author: item.author?.member?.name || item.author?.name || '知乎用户', html: item.content,
      votes: typeof item.like_count === 'number' ? item.like_count : undefined,
      replyTo: item.reply_to_author?.member?.name || item.reply_to_author?.name,
      children, moreReplies: Number.isSafeInteger(count) ? Math.max(0, count - children.length) : 0 };
  };
  const items: CommentItem[] = result.data.flatMap((item: any) => { const value = parseItem(item); return value ? [value] : []; });
  const next = result.paging?.is_end !== true && typeof result.paging?.next === 'string' ? validateCommentPage(result.paging.next, target) : undefined;
  const total = Number(result.common_counts ?? result.paging?.totals);
  return { items, nextUrl: next && next !== validateCommentPage(pageUrl, target) ? next : undefined, total: Number.isSafeInteger(total) && total >= 0 ? total : undefined };
}

export async function loadComments(target: CommentTarget, cookie?: string, nextUrl?: string, fetcher: typeof fetch = fetch): Promise<CommentPage> {
  if (nextUrl) {
    const valid = validateCommentPage(nextUrl, target);
    if (!valid) throw new Error('无效的评论分页地址。');
    return parseComments(await request(valid, 'zhihu', cookie, fetcher), target, valid);
  }
  const url = commentUrl(target);
  try { return parseComments(await request(url, 'zhihu', cookie, fetcher), target, url); }
  catch {
    const fallback = commentUrl(target, true);
    return parseComments(await request(fallback, 'zhihu', cookie, fetcher), target, fallback);
  }
}
