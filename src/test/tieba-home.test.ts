import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseTiebaHome, tiebaHomePage, tiebaHomeUrl, Providers } from '../providers';
import { forumName } from '../forums';

test('Tieba homepage parses feed HTML and supplies the next server page', () => {
  const page = parseTiebaHome(JSON.stringify({ no: 0, error: 'sucess', data: { html: '<a href="/p/123" title="首页推荐标题">标题</a>', has_more: 1 } }), 2);
  assert.equal(page.entries[0].url, 'https://tieba.baidu.com/p/123'); assert.equal(page.nextUrl, tiebaHomeUrl(3));
});
test('Tieba homepage pagination rejects unrelated URLs and invalid pages', () => {
  assert.equal(tiebaHomePage(), 1);
  for (const url of ['https://evil.com/f/index/feedlist?pn=2', 'https://tieba.baidu.com/f?pn=2', 'https://tieba.baidu.com/f/index/feedlist?pn=-1', 'https://tieba.baidu.com/f/index/feedlist?pn=nan']) assert.throws(() => tiebaHomePage(url));
});
test('Tieba homepage requests use saved login and configured browser headers', async () => {
  const provider = new Providers(async () => 'BDUSS=test', (async (input: unknown, options: RequestInit) => {
    assert.equal(String(input), tiebaHomeUrl(2));
    assert.equal((options.headers as Record<string, string>).Cookie, 'BDUSS=test'); assert.equal((options.headers as Record<string, string>)['User-Agent'], 'UserBrowser/145');
    return new Response(JSON.stringify({ no: 0, data: { html: '<a href="/p/123">推荐帖子标题</a>', has_more: false } }));
  }) as typeof fetch, () => 'UserBrowser/145');
  assert.equal((await provider.tiebaHome('https://tieba.baidu.com/f/index/feedlist?pn=2')).entries.length, 1);
});
test('Tieba homepage can fall back to readable homepage HTML without substituting a forum list', async () => {
  const urls: string[] = [];
  const provider = new Providers(async () => undefined, (async (input: unknown) => {
    urls.push(String(input));
    return urls.length === 1 ? new Response('{"no":0,"data":{"html":"","has_more":0}}') : new Response('<a href="/p/123">首页网页推荐帖子</a>');
  }) as typeof fetch);
  assert.equal((await provider.tiebaHome()).entries[0].title, '首页网页推荐帖子'); assert.deepEqual(urls, [tiebaHomeUrl(1), 'https://tieba.baidu.com/']);
});
test('Tieba homepage shows a real failure if both sources are restricted', async () => {
  const provider = new Providers(async () => 'BDUSS=test', (async () => new Response('', { status: 403 })) as typeof fetch);
  await assert.rejects(provider.tiebaHome(), /首页推荐加载失败.*接口：.*网页：/);
});
test('forum browsing accepts exact names and valid list links only', () => {
  assert.equal(forumName('  图拉丁  '), '图拉丁');
  assert.equal(forumName('https://tieba.baidu.com/f?kw=%E7%94%B5%E5%BD%B1'), '电影');
  for (const input of ['', 'https://evil.com/f?kw=电影', 'https://tieba.baidu.com/p/123', 'https://user@tieba.baidu.com/f?kw=电影', 'bad\nname']) assert.throws(() => forumName(input));
});
test('Tieba homepage always sends recommendation parameters and preserves the last thread cursor', () => {
  const first = new URL(tiebaHomeUrl());
  assert.equal(first.searchParams.get('is_new'), '1'); assert.equal(first.searchParams.get('tag_id'), 'like');
  const page = parseTiebaHome('{"no":0,"data":{"html":"<a href=/p/123>推荐帖子标题</a>","has_more":1,"last_tid":1969027955376807936}}');
  const next = new URL(page.nextUrl!);
  assert.equal(next.searchParams.get('last_tid'), '1969027955376807936');
  assert.equal(next.searchParams.get('is_new'), '1'); assert.equal(next.searchParams.get('tag_id'), 'like');
});
test('Tieba homepage parses actual feed cards and excludes advertising and unrelated links', () => {
  const html = '<li class="j_feed_li"><a href="/p/999">其他链接</a><a class="feed-forum-link" title="图拉丁">图拉丁吧</a><div class="thread-name-wraper"><a class="feed-item-link" href="/p/123?frwh=index" title="推荐标题">标题</a></div><div class="n_txt">推荐摘要</div></li><li class="j_feed_li home-place-item"><div class="thread-name-wraper"><a href="/p/888">推广内容</a></div></li>';
  const page = parseTiebaHome(JSON.stringify({ no: 0, data: { html, has_more: 0 } }));
  assert.equal(page.entries.length, 1); assert.equal(page.entries[0].url, 'https://tieba.baidu.com/p/123');
  assert.equal(page.entries[0].description, '图拉丁'); assert.equal(page.entries[0].summary, '推荐摘要');
});
