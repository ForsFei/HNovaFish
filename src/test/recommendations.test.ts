import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Providers, parseRecommendations, validateRecommendationUrl, ZHIHU_RECOMMEND_URL } from '../providers';
import { renderArticle } from '../render';
import { parseLink } from '../model';

test('Zhihu and Tieba batches collect 30 unique recommendations across server pages and retain the next cursor', async () => {
  for (const source of ['recommend', 'tiebaHome'] as const) {
    let calls = 0;
    const provider = new Providers(async () => 'session=test', (async (input: any) => {
      calls++;
      const url = new URL(String(input));
      const page = Number(url.searchParams.get(source === 'recommend' ? 'page_number' : 'pn') || 1);
      const ids = Array.from({ length: 10 }, (_, i) => (page - 1) * 8 + i + 1);
      return new Response(JSON.stringify(source === 'recommend'
        ? { data: ids.map(id => ({ target: { type: 'article', id, title: `推荐${id}` } })), paging: { next: `/api/v3/feed/topstory/recommend?page_number=${page + 1}` } }
        : { no: 0, data: { html: ids.map(id => `<a href="/p/${id}">推荐${id}</a>`).join(''), has_more: 1 } }));
    }) as typeof fetch);
    const result = await provider.recommendationBatch(source);
    assert.equal(result.entries.length, 30);
    assert.equal(new Set(result.entries.map(item => item.id)).size, 30);
    assert.equal(calls, 4);
    assert.equal(new URL(result.nextUrl!).searchParams.get(source === 'recommend' ? 'page_number' : 'pn'), '5');
  }
});

test('a failed later recommendation page preserves the successful items and leaves its cursor for retry', async () => {
  const provider = new Providers(async () => 'session=test', (async (input: any) => new URL(String(input)).searchParams.get('page_number') === '2'
    ? new Response('', { status: 403 })
    : new Response(JSON.stringify({ data: [{ target: { type: 'article', id: 1, title: '可读推荐' } }], paging: { next: '/api/v3/feed/topstory/recommend?page_number=2' } }))) as typeof fetch);
  const result = await provider.recommendationBatch('recommend');
  assert.equal(result.entries[0].title, '可读推荐');
  assert.equal(new URL(result.nextUrl!).searchParams.get('page_number'), '2');
});

