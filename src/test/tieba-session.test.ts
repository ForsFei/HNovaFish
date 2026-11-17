import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tiebaSessionFetch } from '../tiebaSession';

test('direct requests ignore copied bare undefined placeholders while preserving real cookie pairs', async () => {
  const request = tiebaSessionFetch({ get: async () => undefined, store: async () => {} }, (async (_input: unknown, init?: RequestInit) => {
    const cookie = new Headers(init?.headers).get('cookie')!;
    assert.match(cookie, /BDUSS=test/); assert.match(cookie, /undefined=valid/);
    assert.ok(!cookie.split(';').some(part => part.trim() === 'undefined'));
    return new Response('ok');
  }) as typeof fetch, 0);
  assert.equal((await request('https://tieba.baidu.com/p/1', { headers: { Cookie: 'BDUSS=test; undefined; undefined=valid; null;' } })).status, 200);
});

test('Tieba session updates cookies, respects their scope, persists and resets on Cookie replacement', async () => {
  const values = new Map<string, string>();
  const secrets = { get: async (key: string) => values.get(key), store: async (key: string, value: string) => { values.set(key, value); } };
  const cookies: string[] = [];
  let count = 0;
  const fetcher = (async (_input: unknown, init?: RequestInit) => {
    cookies.push(new Headers(init?.headers).get('cookie') || '');
    assert.equal(init?.redirect, 'manual');
    const headers = new Headers();
    if (count++ === 0) {
      headers.append('Set-Cookie', 'BDUSS=renewed; Path=/; Secure; HttpOnly');
      headers.append('Set-Cookie', 'page=one; Path=/p/; Secure');
      headers.append('Set-Cookie', 'bad=value; Domain=evil.com; Path=/');
    }
    return new Response('ok', { headers });
  }) as typeof fetch;
  let request = tiebaSessionFetch(secrets, fetcher, 0);
  const options = { headers: { Cookie: 'BDUSS=initial' } };
  await request('https://tieba.baidu.com/p/1', options);
  await request('https://tieba.baidu.com/p/2', options);
  assert.match(cookies[1], /BDUSS=renewed/); assert.match(cookies[1], /page=one/); assert.ok(!cookies[1].includes('bad='));
  request = tiebaSessionFetch(secrets, fetcher, 0);
  await request('https://tieba.baidu.com/f?kw=test', options);
  assert.match(cookies[2], /BDUSS=renewed/); assert.ok(!cookies[2].includes('page='));
  await request('https://tieba.baidu.com/p/2', { headers: { Cookie: 'BDUSS=replaced' } });
  assert.equal(cookies[3], 'BDUSS=replaced');
});

test('Tieba queue prevents concurrent requests and remains usable after failures', async () => {
  let active = 0, maximum = 0, calls = 0;
  const request = tiebaSessionFetch({ get: async () => undefined, store: async () => {} }, (async () => {
    active++; maximum = Math.max(active, maximum);
    await new Promise(resolve => setTimeout(resolve, 5));
    active--;
    if (calls++ === 0) throw new Error('Network failure');
    return new Response('ok');
  }) as typeof fetch, 0);
  const results = await Promise.allSettled([request('https://tieba.baidu.com/p/1'), request('https://tieba.baidu.com/p/2')]);
  assert.equal(maximum, 1); assert.equal(results[0].status, 'rejected'); assert.equal(results[1].status, 'fulfilled');
});
