declare const acquireVsCodeApi: () => {
  getState(): { url?: string; scroll?: number; directoryKey?: string; directoryScroll?: number } | undefined;
  setState(state: { url: string; scroll: number; directoryKey?: string; directoryScroll?: number }): void;
  postMessage(message: { action: string; url?: string; section?: number; comment?: string; focused?: boolean; directoryWidth?: number; workWidth?: number }): void;
};

// This function is serialized into the Webview. Keep all dependencies local or
// browser globals so both TypeScript and DOM tests validate the shipped code.
function initializeReader(): void {
  const vscode = acquireVsCodeApi();
  // focusedView can still point at the tree/editor while the inner iframe has
  // keyboard focus. Report real DOM focus so native, user-editable bindings work.
  let reportedFocus: boolean | undefined;
  const reportFocus = (focused: boolean) => {
    if (reportedFocus === focused) return;
    reportedFocus = focused;
    vscode.postMessage({ action: 'readerFocus', focused });
  };
  window.addEventListener('focus', () => reportFocus(true));
  window.addEventListener('blur', () => reportFocus(false));
  document.addEventListener('pointerdown', () => reportFocus(true));
  if (document.hasFocus()) reportFocus(true);
  const pageUrl = document.body.dataset.pageUrl || '';
  const nextLabel = document.body.dataset.nextLabel || '加载更多 →';
  const previous = vscode.getState();
  const savedScroll = typeof previous?.scroll === 'number' && Number.isFinite(previous.scroll) ? Math.max(0, previous.scroll) : 0;
  const initialScroll = previous?.url === pageUrl ? savedScroll : 0;
  const directory = document.querySelector<HTMLElement>('.post-directory');
  const directoryKey = directory ? Array.from(directory.querySelectorAll<HTMLElement>('[data-url]'), item => item.dataset.url).join('\n') : '';
  const initialDirectoryScroll = previous?.directoryKey === directoryKey && typeof previous?.directoryScroll === 'number' && Number.isFinite(previous.directoryScroll) ? Math.max(0, previous.directoryScroll) : 0;
  const state = (scroll: number) => ({ url: pageUrl, scroll, directoryKey, directoryScroll: directory?.scrollTop ?? initialDirectoryScroll });
  if (directory) directory.scrollTop = initialDirectoryScroll;

  // A reused Webview may retain its old scroll position even when the URL
  // changes. Explicitly reset both the Webview state and the document position.
  vscode.setState(state(initialScroll));
  let interacted = false;
  for (const event of ['wheel', 'pointerdown', 'keydown']) window.addEventListener(event, () => { interacted = true; }, { once: true, passive: true });
  const restore = () => { if (!interacted) { window.scrollTo({ left: 0, top: initialScroll, behavior: 'instant' }); if (directory) directory.scrollTop = initialDirectoryScroll; } };
  restore();
  requestAnimationFrame(() => requestAnimationFrame(restore));
  window.addEventListener('load', () => requestAnimationFrame(restore), { once: true });
  const remember = () => vscode.setState(state(window.scrollY));
  directory?.addEventListener('scroll', remember, { passive: true });
  let timer: ReturnType<typeof setTimeout>;
  window.addEventListener('scroll', () => {
    clearTimeout(timer);
    timer = setTimeout(remember, 150);
  });
  window.addEventListener('message', event => {
    if (event.data?.type === 'directoryRefreshDone') {
      const button = document.querySelector<HTMLButtonElement>('[data-action=refreshDirectory]');
      if (button) { button.disabled = false; button.textContent = '刷新帖子列表'; }
    }
    if (event.data?.type === 'loadingDone') {
      const button = document.querySelector<HTMLButtonElement>('button[data-action="next"]');
      if (button) { button.disabled = false; button.textContent = nextLabel; }
    }
  });
  const layout = document.querySelector<HTMLElement>('.reader-layout.split');
  if (layout) {
    const resize = (name: string, change: number) => {
      const directory = layout.querySelector<HTMLElement>('.post-directory')!;
      const work = layout.querySelector<HTMLElement>('.work-pane')!;
      const left = directory.getBoundingClientRect().width, right = work.getBoundingClientRect().width;
      const width = name === 'directory'
        ? Math.max(120, Math.min(480, layout.clientWidth - right - 232, left + change))
        : Math.max(180, Math.min(600, layout.clientWidth - left - 232, right + change));
      layout.style.setProperty(name === 'directory' ? '--directory-width' : '--work-width', `${width}px`);
    };
    const saveWidths = () => vscode.postMessage({ action: 'resizeColumns', directoryWidth: layout.querySelector('.post-directory')!.getBoundingClientRect().width, workWidth: layout.querySelector('.work-pane')!.getBoundingClientRect().width });
    for (const divider of layout.querySelectorAll<HTMLElement>('[data-resize]')) {
      divider.addEventListener('pointerdown', event => {
        event.preventDefault(); divider.setPointerCapture(event.pointerId);
        let x = event.clientX;
        const move = (next: PointerEvent) => { resize(divider.dataset.resize!, (next.clientX - x) * (divider.dataset.resize === 'work' ? -1 : 1)); x = next.clientX; };
        const finish = () => { divider.removeEventListener('pointermove', move); divider.removeEventListener('pointerup', finish); divider.removeEventListener('pointercancel', finish); saveWidths(); };
        divider.addEventListener('pointermove', move); divider.addEventListener('pointerup', finish); divider.addEventListener('pointercancel', finish);
      });
      divider.addEventListener('keydown', event => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault(); event.stopPropagation();
          resize(divider.dataset.resize!, (event.key === 'ArrowRight' ? 20 : -20) * (divider.dataset.resize === 'work' ? -1 : 1)); saveWidths();
        }
      });
    }
  }
  document.addEventListener('click', event => {
    const target = event.target instanceof Element ? event.target : event.target instanceof Node ? event.target.parentElement : null;
    const button = target?.closest<HTMLButtonElement>('button[data-action]');
    if (button) {
      remember();
      if (button.disabled) return;
      if (button.dataset.action === 'refreshDirectory') { button.disabled = true; button.textContent = '刷新中…'; }
      if (button.dataset.action === 'next') { button.disabled = true; button.textContent = '正在加载…'; }
      vscode.postMessage({ action: button.dataset.action!, ...(button.dataset.url ? { url: button.dataset.url } : {}), ...(button.dataset.section === undefined ? {} : { section: Number(button.dataset.section) }), ...(button.dataset.comment === undefined ? {} : { comment: button.dataset.comment }) });
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
