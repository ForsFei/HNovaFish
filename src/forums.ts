export function forumName(input: string): string {
  let value = input.trim();
  if (/^https?:/i.test(value)) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'tieba.baidu.com' || !['/f', '/mo/q/m'].includes(url.pathname) || url.username || url.password || url.port) throw new Error('请使用贴吧列表的 HTTPS 网址。');
    value = url.searchParams.get('kw')?.trim() || '';
  }
  if (!value || value.length > 60 || /[\r\n\t]/.test(value)) throw new Error('请输入 1–60 个字符的准确吧名，或带 kw 参数的贴吧列表链接。');
  return value;
}
