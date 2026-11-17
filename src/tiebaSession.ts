import { createHash } from 'node:crypto';
import { CookieJar } from 'tough-cookie';

interface SecretStore {
  get(key: string): PromiseLike<string | undefined>;
  store(key: string, value: string): PromiseLike<void>;
}

// All Tieba adapters share this session, including comments and previews.
export function tiebaSessionFetch(secrets: SecretStore, fetcher: typeof fetch, interval = 800): typeof fetch & { reset(): void } {
  let queue = Promise.resolve();
  let jar: CookieJar | undefined;
  let cookieHash: string | undefined;
  let lastRequest = 0;
  let revision = 0;
  const sessionKey = 'cookie.tieba.session';

  const sessionFetch = (async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.protocol !== 'https:' || url.hostname !== 'tieba.baidu.com' || url.port || url.username || url.password) return fetcher(input, init);
    const run = async () => {
      const ticket = revision;
      let activeJar = jar;
      const headers = new Headers(init?.headers);
      const cookie = headers.get('cookie') || '';
      const hash = createHash('sha256').update(cookie).digest('hex');
      if (!activeJar || cookieHash !== hash) {
        activeJar = undefined;
        try {
          const saved = JSON.parse(await secrets.get(sessionKey) || 'null');
          if (saved?.hash === hash) activeJar = CookieJar.deserializeSync(saved.jar);
        } catch { /* A missing or outdated session is rebuilt from the supplied Cookie. */ }
        if (!activeJar) {
          activeJar = new CookieJar();
          for (const part of cookie.split(';')) {
            // Some copied request headers contain a bare JS placeholder.
            // Real cookies named "undefined" with an '=' remain valid.
            if (!part.trim() || /^(?:undefined|null)$/.test(part.trim())) continue;
            try { await activeJar.setCookie(`${part.trim()}; Path=/; Secure`, url.origin); }
            catch { throw new Error('贴吧 Cookie 格式无效，请重新复制单行 Cookie 值。'); }
          }
        }
        if (ticket === revision) { jar = activeJar; cookieHash = hash; }
      }
      const delay = Math.max(0, lastRequest + interval - Date.now());
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      init?.signal?.throwIfAborted();
      const currentCookie = await activeJar.getCookieString(url.href);
      if (currentCookie) headers.set('Cookie', currentCookie);
      else headers.delete('Cookie');
      lastRequest = Date.now();
      const response = await fetcher(input, { ...init, headers, redirect: 'manual' });
      const updates = response.headers.getSetCookie();
      for (const update of updates) {
        // Ignore cookies rejected by domain/security rules without exposing values.
        await activeJar.setCookie(update, url.href, { ignoreError: true });
      }
      if (updates.length && ticket === revision) await secrets.store(sessionKey, JSON.stringify({ hash, jar: await activeJar.serialize() }));
      return response;
    };
    const pending = queue.then(run);
    queue = pending.then(() => undefined, () => undefined);
    return pending;
  }) as typeof fetch;
  return Object.assign(sessionFetch, { reset() { revision++; jar = undefined; cookieHash = undefined; } });
}
