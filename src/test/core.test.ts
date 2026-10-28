import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeSections, parseLink } from '../model';
import { parseTiebaArticle, parseTiebaList, parseZhihuArticle, parseZhihuList, parseZhihuContent, zhihuContentUrl, validateZhihuPage, Providers, request } from '../providers';
import { safeHtml, renderArticle } from '../render';

test('normalizes supported post links and discards tracking parameters', () => {
  assert.equal(parseLink('https://tieba.baidu.com/p/123?share=1#reply').url, 'https://tieba.baidu.com/p/123');
  assert.equal(parseLink('https://zhihu.com/question/123/answer/456').url, 'https://www.zhihu.com/question/123/answer/456');
  assert.equal(parseLink('https://zhuanlan.zhihu.com/p/123').site, 'zhihu');
});
test('rejects spoofed hosts, credentials, http and arbitrary paths', () => {
  for (const url of ['http://tieba.baidu.com/p/1', 'https://tieba.baidu.com.evil.com/p/1', 'https://www.zhihu.com@evil.com/question/1', 'https://www.zhihu.com/api/v4/me', 'https://user:pass@www.zhihu.com/question/1']) assert.throws(() => parseLink(url));
});
test('parses commented desktop Tieba list and deduplicates links', () => {
  const list = parseTiebaList('<!-- <ul id="threadlist"><li><a href="/p/123" title="今天装机求助">标题</a><a href="/p/123">重复标题</a></li></ul> -->');
  assert.equal(list.length, 1); assert.equal(list[0].title, '今天装机求助');
});
test('parses mobile Tieba links', () => {
  assert.equal(parseTiebaList('<a href="/mo/q/m?kz=123">手机帖子标题</a>')[0].url, 'https://tieba.baidu.com/p/123');
});
test('extracts Tieba floors and only same-thread next pages', () => {
  const entry = parseLink('https://tieba.baidu.com/p/123');
  const html = '<h3 class="core_title_txt">装机讨论</h3><div class="l_post"><span class="p_author_name">小明</span><div class="d_post_content">正文<br>第二行</div></div>';
  const article = parseTiebaArticle(html + '<a href="/p/123?pn=2">下一页</a>', entry);
  assert.equal(article.title, '装机讨论'); assert.equal(article.sections[0].author, '小明'); assert.equal(article.nextUrl, 'https://tieba.baidu.com/p/123?pn=2');
  assert.equal(parseTiebaArticle(html + '<a href="https://evil.com/">下一页</a>', entry).nextUrl, undefined);
  assert.equal(parseTiebaArticle(html + '<a href="/p/999?pn=2">下一页</a>', entry).nextUrl, undefined);
  assert.throws(() => parseTiebaArticle('<html>登录</html>', entry));
});
test('parses Zhihu hot list without trusting target URLs', () => {
  const list = parseZhihuList(JSON.stringify({ data: [{ target: { id: 12, title: '问题标题', url: 'https://evil.com' } }, { target: { id: 'bad' } }] }));
  assert.equal(list.length, 1); assert.equal(list[0].url, 'https://www.zhihu.com/question/12');
});
test('preserves large numeric Zhihu IDs without rounding', () => {
  const list = parseZhihuList('{"data":[{"target":{"id":1969027955376807936,"title":"长 ID 问题"}}]}');
  assert.equal(list[0].url, 'https://www.zhihu.com/question/1969027955376807936');
  assert.match(zhihuContentUrl(list[0]), /questions\/1969027955376807936\/answers/);
});
test('selects content endpoint for questions, specific answers and articles', () => {
  assert.match(zhihuContentUrl(parseLink('https://www.zhihu.com/question/123')), /questions\/123\/answers/);
  assert.match(zhihuContentUrl(parseLink('https://www.zhihu.com/question/123/answer/456')), /\/answers\/456\?/);
  assert.match(zhihuContentUrl(parseLink('https://www.zhihu.com/answer/456')), /\/answers\/456\?/);
  assert.match(zhihuContentUrl(parseLink('https://zhuanlan.zhihu.com/p/789')), /\/articles\/789\?/);
});
test('parses API content rather than an answer excerpt', () => {
  const entry = parseLink('https://www.zhihu.com/question/123');
  const article = parseZhihuContent(JSON.stringify({ data: [{ content: '<p>完整正文</p>', excerpt: '摘要', author: { name: '作者' }, question: { title: '问题标题' } }] }), entry);
  assert.equal(article.title, '问题标题'); assert.equal(article.sections[0].html, '<p>完整正文</p>');
  assert.throws(() => parseZhihuContent('{"data":[]}', entry), /未返回正文/);
  assert.throws(() => parseZhihuContent('{"error":{"code":100}}', entry), /拒绝访问/);
});
test('loads answers even when question HTML is just an empty shell', async () => {
  const urls: string[] = [];
  const providers = new Providers(async () => 'session=test', (async (url: string, init: RequestInit) => {
    urls.push(url); assert.equal((init.headers as Record<string, string>).Cookie, 'session=test');
    return new Response(JSON.stringify({ data: [{ content: '<p>回答正文</p>', author: { name: '作者' }, question: { title: '问题' } }] }));
  }) as typeof fetch);
  const article = await providers.article(parseLink('https://www.zhihu.com/question/123'));
  assert.equal(article.sections[0].html, '<p>回答正文</p>'); assert.equal(urls.length, 1); assert.match(urls[0], /\/api\/v4\/questions\/123\/answers/);
});
test('falls back to server HTML when the answers endpoint is blocked', async () => {
  let calls = 0;
  const providers = new Providers(async () => undefined, (async () => {
    calls++;
    return calls === 1 ? new Response('', { status: 403 }) : new Response('<h1>问题</h1><div class="AnswerItem"><div class="RichContent-inner"><div class="RichText">网页正文</div></div></div>');
  }) as typeof fetch);
  assert.match((await providers.article(parseLink('https://www.zhihu.com/question/123'))).sections[0].html, /网页正文/);
  assert.equal(calls, 2);
});
test('reports API and HTML failures together when both fail', async () => {
  const providers = new Providers(async () => undefined, (async () => new Response('', { status: 403 })) as typeof fetch);
  await assert.rejects(providers.article(parseLink('https://www.zhihu.com/question/123')), /回答接口：.*网页解析：/);
});
test('question answers preserve IDs, vote counts, total and next page', () => {
  const entry = parseLink('https://www.zhihu.com/question/123');
  const body = '{"data":[{"id":1969027955376807936,"content":"正文一","author":{"name":"甲"},"voteup_count":42,"question":{"title":"问题","answer_count":25}},{"id":"2","content":"正文二","author":{"name":"乙"}}],"paging":{"is_end":false,"next":"http://www.zhihu.com/api/v4/questions/123/answers?offset=10&limit=5"}}';
  const article = parseZhihuContent(body, entry);
  assert.equal(article.sections.length, 2); assert.equal(article.sections[0].id, '1969027955376807936');
  assert.equal(article.sections[0].votes, 42); assert.equal(article.totalAnswers, 25);
  assert.equal(article.sections[0].url, 'https://www.zhihu.com/question/123/answer/1969027955376807936');
  assert.equal(new URL(article.nextUrl!).searchParams.get('offset'), '10'); assert.match(article.nextUrl!, /^https:/);
});
test('question pagination rejects other hosts, questions and nonnumeric offsets', () => {
  const entry = parseLink('https://www.zhihu.com/question/123');
  for (const url of ['https://evil.com/api/v4/questions/123/answers?offset=10', 'https://www.zhihu.com/api/v4/questions/999/answers?offset=10', 'https://www.zhihu.com/api/v4/questions/123/answers?offset=abc', 'https://user@www.zhihu.com/api/v4/questions/123/answers?offset=10']) assert.equal(validateZhihuPage(url, entry), undefined);
  assert.equal(validateZhihuPage('https://www.zhihu.com/api/v4/questions/123/answers?offset=10', parseLink('https://www.zhihu.com/question/123/answer/2')), undefined);
});
test('does not offer exhausted or nonadvancing answer pages', () => {
  const entry = parseLink('https://www.zhihu.com/question/123');
  const data = [{ content: '正文' }];
  assert.equal(parseZhihuContent(JSON.stringify({ data, paging: { is_end: true, next: '/api/v4/questions/123/answers?offset=10' } }), entry).nextUrl, undefined);
  assert.equal(parseZhihuContent(JSON.stringify({ data, paging: { is_end: false, next: '/api/v4/questions/123/answers?offset=10' } }), entry, 'https://www.zhihu.com/api/v4/questions/123/answers?offset=10').nextUrl, undefined);
});
test('loads subsequent answer pages without repeating first-page HTML fallback', async () => {
  const entry = parseLink('https://www.zhihu.com/question/123'); let calls = 0;
  const providers = new Providers(async () => undefined, (async (url: unknown) => {
    calls++; assert.equal(new URL(String(url)).searchParams.get('offset'), '10');
    return new Response(JSON.stringify({ data: [{ id: '11', content: '下一页回答' }], paging: { is_end: true } }));
  }) as typeof fetch);
  assert.equal((await providers.article(entry, 'https://www.zhihu.com/api/v4/questions/123/answers?offset=10')).sections[0].html, '下一页回答');
  assert.equal(calls, 1);
  await assert.rejects(providers.article(entry, 'https://evil.com/?offset=10'), /无效/); assert.equal(calls, 1);
});
test('deduplicates overlapping answer pages by ID or identical content', () => {
  const sections = mergeSections([{ id: '1', author: '甲', html: '第一条' }, { author: '乙', html: '第二条' }], [{ id: '1', author: '甲', html: '更新的第一条' }, { id: '2', author: '乙', html: '第二条' }, { id: '3', author: '丙', html: '第三条' }]);
  assert.equal(sections.length, 3); assert.equal(sections[2].html, '第三条');
});
test('question reader renders answer navigation, cards and more button', () => {
  const article = { ...parseLink('https://www.zhihu.com/question/123'), totalAnswers: 20, nextUrl: 'https://www.zhihu.com/api/v4/questions/123/answers?offset=10', sections: [{ author: '甲', html: '<p>第一条</p>', votes: 99 }, { author: '乙', html: '<p>第二条</p>' }], fetchedAt: 1 };
  const html = renderArticle(article, { images: false, fontSize: 15, saved: false });
  assert.match(html, /共 20 个回答 · 已加载 2 个回答/); assert.match(html, /href="#answer-1"/); assert.match(html, /id="answer-1"/); assert.match(html, /99 赞同/); assert.match(html, /加载更多回答/); assert.match(html, /scrollIntoView/);
});
test('HTML fallback identifies partial results and offers API retry', () => {
  const entry = parseLink('https://www.zhihu.com/question/123');
  const article = parseZhihuArticle('<h1>问题</h1><div class="AnswerItem"><div class="RichContent-inner"><div class="RichText">网页回答</div></div></div>', entry);
  assert.equal(article.source, 'html'); assert.match(article.nextUrl!, /\/api\/v4\/questions\/123\/answers/);
  assert.match(renderArticle(article, { images: false, fontSize: 15, saved: false }), /当前显示网页返回的回答，可能只有一条/);
});
test('Zhihu direct answer only reads the requested answer', () => {
  const state = { initialState: { entities: { answers: { '2': { content: '<p>目标回答</p>', author: { name: '作者' } }, '3': { content: '<p>其他回答</p>' } } } } };
  const article = parseZhihuArticle(`<h1>问题</h1><script id="js-initialData" type="application/json">${JSON.stringify(state)}</script>`, parseLink('https://www.zhihu.com/question/1/answer/2'));
  assert.equal(article.sections.length, 1); assert.equal(article.sections[0].html, '<p>目标回答</p>');
});
test('parses server-rendered Zhihu content and reports missing content', () => {
  const entry = parseLink('https://www.zhihu.com/question/1');
  const article = parseZhihuArticle('<h1>问题</h1><div class="AnswerItem"><span class="AuthorInfo-name">作者</span><div class="RichContent-inner"><div class="RichText"><p>正文</p></div></div></div>', entry);
  assert.equal(article.sections[0].author, '作者'); assert.throws(() => parseZhihuArticle('<h1>登录</h1>', entry));
});
test('sanitizes executable content, attributes and command links', () => {
  const output = safeHtml('<script>alert(1)</script><svg onload="evil()"></svg><p onclick="evil()" style="color:red">安全正文</p><a href="command:evil">命令</a><iframe src="https://evil.com"></iframe><img src="https://evil.com/track">', false);
  assert.match(output, /安全正文/); assert.doesNotMatch(output, /script|onclick|onload|iframe|command:|evil\.com|style=/);
  assert.match(output, /图片已折叠/);
});
test('images must be HTTPS from known image domains', () => {
  const output = safeHtml('<img data-original="https://pic.zhimg.com/a.jpg" onerror="evil()"><img src="https://zhimg.com.evil.com/a.jpg"><img src="http://pic.zhimg.com/a.jpg">', true);
  assert.match(output, /src="https:\/\/pic.zhimg.com\/a.jpg"/); assert.doesNotMatch(output, /evil|http:/);
});
test('renderer escapes titles and authors and sets strict CSP', () => {
  const article = { ...parseLink('https://tieba.baidu.com/p/1'), title: '<script>bad()</script>', sections: [{ author: '<img onerror=bad()>', html: '<p>正文</p>' }], fetchedAt: 1 };
  const html = renderArticle(article, { images: false, fontSize: 999, saved: true, cached: true });
  assert.match(html, /default-src 'none'/); assert.match(html, /font-size:24px/); assert.match(html, /&lt;script&gt;/); assert.match(html, /取消收藏/); assert.match(html, /本机缓存/);
  assert.doesNotMatch(html, /<img onerror/);
});
test('network never follows redirects with cookies', async () => {
  let calls = 0;
  const fake = (async (_url: unknown, options: RequestInit) => { calls++; assert.equal(options.redirect, 'manual'); assert.equal((options.headers as Record<string, string>).Cookie, 'session=secret'); return new Response('', { status: 302, headers: { Location: 'https://evil.com' } }); }) as typeof fetch;
  await assert.rejects(request('https://www.zhihu.com/hot', 'zhihu', 'session=secret', fake), /平台要求/);
  assert.equal(calls, 1);
});
test('request rejects wrong host before sending credentials', async () => {
  const fake = (async () => { assert.fail('Must not send request'); }) as typeof fetch;
  await assert.rejects(request('https://evil.com/', 'zhihu', 'secret', fake), /非平台地址/);
});
test('detects HTTP 200 verification pages and HTTP authentication failures', async () => {
  for (const response of [new Response('<title>百度安全验证</title>'), new Response('', { status: 401 }), new Response('', { status: 429 })]) {
    await assert.rejects(request('https://tieba.baidu.com/p/1', 'tieba', undefined, (async () => response) as typeof fetch), /验证|登录/);
  }
});
test('network handles normal and oversized responses', async () => {
  assert.equal(await request('https://www.zhihu.com/hot', 'zhihu', undefined, (async () => new Response('hello')) as typeof fetch), 'hello');
  await assert.rejects(request('https://www.zhihu.com/hot', 'zhihu', undefined, (async () => new Response('a'.repeat(8 * 1024 * 1024 + 1))) as typeof fetch), /8 MB/);
});
