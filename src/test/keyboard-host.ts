import * as vscode from 'vscode';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Manual native-key regression harness. Launch as extensionTestsPath with
// HNOVA_KEYBOARD_TEST_DIR set to a fresh temp directory; touch `done` to exit.
export async function run(): Promise<void> {
  const directory = process.env.HNOVA_KEYBOARD_TEST_DIR;
  if (!directory) throw new Error('HNOVA_KEYBOARD_TEST_DIR is required');
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = new URL(String(input));
    appendFileSync(join(directory, 'requests.log'), `${url.pathname}\n`);
    if (url.pathname.includes('/hot-lists/')) return new Response(JSON.stringify({ data: [1, 2, 3].map(id => ({ target: { id, title: `Keyboard test article ${id}` } })) }));
    if (url.pathname.includes('/questions/')) return new Response(JSON.stringify({ data: [{ id: '99', content: '<p>Arrow key test body. Click here, then press Right and Left.</p>', author: { name: 'Keyboard test' } }], paging: { is_end: true } }));
    return new Response('', { status: 403 });
  }) as typeof fetch;
  try {
    const extension = vscode.extensions.getExtension('hnova.hnova-fish');
    await extension!.activate();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(join(directory, 'HNOVA_KEYBOARD_UI_TEST.txt')));
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand('workbench.view.extension.hnovaFish');
    writeFileSync(join(directory, 'ready'), 'ready');
    for (let i = 0; i < 360 && !existsSync(join(directory, 'done')); i++) await new Promise(resolve => setTimeout(resolve, 500));
  } finally { globalThis.fetch = original; }
}
