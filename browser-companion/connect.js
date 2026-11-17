const status = document.querySelector('#status');
let running = false;
let session = 0;
let workerTab;
const savedConnectionKey = 'hnovaFish.connection';
let connectionController;
let retryTimer;
let retryResolve;
function stopConnection() {
  running = false; session++;
  connectionController?.abort();
  clearTimeout(retryTimer); retryResolve?.();
}

async function getTab() {
  if (workerTab) {
    try {
      const tab = await chrome.tabs.get(workerTab);
      if (new URL(tab.url).origin === 'https://tieba.baidu.com') return tab;
    } catch { /* Find a current Tieba tab. */ }
  }
  const tab = await chrome.tabs.create({ url: 'https://tieba.baidu.com/', active: false });
  workerTab = tab.id;
  return tab;
}

function validReadUrl(input) {
  const url = new URL(input);
  if (url.origin !== 'https://tieba.baidu.com' || url.username || url.password || !/^\/(?:p\/\d+\/?|p\/comment|p\/totalComment|f|f\/index\/feedlist|mo\/q\/m)?$/.test(url.pathname)) throw new Error('请求超出贴吧阅读范围');
  return url.href;
}

async function readPage(url) {
  url = validReadUrl(url);
  const tab = await getTab();
  const pathname = new URL(url).pathname;
  const isPage = /^\/p\/\d+\/?$/.test(pathname) || ['/', '/f', '/mo/q/m'].includes(pathname);
  if (isPage) {
    const matchesTarget = actual => {
      try {
        const current = new URL(actual), expected = new URL(url);
        return current.origin === expected.origin && current.pathname === expected.pathname
          && ['kw', 'pn', 'kz'].every(key => current.searchParams.get(key) === expected.searchParams.get(key));
      } catch { return false; }
    };
    // Wait for navigation to commit, not for ads and other subresources to finish.
    await new Promise((resolve, reject) => {
      const finish = error => {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(updated);
        error ? reject(error) : resolve();
      };
      const updated = (id, change, current) => {
        if (id === tab.id && matchesTarget(current.url)) finish();
      };
      const timer = setTimeout(() => finish(new Error('贴吧目标地址尚未打开，请检查专用贴吧标签页是否出现登录或验证')), 12000);
      chrome.tabs.onUpdated.addListener(updated);
      (async () => {
        if (!matchesTarget(tab.url)) await chrome.tabs.update(tab.id, { url });
        const current = await chrome.tabs.get(tab.id);
        if (matchesTarget(current.url)) finish();
      })().catch(finish);
    });
    const pages = await chrome.scripting.executeScript({
      target: { tabId: tab.id }, args: [url],
      func: async target => {
        const expected = new URL(target);
        const actual = new URL(location.href);
        if (actual.origin !== expected.origin || actual.pathname !== expected.pathname || !['kw', 'pn', 'kz'].every(key => actual.searchParams.get(key) === expected.searchParams.get(key))) return { error: '贴吧发生跳转，请在浏览器检查登录或验证页面' };
        if (document.title.includes('安全验证')) return { error: '请在贴吧标签页手动完成安全验证，然后在 VS Code 重试' };
        const selector = /^\/p\/\d+/.test(expected.pathname)
          ? '.pb-content-wrap, .pb-comment-item, .d_post_content'
          : expected.pathname === '/mo/q/m'
            ? '.floor .content, .post-item .content, .content-text, .i, .threadlist_title a'
            : '.thread-card .thread-title, .j_th_tit, .threadlist_title a, .j_feed_li';
        // MutationObserver works when background-tab timers are throttled.
        const ready = () => [...document.querySelectorAll(selector)].some(node => node.textContent.trim() || node.querySelector('img'));
        if (!ready()) {
          const outcome = await new Promise(resolve => {
            const finish = result => { observer.disconnect(); clearTimeout(timer); resolve(result); };
            const observer = new MutationObserver(() => {
              if (document.title.includes('安全验证')) finish('verification');
              else if (ready()) finish('ready');
            });
            const timer = setTimeout(() => finish('timeout'), 10000);
            observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
            if (ready()) finish('ready');
          });
          if (outcome === 'verification') return { error: '请在贴吧标签页手动完成安全验证，然后在 VS Code 重试' };
          if (outcome !== 'ready') return { error: '贴吧已打开，但尚未出现可读取的帖子内容；请切到专用贴吧标签页确认页面正常，再重试' };
        }
        const body = document.documentElement.outerHTML;
        if (new TextEncoder().encode(body).length > 8 * 1024 * 1024) return { error: '贴吧页面超过 8 MB' };
        return { status: 200, body };
      }
    });
    return pages[0]?.result || { error: '无法读取贴吧页面' };
  }
  if (tab.status !== 'complete') throw new Error('贴吧页面尚未就绪，请在浏览器完成登录或验证后重试');
  const results = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    args: [validReadUrl(url)],
    func: async target => {
      try {
        if (location.origin !== 'https://tieba.baidu.com') return { error: '贴吧页面已离开，请重新打开贴吧' };
        if (document.title.includes('安全验证')) return { error: '请先在贴吧页面手动完成安全验证' };
        const response = await fetch(target, { credentials: 'include', redirect: 'error', signal: AbortSignal.timeout(15000) });
        const reader = response.body?.getReader();
        if (!reader) return { error: '贴吧返回空响应' };
        const parts = [];
        let size = 0;
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.length;
          if (size > 8 * 1024 * 1024) { await reader.cancel(); return { error: '响应超过 8 MB' }; }
          parts.push(value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const part of parts) { bytes.set(part, offset); offset += part.length; }
        return { status: response.status, body: new TextDecoder().decode(bytes) };
      } catch { return { error: '贴吧请求未成功，请在浏览器中打开目标帖子并检查登录、验证或网络状态' }; }
    }
  });
  return results[0]?.result || { error: '无法读取贴吧页面，请刷新该浏览器标签页' };
}

