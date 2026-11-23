import { test, expect } from '@playwright/test';
import { skipUnlessEnabled } from './catalog.mjs';
// The guest's pty prompt is busybox sh's "~ $": an idle shell ends the
// screen there. The exec runs themselves never touch this pty (they are vm.exec() sessions).
const screen = page => page.locator('.xterm-rows');
const shellReady = page => expect.poll(async () => {
  const t = await screen(page).textContent();
  return /[$#⇒]$/.test(t.trimEnd()); // busybox sh on the pty shows "~ $" (measured); root "#"
}, { timeout: 120000 }).toBe(true);
const ready = async page => { await page.getByRole('button', { name: 'Start Linux', exact: true }).click(); await shellReady(page); };
const execRequest = (id, code, lang = 'sh', timeoutMs = 30000) => ({ type: 'exec-request', id, from: 'Terminal Exec Spec', lang, code, timeoutMs });

test('the terminal exec service runs approved commands via vm.exec and reports results over BroadcastChannel', async ({ page, baseURL }) => {
  skipUnlessEnabled(test, 'terminal');
  skipUnlessEnabled(test, 'files'); // the spec uses the Files page as its BroadcastChannel requester
  test.setTimeout(300000); page.on('dialog', dialog => dialog.accept());
  const external = [];
  const trackExternal = request => { if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(baseURL).origin) external.push(request.url()); };
  page.on('request', trackExternal);
  await page.goto('/pc/apps/terminal/');
  // A second same-origin page (the Files app) plays the requesting app: a second terminal
  // page would answer its own requests through its own channel listener.
  const requester = await page.context().newPage(); requester.on('request', trackExternal);
  await requester.goto('/pc/apps/files/');
  await requester.evaluate(() => {
    const channel = new BroadcastChannel('webpc-terminal'); const pending = new Map();
    window.__execTraffic = [];
    channel.onmessage = event => { const d = event.data; window.__execTraffic.push(d); if (d && (d.type === 'exec-result' || d.type === 'exec-error')) { const resolve = pending.get(d.id); if (resolve) { pending.delete(d.id); resolve(d); } } };
    window.__exec = request => new Promise((resolve, reject) => { pending.set(request.id, resolve); channel.postMessage(request); setTimeout(() => { if (pending.has(request.id)) { pending.delete(request.id); reject(new Error(`no exec response within 120 s for ${request.id}`)); } }, 120000); });
  });
  const post = request => requester.evaluate(r => window.__exec(r), request);
  const run = async (id, code, lang, timeoutMs) => {
    const response = post(execRequest(id, code, lang, timeoutMs));
    await page.locator('#exec-prompt').waitFor({ state: 'visible', timeout: 20000 });
    await page.locator('#exec-run').click();
    return response;
  };
  // A request before boot gets not-running, and the guest is never auto-started.
  expect(await post(execRequest('pre-boot', 'echo early'))).toEqual({ type: 'exec-error', id: 'pre-boot', reason: 'not-running' });
  await ready(page);
  // Every run needs an approval click; the prompt is keyboard accessible (Deny focused first).
  const denied = post(execRequest('denied', 'echo never'));
  await page.locator('#exec-prompt').waitFor({ state: 'visible', timeout: 20000 });
  expect(await page.locator('#exec-code').textContent()).toBe('echo never');
  expect(await page.locator('#exec-meta').textContent()).toContain('Terminal Exec Spec');
  expect(await page.evaluate(() => document.activeElement.id)).toBe('exec-deny');
  // Protocol: the Terminal announces the pending approval.
  expect(await requester.evaluate(() => window.__execTraffic)).toEqual(expect.arrayContaining([{ type: 'exec-pending', id: 'denied' }]));
  await page.locator('#exec-deny').click();
  expect(await denied).toEqual({ type: 'exec-error', id: 'denied', reason: 'denied' });
  expect(await page.locator('#exec-prompt').isVisible()).toBe(false);
  // Code with a NUL is refused before any prompt: the guest's exec channel cannot carry it.
  expect(await post(execRequest('nul', 'echo a\x00b'))).toEqual({ type: 'exec-error', id: 'nul', reason: 'invalid' });
  expect(await page.locator('#exec-prompt').isVisible()).toBe(false);
  // The prompt renders what will run: C0 controls and invisible characters are visible.
  const crafted = post(execRequest('crafted', 'echo a\rb\x1bc'));
  await page.locator('#exec-prompt').waitFor({ state: 'visible', timeout: 20000 });
  expect(await page.locator('#exec-code').textContent()).toBe('echo a\\x0db\\x1bc');
  await page.locator('#exec-deny').click();
  expect(await crafted).toEqual({ type: 'exec-error', id: 'crafted', reason: 'denied' });
  // A programmatic (untrusted) Run click is not an approval: the prompt stays.
  const untrusted = post(execRequest('untrusted', 'echo never'));
  await page.locator('#exec-prompt').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#exec-run').evaluate(el => el.click());
  await page.waitForTimeout(500);
  expect(await page.locator('#exec-prompt').isVisible()).toBe(true, 'an untrusted click must not run or clear the prompt');
  await page.locator('#exec-deny').click();
  expect(await untrusted).toEqual({ type: 'exec-error', id: 'untrusted', reason: 'denied' });
  // Two-Terminal loop guard: a reply-shaped message on the channel gets no answer. The
  // requester's own listener also sees the posted reply (another channel instance on the
  // page), so only an `invalid` answer would count.
  await requester.evaluate(() => { const c = new BroadcastChannel('webpc-terminal'); c.postMessage({ type: 'exec-error', id: 'loop-x', reason: 'not-running' }); });
  await page.waitForTimeout(1500);
  expect(await requester.evaluate(() => window.__execTraffic.filter(m => m && m.id === 'loop-x').map(m => m.reason))).toEqual(['not-running']);
  // vm.exec() hands back clean program output: no sentinels, no echoed code, per-stream
  // exit codes.
  const hello = await run('echo-hello', 'echo hello');
  expect(hello).toMatchObject({ type: 'exec-result', exitCode: 0, truncated: false });
  expect(hello.output).toBe('hello\n');
  const py = await run('py-add', 'print(2+2)', 'python');
  expect(py).toMatchObject({ type: 'exec-result', exitCode: 0, truncated: false });
  expect(py.output).toBe('4\n');
  expect(py.output).not.toContain('print(');
  const node = await run('node-map', 'console.log([1,2].map(x=>x*3))', 'node');
  expect(node).toMatchObject({ type: 'exec-result', exitCode: 0 });
  expect(node.output).toBe('[ 3, 6 ]\n');
  expect(node.output).not.toContain('console.log');
  // stderr is reported after stdout (the v86 path read one merged stream).
  const merged = await run('sh-merge', 'echo out; echo err >&2');
  expect(merged).toMatchObject({ type: 'exec-result', exitCode: 0 });
  expect(merged.output).toBe('out\nerr\n');
  const commented = await run('sh-comment', 'echo done # trailing comment');
  expect(commented).toMatchObject({ type: 'exec-result', exitCode: 0 });
  expect(commented.output).toBe('done\n');
  const failed = await run('sh-fail', 'false');
  expect(failed).toMatchObject({ type: 'exec-result', exitCode: 1 });
  // A signal kill reports 128 + signal, as the shell's $? would.
  const signalled = await run('py-sig', 'import os; os.kill(os.getpid(), 9)', 'python');
  expect(signalled).toMatchObject({ type: 'exec-result', exitCode: 137 });
  // A timeout interrupts the run at the limit and replies with the timeout reason; the
  // guest keeps running and the shell is usable afterwards.
  const slow = await run('sh-slow', 'sleep 100; echo NEVER_DONE', 'sh', 3000);
  expect(slow).toMatchObject({ type: 'exec-error', reason: 'timeout' });
  expect(typeof slow.output).toBe('string');
  expect(slow.output).not.toContain('NEVER_DONE');
  expect(slow.durationMs).toBeGreaterThanOrEqual(2500);
  const recovered = await run('recover', 'echo ok');
  expect(recovered).toMatchObject({ type: 'exec-result', exitCode: 0 });
  expect(recovered.output).toBe('ok\n');
  // The 64 KiB output cap keeps the tail and flags truncation.
  const capped = await run('py-cap', 'import sys; sys.stdout.write("A"*80000 + "B"*80000)', 'python');
  expect(capped).toMatchObject({ type: 'exec-result', exitCode: 0, truncated: true });
  expect(capped.output.length).toBe(64 * 1024);
  expect(capped.output.startsWith('B')).toBe(true);
  expect(capped.output).not.toContain('A');
  // Only one run at a time: a second request while one is running gets busy.
  const first = post(execRequest('busy-first', 'sleep 5'));
  await page.locator('#exec-prompt').waitFor({ state: 'visible', timeout: 20000 });
  await page.locator('#exec-run').click();
  // Protocol: the approved run announces itself over the channel.
  expect(await requester.evaluate(() => window.__execTraffic)).toEqual(expect.arrayContaining([{ type: 'exec-started', id: 'busy-first' }]));
  expect(await post(execRequest('busy-second', 'echo busy'))).toEqual({ type: 'exec-error', id: 'busy-second', reason: 'busy' });
  expect(await first).toMatchObject({ type: 'exec-result', exitCode: 0 });
  expect(external).toEqual([]);
});
