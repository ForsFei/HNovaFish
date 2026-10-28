import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { parseLink } from '../model';

// Runs inside a real VS Code extension host, with deterministic platform responses.
export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('hnova.hnova-fish');
  assert.ok(extension, 'Extension is discovered by VS Code');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const name of ['read', 'hide', 'refresh', 'cookie', 'openUrl', 'addForum', 'clearHistory', 'focusReader', 'reloadReader']) assert.ok(commands.includes(`hnovaFish.${name}`));
  const document = await vscode.workspace.openTextDocument({ language: 'plaintext', content: 'HNova Fish: keep this editor visible while reading.' });
  await vscode.window.showTextDocument(document);
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (url: unknown) => {
    calls++;
    if (String(url).includes('/api/v4/questions/')) return new Response(JSON.stringify({ data: [{ content: '<p>知乎接口正文</p>', author: { name: '测试作者' }, question: { title: '知乎集成测试' } }] }));
    return new Response('<h3 class="core_title_txt">集成测试帖子</h3><div class="l_post"><span class="p_author_name">测试作者</span><div class="d_post_content">真实扩展宿主中的正文。</div></div>');
  }) as typeof fetch;
  try {
    await vscode.commands.executeCommand('hnovaFish.clearHistory');
    const entry = parseLink('https://tieba.baidu.com/p/123456789');
    await vscode.commands.executeCommand('hnovaFish.read', entry);
    assert.equal(calls, 1, 'First read fetches platform content');
    assert.ok(vscode.window.visibleTextEditors.some(editor => editor.document === document), 'Code editor stays visible beside the sidebar');
    assert.ok(!vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputWebview)), 'Reading creates no editor Webview tabs');
    await vscode.commands.executeCommand('hnovaFish.hide');
    await vscode.commands.executeCommand('hnovaFish.read', entry);
    assert.equal(calls, 1, 'Reopening uses the stored article cache');
    await vscode.commands.executeCommand('hnovaFish.read', entry, true);
    assert.equal(calls, 2, 'Explicit refresh reloads platform content');
    await vscode.commands.executeCommand('hnovaFish.hide');
    await vscode.commands.executeCommand('hnovaFish.clearHistory');
    await vscode.commands.executeCommand('hnovaFish.read', entry);
    assert.equal(calls, 3, 'Clearing history also clears the cached article');
    await vscode.commands.executeCommand('hnovaFish.hide');
    await vscode.commands.executeCommand('hnovaFish.read', parseLink('https://www.zhihu.com/question/1969027955376807936'));
    assert.equal(calls, 4, 'Zhihu reads API content directly without fetching the empty question HTML');
    await vscode.commands.executeCommand('hnovaFish.hide');
    console.log('HNOVA_HOST_TESTS_PASSED: activation, sidebar reading, preserved code editor, no reader editor tabs, cache, refresh, hide, clear history, Zhihu API reading');
  } finally { globalThis.fetch = original; }
}