document.querySelector('#connect').onclick = async () => {
  stopConnection();
  const current = session;
  const controller = new AbortController();
  connectionController = controller;
  try {
    const url = new URL(document.querySelector('#address').value.trim());
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.username || url.password || !/^#[a-f0-9]{64}$/.test(url.hash)) throw new Error('请粘贴 VS Code 复制的完整连接地址');
    if (typeof localStorage !== 'undefined') localStorage.setItem(savedConnectionKey, url.href);
    const headers = { Authorization: `Bearer ${url.hash.slice(1)}` };
    const base = url.origin;
    await getTab();
    if (session !== current) return;
    running = true;
    status.dataset.error = '';
    document.querySelector('#connect').disabled = true;
    document.querySelector('#disconnect').disabled = false;
    while (running && session === current) {
      try {
        const response = await fetch(`${base}/next?wait=1`, { headers, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]) });
        if (session !== current || !running) break;
        if (response.status === 401) { if (typeof localStorage !== 'undefined') localStorage.removeItem(savedConnectionKey); throw new Error('连接地址已过期或不完整。请在 VS Code 重新运行“连接贴吧浏览器”，粘贴新地址。'); }
        if (response.status === 403) throw new Error('VS Code 拒绝了浏览器连接来源。请确认 VS Code 插件已更新到 0.1.22 或以上，并重新连接。');
        if (!response.ok) throw new Error(`本机连接失败（HTTP ${response.status}），请重新连接。`);
        if (response.status === 204) {
          if (!status.dataset.error) status.textContent = '已连接，等待 VS Code 的阅读请求。请保持此页打开。';
          continue;
        }
        const task = await response.json();
        if (session !== current || !running) break;
        status.textContent = '正在读取贴吧…';
        let result;
        try { result = await readPage(task.url); } catch (error) { result = { error: error.message }; }
        if (session !== current || !running) break;
        const posted = await fetch(`${base}/result`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: task.id, ...result }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5000)]) });
        if (session !== current || !running) break;
        if (!posted.ok && posted.status !== 410) throw new Error('返回阅读结果失败，请重新连接');
        const failed = result.error || result.status >= 400 || /<title>[^<]*安全验证/.test(result.body || '');
        status.dataset.error = failed ? 'true' : '';
        status.textContent = failed ? result.error || `贴吧返回 HTTP ${result.status} 或安全验证。请在浏览器打开目标帖子并完成验证，然后在 VS Code 重试。` : '读取成功，可以继续在 VS Code 阅读。';
      } catch (error) {
        if (session !== current || !running || controller.signal.aborted) break;
        if (!(error instanceof TypeError) && !['AbortError', 'TimeoutError'].includes(error.name)) throw error;
        status.dataset.error = '';
        status.textContent = 'VS Code 暂时断开，正在自动重连…（保持此页打开即可）';
        await new Promise(resolve => { retryResolve = resolve; retryTimer = setTimeout(resolve, 1500); });
        retryResolve = undefined;
      }
    }
  } catch (error) { if (session === current) status.textContent = error.message; }
  finally {
    if (session === current) {
      running = false;
      document.querySelector('#connect').disabled = false;
      document.querySelector('#disconnect').disabled = true;
    }
  }
};
document.querySelector('#disconnect').onclick = () => {
  stopConnection();
  if (typeof localStorage !== 'undefined') localStorage.removeItem(savedConnectionKey);
  status.textContent = '已断开';
  document.querySelector('#connect').disabled = false;
  document.querySelector('#disconnect').disabled = true;
};
document.querySelector('#tieba').onclick = async () => {
  const tab = await getTab();
  await chrome.tabs.update(tab.id, { active: true });
  await chrome.windows.update(tab.windowId, { focused: true });
};

// Extension pages share their own isolated storage, never a website's storage.
if (typeof localStorage !== 'undefined') {
  const saved = localStorage.getItem(savedConnectionKey);
  if (saved) {
    document.querySelector('#address').value = saved;
    void document.querySelector('#connect').onclick();
  }
}