test('parses recommendation answers, articles and questions while keeping platform order', () => {
  const result = parseRecommendations(JSON.stringify({ data: [
    { target: { type: 'answer', id: '99', question: { id: '12', title: '推荐问题' }, author: { name: '作者甲' }, excerpt: '<p>回答摘要</p>' } },
    { target: { type: 'article', id: '88', title: '推荐文章', author: { name: '作者乙' } } },
    { target: { type: 'question', id: '77', title: '另一个问题' } }
  ] }));
  assert.deepEqual(result.entries.map(e => e.url), ['https://www.zhihu.com/question/12/answer/99', 'https://zhuanlan.zhihu.com/p/88', 'https://www.zhihu.com/question/77']);
  assert.equal(result.entries[0].description, '回答 · 作者甲'); assert.equal(result.entries[0].summary, '回答摘要');
});
test('preserves numeric recommendation IDs without rounding', () => {
  const page = parseRecommendations('{"data":[{"target":{"type":"answer","id":1969027955376807936,"question":{"id":1969027955376807937,"title":"长 ID 推荐"}}}]}');
  assert.equal(page.entries[0].url, 'https://www.zhihu.com/question/1969027955376807937/answer/1969027955376807936');
});
test('filters ads, unsupported types and malformed items and deduplicates answers', () => {
  const answer = { target: { type: 'answer', id: 1, question: { id: 2, title: '正常问题' }, url: 'https://evil.com/' } };
  const page = parseRecommendations(JSON.stringify({ data: [null, {}, answer, answer, { type: 'commercial', ...answer }, { is_ad: true, ...answer }, { target: { type: 'zvideo', id: 3, title: '视频' } }, { target: { type: 'answer', id: 'bad', question: { id: 2, title: '无效' } } }] }));
  assert.equal(page.entries.length, 1); assert.equal(page.entries[0].url, 'https://www.zhihu.com/question/2/answer/1');
});
test('accepts only recommendation pagination on the same platform endpoint', () => {
  for (const url of ['https://evil.com/api/v3/feed/topstory/recommend', 'https://www.zhihu.com/api/v4/me', 'https://user:password@www.zhihu.com/api/v3/feed/topstory/recommend', 'https://www.zhihu.com:8443/api/v3/feed/topstory/recommend', 'javascript:alert(1)']) assert.equal(validateRecommendationUrl(url), undefined);
  const next = 'http://www.zhihu.com/api/v3/feed/topstory/recommend?after_id=opaque%3A2&session_token=abc&page_number=2';
  assert.equal(validateRecommendationUrl(next), next.replace('http:', 'https:'));
});
test('honors recommendation end state and does not replay the current page', () => {
  const next = 'https://www.zhihu.com/api/v3/feed/topstory/recommend?after_id=20&page_number=2';
  assert.equal(parseRecommendations(JSON.stringify({ data: [], paging: { is_end: false, next } })).nextUrl, next);
  assert.equal(parseRecommendations(JSON.stringify({ data: [], paging: { is_end: true, next } })).nextUrl, undefined);
  assert.equal(parseRecommendations(JSON.stringify({ data: [], paging: { next: ZHIHU_RECOMMEND_URL } })).nextUrl, undefined);
});
test('requires configured login and rejects bad pagination before network access', async () => {
  let calls = 0;
  const provider = new Providers(async () => undefined, (async () => { calls++; return new Response('{}'); }) as typeof fetch);
  await assert.rejects(provider.recommendations(), /需要知乎登录/);
  await assert.rejects(provider.recommendations('https://evil.com'), /无效/); assert.equal(calls, 0);
});
test('requests the personalized endpoint with the configured cookie and server cursor', async () => {
  const urls: string[] = [];
  const next = 'https://www.zhihu.com/api/v3/feed/topstory/recommend?after_id=opaque-1&page_number=2&session_token=server-session';
  const provider = new Providers(async site => { assert.equal(site, 'zhihu'); return 'session=test'; }, (async (input: unknown, options: RequestInit) => {
    const url = String(input); urls.push(url);
    assert.equal((options.headers as Record<string, string>).Cookie, 'session=test'); assert.equal(options.redirect, 'manual');
    return new Response(JSON.stringify({ data: [{ target: { type: 'article', id: urls.length, title: `文章 ${urls.length}` } }], paging: { is_end: urls.length > 1, next } }));
  }) as typeof fetch);
  const first = await provider.recommendations(); const second = await provider.recommendations(first.nextUrl);
  assert.equal(urls[0], ZHIHU_RECOMMEND_URL); assert.equal(urls[1], next); assert.equal(second.nextUrl, undefined);
});
test('does not silently substitute a hot list for failed recommendations', async () => {
  let calls = 0;
  const provider = new Providers(async () => 'session=test', (async () => { calls++; return new Response('', { status: 401 }); }) as typeof fetch);
  await assert.rejects(provider.recommendations(), /平台要求/); assert.equal(calls, 1);
  assert.throws(() => parseRecommendations('{"error":{"code":401}}'), /推荐接口拒绝访问/);
  assert.throws(() => parseRecommendations('{}'), /格式已变化/);
});
test('recommended answer provides a route to other answers under the question', () => {
  const html = renderArticle({ ...parseLink('https://www.zhihu.com/question/12/answer/99'), sections: [{ author: '作者', html: '正文' }], fetchedAt: 1 }, { images: false, fontSize: 15, saved: false });
  assert.match(html, /data-action="question">查看问题的其他回答/);
});
