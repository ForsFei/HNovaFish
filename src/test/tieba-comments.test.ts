import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLink } from '../model';
import { parseTiebaArticle } from '../providers';
import { renderArticle } from '../render';
import { tiebaCommentTarget, tiebaCommentUrl, validateTiebaCommentPage, parseTiebaComments, loadTiebaComments, applyTiebaPreviews, loadTiebaPreviews } from '../tiebaComments';

const target = { tid: '123', pid: '1969027955376807936' };
const reply = '<li class="lzl_single_post" data-field=\'{"spid":1969027955376807937}\'><div class="lzl_cnt"><a class="j_user_card">吧友甲</a><span class="lzl_content_main">回复<a href="https://tieba.baidu.com/home">乙</a>：正文<img src="https://img.baidu.com/a.jpg"><script>bad()</script></span></div></li>';

test('Tieba floor ID recovery checks later candidates and does not mistake a floor number for a post ID', () => {
  const entry = parseLink('https://tieba.baidu.com/p/11161838479');
  for (const html of [
    `<div class="l_post" data-field=\'{"content":{"post_id":"invalid","comment_num":6}}\'><div class="d_post_content" id="post_content_${target.pid}">正文</div></div>`,
    `<div class="floor" id="floor_1" data-field=\'{"content":{"post_id":0,"comment_num":6}}\'><div class="content">正文</div><a href="?pid=${target.pid}">回复</a></div>`,
    `<div class="floor" data-post-id="${target.pid}"><div class="content">正文</div></div>`
  ]) assert.equal(tiebaCommentTarget(parseTiebaArticle(html, entry), 0)?.pid, target.pid);
  const missing = parseTiebaArticle('<div class="floor" id="floor_1" data-field=\'{"reply_num":6}\'><div class="content">正文</div></div>', entry);
  assert.equal(tiebaCommentTarget(missing, 0), undefined);
  const html = renderArticle(missing, { images: false, fontSize: 15, saved: false });
  assert.match(html, /共 6 条楼中楼回复/);
  assert.match(html, /data-action="recoverReplies"/);
  assert.match(html, /重新识别并展开 6 条回复/);
});

test('Tieba floor IDs survive desktop, standalone and mobile parsing and expose the reply button', () => {
  const entry = parseLink('https://tieba.baidu.com/p/123');
  for (const html of [
    `<div class="l_post" data-field=\'{"content":{"post_id":1969027955376807936}}\'><div class="d_post_content">正文</div></div>`,
    `<div class="d_post_content" id="post_content_${target.pid}">正文</div>`,
    `<div class="floor" data-pid="${target.pid}"><div class="content">正文</div></div>`,
    `<div class="i"><a href="/home?un=one">甲</a>正文 1楼<a href="/mo/q/m?pid=${target.pid}&kz=123">回复</a></div>`
  ]) {
    const article = parseTiebaArticle(html, entry);
    assert.deepEqual(tiebaCommentTarget(article, 0), target);
    assert.ok(!renderArticle(article, { images: false, fontSize: 15, saved: false }).includes('data-action="comments"'));
    article.sections[0].tiebaReplyCount = 2;
    assert.match(renderArticle(article, { images: false, fontSize: 15, saved: false }), /展开剩余 2 条回复/);
    assert.equal(tiebaCommentTarget(article, -1), undefined);
  }
});

test('Tieba reply parsing preserves long IDs, deduplicates and follows pager metadata', () => {
  const result = parseTiebaComments(reply + reply + '<div class="lzl_pager"><a data-field=\'{"pn":2}\'>下一页</a><a href="#9">9</a></div>', target);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, '1969027955376807937');
  assert.equal(result.items[0].author, '吧友甲');
  assert.match(result.items[0].html, /正文/);
  assert.equal(result.nextUrl, tiebaCommentUrl(target, 2));
  assert.equal(parseTiebaComments(reply + '<div class="lzl_pager"><a href="#">2</a></div>', target).nextUrl, tiebaCommentUrl(target, 2));
  assert.equal(parseTiebaComments(reply + '<p class="lzl_pager" data-field=\'{"total_page":3,"current_page":1}\'></p>', target).nextUrl, tiebaCommentUrl(target, 2));
  const article = parseTiebaArticle(`<div class="d_post_content" id="post_content_${target.pid}">正文</div>`, parseLink('https://tieba.baidu.com/p/123'));
  const html = renderArticle(article, { images: false, fontSize: 15, saved: false, comments: { '0': result } });
  assert.match(html, /展开更多回复/); assert.ok(!html.includes('bad()'));
  assert.match(html, /图片已折叠/);
  assert.equal(parseTiebaComments(reply + '<div class="lzl_pager"><a href="#1">1</a></div>', target, 2).nextUrl, undefined);
});

