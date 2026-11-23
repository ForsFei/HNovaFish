import { randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';

export function browserReadUrl(input: string): string {
  const url = new URL(input);
  const allowed = /^\/(?:p\/\d+\/?|p\/comment|p\/totalComment|f|f\/index\/feedlist|mo\/q\/m)?$/;
  if (url.protocol !== 'https:' || url.hostname !== 'tieba.baidu.com' || url.port || url.username || url.password || !allowed.test(url.pathname)) throw new Error('浏览器协同仅允许读取贴吧列表、帖子和回复。');
  return url.href;
}

export interface BrowserPairing { port: number; token: string; origin?: string; }
export function parseBrowserPairing(value?: string): BrowserPairing | undefined {
  try {
    const data = JSON.parse(value || 'null');
    if (!data || !Number.isInteger(data.port) || data.port < 1 || data.port > 65535
      || typeof data.token !== 'string' || !/^[a-f0-9]{64}$/.test(data.token)
      || data.origin !== undefined && !/^chrome-extension:\/\/[a-p]{32}$/.test(data.origin)) return;
    return { port: data.port, token: data.token, origin: data.origin };
  } catch { return; }
}

interface Pending {
  id: string;
  url: string;
  sent: boolean;
  resolve(value: Response): void;
  reject(error: Error): void;
}

export class BrowserBridge {
  private readonly token: string;
  private origin: string | undefined;
  private pairedAt = 0;
  private wakePoll: (() => void) | undefined;
  private readonly pairWaiters = new Set<{ resolve(): void; reject(error: Error): void }>();
  private readonly pending = new Map<string, Pending>();
  private readonly server = createServer((request, response) => { void this.handle(request, response); });

  constructor(private readonly saved?: BrowserPairing, private readonly onPair?: (pairing: BrowserPairing) => Promise<void>, private readonly reconnectWaitMs = 0) {
    this.token = saved?.token || randomBytes(32).toString('hex');
    this.origin = saved?.origin;
  }

  get pairing(): BrowserPairing {
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('浏览器连接服务尚未启动。');
    return { port: address.port, token: this.token, origin: this.origin };
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.saved?.port || 0, '127.0.0.1', () => { this.server.removeListener('error', reject); resolve(); });
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('浏览器连接服务启动失败。');
    return `http://127.0.0.1:${address.port}/#${this.token}`;
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = browserReadUrl(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (init?.method && init.method !== 'GET' || init?.body) throw new Error('浏览器协同只支持读取。');
    if (Date.now() - this.pairedAt > 45000 && this.reconnectWaitMs) {
      init?.signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        const finish = (error?: Error) => {
          clearTimeout(timer); this.pairWaiters.delete(waiter);
          init?.signal?.removeEventListener('abort', aborted);
          error ? reject(error) : resolve();
        };
        const waiter = { resolve: () => finish(), reject: (error: Error) => finish(error) };
        const aborted = () => finish(new Error('浏览器读取已取消。'));
        const timer = setTimeout(() => finish(new Error('正在等待浏览器自动重连，请保持 Edge 配套连接页打开；首次使用请手动配对一次。')), this.reconnectWaitMs);
        this.pairWaiters.add(waiter);
        init?.signal?.addEventListener('abort', aborted, { once: true });
      });
    }
    if (Date.now() - this.pairedAt > 45000) throw new Error('浏览器尚未连接。请保持 Edge 配套扩展的连接页面打开，并点击连接。');
    if (this.pending.size >= 16) throw new Error('等待浏览器的请求过多，请稍后重试。');
    init?.signal?.throwIfAborted();
    return new Promise<Response>((resolve, reject) => {
      const id = randomBytes(16).toString('hex');
      const finish = () => { clearTimeout(timer); this.pending.delete(id); init?.signal?.removeEventListener('abort', abort); };
      const abort = () => {
        finish();
        const timedOut = init?.signal?.reason?.name === 'TimeoutError';
        reject(new Error(timedOut ? '等待 Edge 返回楼层超时，请切到贴吧标签页后重试。' : '浏览器读取已取消。'));
      };
      const timer = setTimeout(() => { finish(); reject(new Error('浏览器读取超时，请在 Edge 中检查贴吧登录或验证页面。')); }, 45000);
      this.pending.set(id, { id, url, sent: false, resolve: value => { finish(); resolve(value); }, reject: error => { finish(); reject(error); } });
      init?.signal?.addEventListener('abort', abort, { once: true });
      this.wakePoll?.();
    });
  };

  dispose(): void {
    for (const waiter of this.pairWaiters) waiter.reject(new Error('浏览器连接已关闭。'));
    for (const item of this.pending.values()) item.reject(new Error('浏览器连接已关闭。'));
    this.wakePoll?.();
    this.server.close();
    this.server.closeAllConnections();
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const origin = request.headers.origin || '';
    // Privileged extension GETs may omit Origin. The bearer token remains
    // mandatory; explicit website origins are rejected, including preflights.
    const address = this.server.address();
    const expectedHost = address && typeof address !== 'string' ? `127.0.0.1:${address.port}` : '';
    if (request.headers.host !== expectedHost) { response.writeHead(403).end(); return; }
    const validOrigin = !origin || /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
    if (!validOrigin || origin && this.origin && this.origin !== origin) {
      response.writeHead(403, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'origin_rejected' })); return;
    }
    if (origin) response.setHeader('Access-Control-Allow-Origin', origin);
    response.setHeader('Vary', 'Origin');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') {
      response.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      response.setHeader('Access-Control-Allow-Methods', 'GET, POST');
      response.writeHead(204).end(); return;
    }
    const supplied = request.headers.authorization || '';
    const expected = `Bearer ${this.token}`;
    const actualBytes = Buffer.from(supplied);
    const expectedBytes = Buffer.from(expected);
    if (actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) {
      response.writeHead(401, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'token_invalid' })); return;
    }
    if (origin && !this.origin) {
      try { await this.onPair?.({ ...this.pairing, origin }); }
      catch { response.writeHead(503).end(); return; }
      this.origin = origin;
    }
    this.pairedAt = Date.now();
    for (const waiter of this.pairWaiters) waiter.resolve();
    if (request.method === 'GET' && (request.url === '/next' || request.url === '/next?wait=1')) {
      const available = () => [...this.pending.values()].find(value => !value.sent);
      if (!available() && request.url === '/next?wait=1') {
        this.wakePoll?.();
        await new Promise<void>(resolve => {
          const finish = () => {
            clearTimeout(timer);
            response.removeListener('close', finish);
            if (this.wakePoll === finish) this.wakePoll = undefined;
            resolve();
          };
          const timer = setTimeout(finish, 20000);
          this.wakePoll = finish;
          response.once('close', finish);
        });
      }
      if (response.destroyed) return;
      const item = available();
      if (!item) { response.writeHead(204).end(); return; }
      item.sent = true;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ id: item.id, url: item.url })); return;
    }
    if (request.method !== 'POST' || request.url !== '/result') { response.writeHead(404).end(); return; }
    try {
      let size = 0;
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 12 * 1024 * 1024) { response.writeHead(413).end(); request.destroy(); return; }
        chunks.push(Buffer.from(chunk));
      }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const item = this.pending.get(result.id);
      if (!item) { response.writeHead(410).end(); return; }
      if (typeof result.error === 'string') {
        const messages = new Map([
          ['floor_position', '浏览器中的帖子位置已变化，请重新加载正文后继续。'],
          ['floor_verification', '请在 Edge 的贴吧标签页完成安全验证，再重试加载楼层。'],
          ['floor_timeout', '暂未取得更多楼层，请切到 Edge 的贴吧标签页后重试。'],
        ]);
        item.reject(new Error(messages.get(result.code) || '浏览器读取失败，请在配套扩展连接页查看原因。'));
      }
      else if (typeof result.body === 'string' && Buffer.byteLength(result.body) <= 8 * 1024 * 1024 && Number.isInteger(result.status) && result.status >= 200 && result.status <= 599) {
        item.resolve(new Response([204, 205, 304].includes(result.status) ? null : result.body, { status: result.status }));
      } else { response.writeHead(400).end(); return; }
      response.writeHead(204).end();
    } catch { if (!response.headersSent) response.writeHead(400).end(); }
  }
}
