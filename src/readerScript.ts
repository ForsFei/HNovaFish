declare const acquireVsCodeApi: () => {
  getState(): { url?: string; scroll?: number } | undefined;
  setState(state: { url: string; scroll: number }): void;
  postMessage(message: { action: string; url?: string; section?: number; comment?: string }): void;
};

// This function is serialized into the Webview. Keep all dependencies local or
// browser globals so both TypeScript and DOM tests validate the shipped code.
function initializeReader(): void {
  const vscode = acquireVsCodeApi();
  const pageUrl = document.body.dataset.pageUrl || '';
  const nextLabel = document.body.dataset.nextLabel || '加载更多 →';
  const previous = vscode.getState();
  const savedScroll = typeof previous?.scroll === 'number' && Number.isFinite(previous.scroll) ? Math.max(0, previous.scroll) : 0;
  const initialScroll = previous?.url === pageUrl ? savedScroll : 0;
  // A reused Webview may retain its old scroll position even when the URL
  // changes. Explicitly reset both the Webview state and the document position.
  vscode.setState({ url: pageUrl, scroll: initialScroll });
  let interacted = false;
  for (const event of ['wheel', 'pointerdown', 'keydown']) window.addEventListener(event, () => { interacted = true; }, { once: true, passive: true });
  const restore = () => { if (!interacted) window.scrollTo({ left: 0, top: initialScroll, behavior: 'instant' }); };
  restore();
  requestAnimationFrame(() => requestAnimationFrame(restore));
  window.addEventListener('load', () => requestAnimationFrame(restore), { once: true });
  const remember = () => vscode.setState({ url: pageUrl, scroll: window.scrollY });
  let timer: ReturnType<typeof setTimeout>;
  window.addEventListener('scroll', () => {
    clearTimeout(timer);
    timer = setTimeout(remember, 150);
  });
  window.addEventListener('message', event => {
    if (event.data?.type === 'loadingDone') {
      const button = document.querySelector<HTMLButtonElement>('button[data-action="next"]');
      if (button) { button.disabled = false; button.textContent = nextLabel; }
    }
  });
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
    const button = target?.closest<HTMLButtonElement>('button[data-action]');
    if (button) {
      remember();
      if (button.dataset.action === 'next') { button.disabled = true; button.textContent = '正在加载…'; }
      vscode.postMessage({ action: button.dataset.action!, ...(button.dataset.section === undefined ? {} : { section: Number(button.dataset.section) }), ...(button.dataset.comment === undefined ? {} : { comment: button.dataset.comment }) });
      return;
    }
    const link = target?.closest<HTMLAnchorElement>('a');
    if (link) {
      event.preventDefault();
      const href = link.getAttribute('href');
      if (href?.startsWith('#answer-')) document.getElementById(href.slice(1))?.scrollIntoView({ behavior: 'smooth' });
      else vscode.postMessage({ action: 'link', url: link.href });
    }
  });
}

export function readerScript(): string { return `(${initializeReader.toString()})();`; }