test('Tieba previews show at most three replies, hide empty floors and count the remaining replies', () => {
  const article = parseTiebaArticle(`<div class="l_post" data-field=\'{"content":{"post_id":"${target.pid}","comment_num":9}}\'><div class="d_post_content">正文</div></div>`, parseLink('https://tieba.baidu.com/p/123'));
  assert.equal(article.sections[0].tiebaReplyCount, 9);
  const info = [1, 2, 3, 4].map(id => ({ comment_id: String(id), username: '吧友', content: `预览回复${id}` }));
  applyTiebaPreviews(article, JSON.stringify({ errno: 0, data: { comment_list: { [target.pid]: { comment_num: 8, comment_info: info } } } }));
  assert.equal(article.sections[0].tiebaReplyPreview!.length, 3);
  let html = renderArticle(article, { images: false, fontSize: 15, saved: false });
  assert.match(html, /预览回复1/); assert.match(html, /预览回复3/); assert.ok(!html.includes('预览回复4'));
  assert.match(html, /展开剩余 5 条回复/);
  article.sections[0].tiebaReplyCount = 3;
  html = renderArticle(article, { images: false, fontSize: 15, saved: false });
  assert.ok(!html.includes('data-action="comments"'));
  applyTiebaPreviews(article, JSON.stringify({ data: { comment_list: { [target.pid]: { comment_num: 0, comment_info: [] } } } }));
  html = renderArticle(article, { images: false, fontSize: 15, saved: false });
  assert.ok(!html.includes('tieba-replies')); assert.ok(!html.includes('暂无可见楼中楼'));
});

test('Tieba previews use one page-wide request with the same login and do not discard posts on failure', async () => {
  const article = parseTiebaArticle(`<div class="d_post_content" id="post_content_${target.pid}">正文</div>`, parseLink('https://tieba.baidu.com/p/123'));
  let calls = 0;
  await loadTiebaPreviews(article, 'session=test', 'https://tieba.baidu.com/p/123?pn=2', (async (input: unknown, options: RequestInit) => {
    calls++; const url = new URL(String(input));
    assert.equal(url.pathname, '/p/totalComment'); assert.equal(url.searchParams.get('pn'), '2');
    assert.equal((options.headers as Record<string, string>).Cookie, 'session=test');
    return new Response('', { status: 403 });
  }) as typeof fetch);
  assert.equal(calls, 1); assert.equal(article.sections[0].html, '正文');
  await loadTiebaPreviews(article, undefined, 'https://tieba.baidu.com/mo/q/m?kz=123&pn=20', (async () => assert.fail('Do not guess mobile page numbers')) as typeof fetch);
});

test('Tieba empty replies are distinct from verification or malformed pages', () => {
  assert.equal(parseTiebaComments('<ul class="lzl_list"></ul>', target).items.length, 0);
  for (const html of ['<html>安全验证</html>', '{"errno":1}', '']) assert.throws(() => parseTiebaComments(html, target), /未返回可识别/);
});

test('Tieba reply pagination rejects cross-thread, cross-floor, unsafe hosts and invalid pages before sending credentials', async () => {
  for (const url of [
    'https://evil.com/p/comment?tid=123&pid=1969027955376807936&pn=2',
    tiebaCommentUrl({ ...target, tid: '999' }, 2), tiebaCommentUrl({ ...target, pid: '999' }, 2),
    tiebaCommentUrl(target, 2).replace('https:', 'http:'), tiebaCommentUrl(target, 2).replace('pn=2', 'pn=-1'),
    tiebaCommentUrl(target, 2).replace('https://', 'https://user@')
  ]) {
    assert.equal(validateTiebaCommentPage(url, target), undefined);
    await assert.rejects(loadTiebaComments(target, 'private', url, (async () => assert.fail('No network request')) as typeof fetch), /无效/);
  }
  const page = await loadTiebaComments(target, 'session=test', tiebaCommentUrl(target, 2), (async (url: unknown, options: RequestInit) => {
    assert.equal(String(url), tiebaCommentUrl(target, 2));
    assert.equal((options.headers as Record<string, string>).Cookie, 'session=test');
    assert.equal((options.headers as Record<string, string>)['User-Agent'], 'Browser/145');
    assert.equal(options.redirect, 'manual');
    return new Response(reply);
  }) as typeof fetch, 'Browser/145');
  assert.equal(page.items.length, 1);
});


test('modern pages reuse embedded reply previews without an extra browser API request', async () => {
  const article = parseTiebaArticle('<div class="pb-content-wrap">主楼</div><div class="pb-comment-item" data-id="123"><div class="comment-content">楼层正文<div class="lzl-wrapper"><div class="pb-lzl-item"><a class="head-name">甲</a><div class="comment-content">已有回复</div></div><div class="show-more-lzl">展开 2 条回复</div></div></div></div>', parseLink('https://tieba.baidu.com/p/123'));
  await loadTiebaPreviews(article, undefined, undefined, (async () => assert.fail('Embedded previews need no extra request')) as typeof fetch);
  assert.equal(article.sections[1].tiebaReplyCount, 3);
  assert.equal(article.sections[1].tiebaReplyPreview?.[0].author, '甲');
  assert.match(article.sections[1].tiebaReplyPreview![0].html, /已有回复/);
  assert.match(renderArticle(article, { images: false, fontSize: 15, saved: false }), /展开剩余 2 条回复/);
});
