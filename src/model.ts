export type Site = 'tieba' | 'zhihu';
export interface Entry { id: string; site: Site; title: string; url: string; summary?: string; description?: string; }
export interface Section { id?: string; author: string; html: string; votes?: number; url?: string; tiebaReplyCount?: number; tiebaReplyPreview?: import('./comments').CommentItem[]; }
export interface Article extends Entry {
  sections: Section[];
  nextUrl?: string;
  fetchedAt: number;
  kind?: 'question' | 'answer' | 'article';
  totalAnswers?: number;
  source?: 'api' | 'html';
  questionUrl?: string;
  tiebaPreviewVersion?: number;
}

export function mergeSections(previous: Section[], incoming: Section[]): Section[] {
  const result = [...previous];
  for (const section of incoming) {
    if (!result.some(old => old.id && section.id ? old.id === section.id : old.author === section.author && old.html === section.html)) result.push(section);
  }
  return result;
}

export function parseLink(input: string): Entry {
  const url = new URL(input.trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.port) throw new Error('仅支持贴吧、知乎的 HTTPS 帖子链接。');
  let site: Site;
  let match: RegExpMatchArray | null;
  if (url.hostname === 'tieba.baidu.com' && (match = url.pathname.match(/^\/p\/(\d+)\/?$/))) site = 'tieba';
  else if ((url.hostname === 'www.zhihu.com' || url.hostname === 'zhihu.com') && (match = url.pathname.match(/^\/(?:question\/\d+(?:\/answer\/\d+)?|answer\/\d+)\/?$/))) site = 'zhihu';
  else if (url.hostname === 'zhuanlan.zhihu.com' && (match = url.pathname.match(/^\/p\/(\d+)\/?$/))) site = 'zhihu';
  else throw new Error('请粘贴贴吧帖子、知乎问题、回答或专栏文章链接。');
  url.search = ''; url.hash = '';
  if (url.hostname === 'zhihu.com') url.hostname = 'www.zhihu.com';
  return { id: `${site}:${url.pathname}`, site, title: '加载正文…', url: url.href };
}

export function assertSiteUrl(input: string, site: Site): URL {
  const url = new URL(input);
  const hosts = site === 'tieba' ? ['tieba.baidu.com'] : ['www.zhihu.com', 'zhuanlan.zhihu.com'];
  if (url.protocol !== 'https:' || !hosts.includes(url.hostname) || url.username || url.password || url.port) throw new Error('拒绝访问非平台地址。');
  return url;
}
