import { test } from 'node:test';
import assert from 'node:assert/strict';
import { commentTarget, commentUrl, loadComments, parseComments, validateCommentPage } from '../comments';
import { Article, parseLink } from '../model';
import { renderArticle } from '../render';

const article: Article = { ...parseLink('https://www.zhihu.com/question/12/answer/99'), sections: [{ author: '作者', html: '正文' }], fetchedAt: 1 };
const target = { type: 'answers' as const, id: '99' };
test('comments target the selected answer or article, never the question ID', () => {
  assert.deepEqual(commentTarget(article, 0), target);
  assert.deepEqual(commentTarget({ ...article, ...parseLink('https://zhuanlan.zhihu.com/p/123') }, 0), { type: 'articles', id: '123' });
  assert.deepEqual(commentTarget({ ...article, ...parseLink('https://www.zhihu.com/question/12'), sections: [{ id: '777', author: '作者', html: '正文' }] }, 0), { type: 'answers', id: '777' });
  assert.equal(commentTarget(article, 9), undefined); assert.equal(commentTarget(article, -1), undefined);
  assert.equal(commentTarget({ ...article, ...parseLink('https://www.zhihu.com/question/12') }, 0), undefined);
});
test('comments preserve long IDs, authors, reply context, totals and pagination', () => {
  const body = '{"data":[{"id":1969027955376807936,"content":"评论正文","author":{"member":{"name":"甲"}},"like_count":4,"child_comment_count":3,"child_comments":[{"id":"2","content":"回复","author":{"name":"乙"},"reply_to_author":{"name":"甲"}}]}],"paging":{"totals":12,"is_end":false,"next":"http://www.zhihu.com/api/v4/comment_v5/answers/99/root_comment?offset=opaque"}}';
  const page = parseComments(body, target, commentUrl(target));
  assert.equal(page.items[0].id, '1969027955376807936'); assert.equal(page.items[0].author, '甲');
  assert.equal(page.items[0].children[0].replyTo, '甲'); assert.equal(page.items[0].moreReplies, 2);
  assert.equal(page.total, 12); assert.match(page.nextUrl!, /^https:/);
});
test('comment pagination rejects other hosts, answer IDs, endpoints and credentials', () => {
  for (const url of ['https://evil.com/api/v4/comment_v5/answers/99/root_comment', 'https://www.zhihu.com/api/v4/comment_v5/answers/88/root_comment', 'https://www.zhihu.com/api/v4/me', 'https://user@www.zhihu.com/api/v4/comment_v5/answers/99/root_comment']) assert.equal(validateCommentPage(url, target), undefined);
});
test('empty comments are distinct from inaccessible comments', () => {
  assert.deepEqual(parseComments('{"data":[],"paging":{"is_end":true}}', target, commentUrl(target)).items, []);
  assert.throws(() => parseComments('{"error":{"code":403}}', target, commentUrl(target)), /无权查看/);
});
test('comment fetching falls back to the legacy endpoint and preserves cookie scope', async () => {
  const urls: string[] = [];
  const page = await loadComments(target, 'session=test', undefined, (async (input: unknown, options: RequestInit) => {
    urls.push(String(input)); assert.equal((options.headers as Record<string, string>).Cookie, 'session=test');
    return urls.length === 1 ? new Response('', { status: 403 }) : new Response('{"data":[{"id":"1","content":"旧接口评论"}],"paging":{"is_end":true}}');
  }) as typeof fetch);
  assert.equal(urls.length, 2); assert.match(urls[1], /\/answers\/99\/root_comments/); assert.equal(page.items[0].html, '旧接口评论');
  await assert.rejects(loadComments(target, 'secret', 'https://evil.com'), /无效/);
});
test('comment content and authors are sanitized just like article content', () => {
  const html = renderArticle(article, { images: false, fontSize: 15, saved: false, comments: { '0': {
    items: [{ id: '1', author: '<img onerror="evil()">', html: '<script>evil()</script><p onclick="evil()">评论</p>', children: [], moreReplies: 0 }]
  } } });
  assert.match(html, /查看评论|刷新评论/); assert.match(html, /评论 · 已加载 1 条/);
  assert.doesNotMatch(html, /<script>evil|<p onclick|<img onerror/);
});
