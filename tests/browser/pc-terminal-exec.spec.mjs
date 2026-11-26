import { test, expect } from '@playwright/test';
import { skipUnlessEnabled } from './catalog.mjs';
// The guest's pty prompt is busybox sh's "~ $": an idle shell ends the
// screen there. The exec runs themselves never touch this pty (they are vm.exec() sessions).
// M3: a request runs at once - no approval prompt, no clicks; the status line names the run
// and its result, and Buddy's exec-cancel stops a run in flight.
const screen = page => page.locator('.xterm-rows');
const shellReady = page => expect.poll(async () => {
  const t = await screen(page).textContent();
  return /[$#⇒]$/.test(t.trimEnd()); // busybox sh on the pty shows "~ $" (measured); root "#"
}, { timeout: 120000 }).toBe(true);
const ready = async page => { await page.getByRole('button', { name: 'Start Linux', exact: true }).click(); await shellReady(page); };
const execRequest = (id, code, lang = 'sh', timeoutMs = 30000) => ({ type: 'exec-request', id, from: 'Terminal Exec Spec', lang, code, timeoutMs });

test('the terminal exec service runs requests at once via vm.exec and reports results over BroadcastChannel', async ({ page, baseURL }) => {
  skipUnlessEnabled(test, 'terminal');
  skipUnlessEnabled(test, 'files'); // the spec uses the Files page as its BroadcastChannel requester
  test.setTimeout(600000); page.on('dialog', dialog => dialog.accept());
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
  // No approval click any more: the request runs at once.
  const run = (id, code, lang, timeoutMs) => post(execRequest(id, code, lang, timeoutMs));
  // A request before boot gets not-running, and the guest is never auto-started.
  expect(await post(execRequest('pre-boot', 'echo early'))).toEqual({ type: 'exec-error', id: 'pre-boot', reason: 'not-running' });
  await ready(page);
  // M3: the approval prompt is gone from the page.
  expect(await page.locator('#exec-prompt').count()).toBe(0);
  // A request runs without a prompt: the status line names it while it runs, and the reply
  // carries the guest's output.
  const onceP = run('at-once', 'sleep 2; echo at-once-ok');
  await expect(page.locator('#terminal-status')).toContainText('Running sh command from Terminal Exec Spec', { timeout: 20000 });
  const once = await onceP;
  expect(once).toMatchObject({ type: 'exec-result', id: 'at-once', exitCode: 0, truncated: false });
  expect(once.output).toBe('at-once-ok\n');
  // Protocol: the terminal acks the request with exec-pending before the real reply.
  expect(await requester.evaluate(() => window.__execTraffic)).toEqual(expect.arrayContaining([{ type: 'exec-pending', id: 'at-once' }]));
  // Code with a NUL is refused before the run: the guest's exec channel cannot carry it.
  expect(await post(execRequest('nul', 'echo a\x00b'))).toEqual({ type: 'exec-error', id: 'nul', reason: 'invalid' });
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
  // M5: a finished run is drawn into the xterm above the user's prompt line (never into the
  // pty), and the shell still works after the redraw. The marker SHOW_42 appears only in the
  // output, not in the header (which shows the code as typed).
  const shown = await post({ type: 'exec-request', id: 'show-run', from: 'WebPC Agent', lang: 'sh', code: 'echo SHOW_$((40+2))', timeoutMs: 30000 });
  expect(shown).toMatchObject({ type: 'exec-result', exitCode: 0 });
  expect(shown.output).toBe('SHOW_42\n');
  await expect.poll(async () => screen(page).textContent(), { timeout: 10000 }).toContain('SHOW_42');
  const screenText = await screen(page).textContent();
  expect(screenText).toContain('WebPC Agent $ echo SHOW_$((40+2))');
  expect(screenText).toMatch(/\[exit 0 · \d+ ms\]/);
  const promptRow = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll('.xterm-rows > div')).map(row => row.textContent ?? '');
    for (let i = rows.length - 1; i >= 0; i--) if (rows[i].trim() !== '') return rows[i];
    return '';
  });
  expect(promptRow.trimEnd()).toMatch(/[$#⇒]$/, 'the prompt line is restored under the block');
  await page.locator('#terminal').click();
  await page.keyboard.type('echo AFTER_$((1+1))');
  await page.keyboard.press('Enter');
  await expect.poll(async () => screen(page).textContent(), { timeout: 10000 }).toContain('AFTER_2');
  // The 64 KiB output cap keeps the tail and flags truncation.
  const capped = await run('py-cap', 'import sys; sys.stdout.write("A"*80000 + "B"*80000)', 'python');
  expect(capped).toMatchObject({ type: 'exec-result', exitCode: 0, truncated: true });
  expect(capped.output.length).toBe(64 * 1024);
  expect(capped.output.startsWith('B')).toBe(true);
  expect(capped.output).not.toContain('A');
  // Only one run at a time: a second request while one is running gets busy.
  const first = run('busy-first', 'sleep 5');
  expect(await post(execRequest('busy-second', 'echo busy'))).toEqual({ type: 'exec-error', id: 'busy-second', reason: 'busy' });
  expect(await first).toMatchObject({ type: 'exec-result', exitCode: 0 });
  // Buddy's exec-cancel (Stop, New chat, the wall timer) stops a run in flight; the guest
  // stays usable afterwards.
  const stopP = run('cancelled', 'sleep 30');
  await expect(page.locator('#terminal-status')).toContainText('Running sh command from Terminal Exec Spec', { timeout: 20000 });
  await requester.evaluate(id => { const c = new BroadcastChannel('webpc-terminal'); c.postMessage({ type: 'exec-cancel', id, from: 'WebPC Agent' }); }, 'cancelled');
  const stopped = await stopP;
  expect(stopped).toMatchObject({ type: 'exec-error', id: 'cancelled', reason: 'cancelled' });
  expect(stopped.durationMs).toBeLessThan(15000, 'the run ended on the cancel, not on its 30 s limit');
  const afterCancel = await run('after-cancel', 'echo ok');
  expect(afterCancel.output).toBe('ok\n');
  // Two tabs: only the tab that holds the saved disk runs the request. This tab (page) booted
  // first, so it holds the lock and is the owner; the second tab boots the SDK's snapshot (the
  // not-saved chip shows) and must reply not-running. The owner runs the request and its
  // result is what the client settles on.
  const second = await page.context().newPage();
  second.on('dialog', dialog => dialog.accept());
  second.on('request', trackExternal);
  await second.goto('/pc/apps/terminal/');
  await ready(second);
  await expect(second.locator('.linux-chip', { hasText: 'Not saved: open in another tab' })).toBeVisible();
  await requester.evaluate(() => { const c = new BroadcastChannel('webpc-terminal'); c.postMessage({ type: 'exec-request', id: 'two-tab', from: 'Terminal Exec Spec', lang: 'sh', code: 'echo two-tab-ok' }); });
  // Wait for the owner's result itself: the requester's listener also sees its own
  // exec-request (a BroadcastChannel delivers to every other object of that name, in this
  // page too), so a message count is reached before the result under load.
  await expect.poll(async () => requester.evaluate(() => window.__execTraffic.some(m => m && m.id === 'two-tab' && (m.type === 'exec-result' || (m.type === 'exec-error' && m.reason !== 'not-running')))), { timeout: 30000 }).toBe(true);
  const twoTab = await requester.evaluate(() => window.__execTraffic.filter(m => m && m.id === 'two-tab'));
  const snapshotReply = twoTab.find(m => m.type === 'exec-error');
  expect(snapshotReply?.reason, 'the snapshot tab runs nothing').toBe('not-running');
  expect(twoTab.find(m => m.type === 'exec-pending'), 'the owner tab acked the request').toBeTruthy();
  expect(twoTab.find(m => m.type === 'exec-result'), `the owner ran it; traffic: ${JSON.stringify(twoTab)}`).toMatchObject({ id: 'two-tab', exitCode: 0, output: 'two-tab-ok\n' });
  expect(external).toEqual([]);
});
