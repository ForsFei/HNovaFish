import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Providers, parseTiebaArticle, validateTiebaPage } from '../providers';
import { parseLink } from '../model';

test('Tieba retries mobile list after desktop verification and uses the same cookie and browser headers', async () => {
  const urls: string[] = [];
  const provider = new Providers(async () => 'BDUSS=test', (async (input: unknown, options: RequestInit) => {
    const url = String(input); urls.push(url);
    const headers = options.headers as Record<string, string>;
    assert.equal(headers.Cookie, 'BDUSS=test'); assert.equal(headers['User-Agent'], 'UserBrowser/145');
    assert.equal(headers.Referer, 'https://tieba.baidu.com/'); assert.equal(options.redirect, 'manual');
    return urls.length === 1 ? new Response('<title>百度安全验证</title>', { status: 403 }) : new Response('<a href="/mo/q/m?kz=123">移动版帖子标题</a>');
  }) as typeof fetch, () => 'UserBrowser/145');
  const list = await provider.list('tieba', '图拉丁', 1);
  assert.equal(urls.length, 2); assert.match(urls[1], /\/mo\/q\/m\?/); assert.equal(new URL(urls[1]).searchParams.get('kw'), '图拉丁');
  assert.equal(list[0].url, 'https://tieba.baidu.com/p/123');
});
test('Tieba parses successful desktop lists without unnecessary fallback', async () => {
  let calls = 0;
  const provider = new Providers(async () => undefined, (async () => { calls++; return new Response('<a href="/p/123" title="正常帖子标题">标题</a>'); }) as typeof fetch);
  assert.equal((await provider.list('tieba')).length, 1); assert.equal(calls, 1);
});
test('Tieba reports HTTP status and login field presence without exposing cookies', async () => {
  for (const [cookie, message] of [[undefined, '未设置贴吧 Cookie'], ['visitor=secret', '未发现 BDUSS'], ['BDUSS=secret', '含百度登录字段']] as const) {
    const provider = new Providers(async () => cookie, (async () => new Response('', { status: 403 })) as typeof fetch);
    await assert.rejects(provider.list('tieba'), error => {
      const text = (error as Error).message;
      assert.match(text, /桌面版：.*HTTP 403.*移动版：.*HTTP 403/); assert.ok(text.includes(message)); assert.ok(!text.includes('secret')); return true;
    });
  }
});
test('Tieba article requests also use the configured browser identity', async () => {
  const provider = new Providers(async () => 'BDUSS=test', (async (_input: unknown, options: RequestInit) => {
    assert.equal((options.headers as Record<string, string>)['User-Agent'], 'UserBrowser/145');
    return new Response('<div class="l_post"><div class="d_post_content">正文</div></div>');
  }) as typeof fetch, () => 'UserBrowser/145');
  assert.equal((await provider.article({ id: 'tieba:/p/123', site: 'tieba', title: '帖子', url: 'https://tieba.baidu.com/p/123' })).sections[0].html, '正文');
});
test('Tieba article falls back when desktop returns a shell with no floors', async () => {
  const urls: string[] = [];
  const provider = new Providers(async () => 'BDUSS=test', (async (input: unknown) => {
    urls.push(String(input));
    return new Response(urls.length === 1 ? '<title>百度贴吧</title><div id="app"></div>' : '<h1>真实问题标题</h1><div class="floor"><span class="user_name">楼主</span><div class="content">移动版正文</div></div><a href="/mo/q/m?kz=11144270935&pn=20">下一页</a>');
  }) as typeof fetch);
  const article = await provider.article(parseLink('https://tieba.baidu.com/p/11144270935'));
  assert.equal(urls.length, 2); assert.equal(urls[1], 'https://tieba.baidu.com/mo/q/m?kz=11144270935');
  assert.equal(article.sections[0].html, '移动版正文'); assert.equal(article.sections[0].author, '楼主');
  assert.equal(article.nextUrl, 'https://tieba.baidu.com/mo/q/m?kz=11144270935&pn=20');
});
test('Tieba mobile pagination keeps its own cursor and does not guess desktop pages', async () => {
  const urls: string[] = [];
  const provider = new Providers(async () => undefined, (async (input: unknown) => {
    urls.push(String(input)); return new Response('<div class="floor"><div class="content">下一页回复</div></div><a href="?kz=123&pn=40">下页</a>');
  }) as typeof fetch);
  const article = await provider.article(parseLink('https://tieba.baidu.com/p/123'), 'https://tieba.baidu.com/mo/q/m?kz=123&pn=20');
  assert.deepEqual(urls, ['https://tieba.baidu.com/mo/q/m?kz=123&pn=20']); assert.equal(article.nextUrl, 'https://tieba.baidu.com/mo/q/m?kz=123&pn=40');
  await assert.rejects(provider.article(parseLink('https://tieba.baidu.com/p/123'), 'https://tieba.baidu.com/p/999?pn=2'), /无效/); assert.equal(urls.length, 1);
});
test('Tieba reads commented desktop floors, standalone content and image-only posts', () => {
  const entry = parseLink('https://tieba.baidu.com/p/123');
  const commented = parseTiebaArticle('<!-- <div class="l_post"><span class="p_author_name">甲</span><div class="d_post_content">隐藏在注释的正文</div></div> -->', entry);
  assert.equal(commented.sections[0].author, '甲'); assert.equal(commented.sections[0].html, '隐藏在注释的正文');
  assert.equal(parseTiebaArticle('<div class="d_post_content"><img src="https://img.baidu.com/a.jpg"></div>', entry).sections.length, 1);
});
test('Tieba legacy WAP floors preserve text and author without mistaking generic content for a post', () => {
  const entry = parseLink('https://tieba.baidu.com/p/123');
  const article = parseTiebaArticle('<div class="i"><a href="/home?un=test">吧友甲</a><br>正文内容<br>1楼 2026-10-28</div>', entry);
  assert.equal(article.sections[0].author, '吧友甲'); assert.match(article.sections[0].html, /正文内容/);
  assert.throws(() => parseTiebaArticle('<div class="content">登录百度 / 打开 App</div>', entry), /未返回可识别/);
  assert.throws(() => parseTiebaArticle('<p>帖子已被删除</p>', entry), /已删除/);
});
test('Tieba pagination rejects unrelated or nonadvancing destinations', () => {
  const entry = parseLink('https://tieba.baidu.com/p/123');
  for (const next of ['https://evil.com/p/123?pn=2', 'https://tieba.baidu.com/mo/q/m?kz=999&pn=20', 'https://user@tieba.baidu.com/p/123?pn=2']) assert.equal(validateTiebaPage(next, entry), undefined);
  const html = '<div class="d_post_content">正文</div><a href="/p/123?pn=2">下一页</a>';
  assert.equal(parseTiebaArticle(html, entry, 'https://tieba.baidu.com/p/123?pn=2').nextUrl, undefined);
});
test('Tieba body failures report both attempts without claiming the cookie must be wrong', async () => {
  const provider = new Providers(async () => 'BDUSS=private', (async () => new Response('<div id="app"></div>')) as typeof fetch);
  await assert.rejects(provider.article(parseLink('https://tieba.baidu.com/p/123')), error => {
    const text = (error as Error).message;
    assert.match(text, /桌面版：.*移动版：/); assert.ok(!text.includes('private')); return true;
  });
});
