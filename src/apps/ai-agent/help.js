// Buddy's help pop-ups: one shared tooltip fed by data-help attributes, with no new
// dependency. Buddy is a plain-JS page in a fixed panel, and its document is the
// tooltip's viewport, so placement is a few comparisons against innerWidth and
// innerHeight (the pure place() below, unit-tested).
//
// Elements with data-help="text" open the shared #help-pop tooltip: pointer hover
// after HOVER_MS, keyboard focus at once, and a tap or click on a .help-dot (touch
// has no hover); pressing or clicking the control the pop-up describes closes it.
// It also closes on Esc, a pointerdown outside, a blur and conversation scrolling,
// and keeps a GRACE_MS grace while the pointer moves from the trigger onto the
// pop-up. While open the trigger gets aria-describedby="help-pop"; a data-help
// change on the open trigger updates the text in place.
//
// A modal dialog (showModal) sits in the top layer, above #help-pop in the body,
// so while the trigger is inside an open dialog the pop-up is mounted in that
// dialog and moved back to the body when the dialog closes.

const MARGIN = 8; // keep the pop-up this far inside the viewport
const GAP = 8; // distance from the trigger
const HOVER_MS = 300;
const GRACE_MS = 150;

/**
 * Where the pop-up goes. triggerRect: the trigger's getBoundingClientRect (or
 * {top, left, width, height}); popSize: {width, height}; viewport: {width, height}.
 * Below the trigger when it fits, above otherwise; centred on the trigger and
 * clamped to the viewport with MARGIN px margins. Returns {top, left, side}.
 */
export function place(triggerRect, popSize, viewport) {
  const below = triggerRect.top + triggerRect.height + GAP + popSize.height <= viewport.height - MARGIN;
  const top = below ? triggerRect.top + triggerRect.height + GAP : triggerRect.top - GAP - popSize.height;
  const center = triggerRect.left + triggerRect.width / 2 - popSize.width / 2;
  const left = Math.max(MARGIN, Math.min(center, viewport.width - MARGIN - popSize.width));
  return { top: Math.max(MARGIN, top), left, side: below ? 'below' : 'above' };
}

/**
 * The welcome app strip: the apps Buddy has tools for, in catalog order.
 * apps: the catalog's apps array ([{id, title, ...}]); toolNames: the catalog tool
 * names (e.g. 'gridcraft.cells'), from which the pack ids come. Returns { shown,
 * hidden }: the first `limit` matches and the rest (the "+N" chip).
 */
export function stripApps(apps, toolNames, { limit = 8 } = {}) {
  const packs = new Set(toolNames.map(name => String(name).split('.')[0]));
  const matched = apps.filter(app => packs.has(app.id));
  return { shown: matched.slice(0, limit), hidden: matched.slice(limit) };
}

/**
 * The first line of the model select's help: what the model kind is best for.
 * LFM3 models work best in the apps; Qwen models suit chat and images. Cloud
 * and Chrome built-in models get no such line (null). key: the selected
 * option's value (e.g. 'lfm3-1.7b', 'qwen3.5-2b', 'cloud:anthropic').
 */
export function modelKindLine(key) {
  if (!key || key.startsWith('cloud:') || key.startsWith('chrome:')) return null;
  if (key.startsWith('lfm')) return 'Best for working in your apps.';
  if (key.startsWith('qwen')) return 'Good for chat and images. For working in apps, pick LFM3.';
  return null;
}

/**
 * The About card's visible line and help text, per model backend. kind:
 * 'local' | 'cloud' | 'chrome'. The local line is empty: the visible content
 * there is the license link app.js builds.
 */
export function licenseNotice(kind) {
  if (kind === 'cloud') return { line: 'Provider terms apply', help: 'The provider sets its own terms and pricing; the key is used only in this browser session.' };
  if (kind === 'chrome') return { line: 'On-device, nothing sent', help: 'On-device: no data is sent to Google or any third party when using the model.' };
  return { line: '', help: 'Model weights have their own license. Sizes are approximate; small models may miss tools or give wrong answers.' };
}

/**
 * Wire the shared #help-pop tooltip to every data-help trigger in root (Buddy's
 * whole document). The listeners are delegated on root and the text is read at
 * show time, so a trigger added later (chat rows, tool cards, a strip built after
 * initHelp) works without re-wiring.
 */
export function initHelp(root = document) {
  const view = root.defaultView ?? window; // innerWidth/innerHeight live on window, not document
  const pop = root.querySelector('#help-pop');
  if (!pop) return;
  const conversation = root.querySelector('#conversation');
  let openFor = null;
  let hoverFor = null;
  let hoverTimer = null;
  let graceTimer = null;

  const clearTimers = () => { clearTimeout(hoverTimer); clearTimeout(graceTimer); hoverTimer = null; graceTimer = null; };

  function show(trigger) {
    const text = trigger.dataset.help;
    if (!text) return;
    clearTimers();
    if (openFor && openFor !== trigger) openFor.removeAttribute('aria-describedby');
    openFor = trigger;
    // The settings dialog is in the top layer, above the pop-up in the body:
    // while the trigger lives in an open dialog, mount the pop-up there.
    const dialog = trigger.closest('dialog[open]');
    const home = dialog ?? root.body;
    if (pop.parentElement !== home) home.append(pop);
    pop.textContent = text;
    pop.hidden = false;
    const rect = trigger.getBoundingClientRect();
    const size = { width: pop.offsetWidth, height: pop.offsetHeight };
    const position = place(rect, size, { width: view.innerWidth, height: view.innerHeight });
    pop.style.top = `${position.top}px`;
    pop.style.left = `${position.left}px`;
    pop.classList.add('open');
    trigger.setAttribute('aria-describedby', 'help-pop');
  }

  function hide() {
    clearTimers();
    if (openFor) openFor.removeAttribute('aria-describedby');
    openFor = null;
    pop.classList.remove('open');
    pop.hidden = true;
  }

  // Delegation on root: pointerover/pointerout resolve the trigger with closest,
  // and relatedTarget keeps a move between a trigger's children from closing it.
  root.addEventListener('pointerover', event => {
    const trigger = event.target.closest('[data-help]');
    if (!trigger) return;
    clearTimeout(graceTimer); graceTimer = null; // re-entering cancels the pending hide
    if (trigger === hoverFor) return;
    hoverFor = trigger;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => show(trigger), HOVER_MS);
  });
  root.addEventListener('pointerout', event => {
    const trigger = event.target.closest('[data-help]');
    if (!trigger || trigger !== hoverFor) return;
    if (event.relatedTarget && trigger.contains(event.relatedTarget)) return; // still inside the trigger
    hoverFor = null;
    clearTimeout(hoverTimer);
    graceTimer = setTimeout(hide, GRACE_MS);
  });
  root.addEventListener('focusin', event => {
    const trigger = event.target.closest('[data-help]');
    if (!trigger) return;
    // Keyboard focus only: a mouse click on the control must not open the pop-up
    // (Chrome does not match :focus-visible for mouse focus).
    if (!trigger.matches(':focus-visible')) return;
    clearTimers();
    show(trigger);
  });
  root.addEventListener('focusout', event => {
    if (!openFor) return;
    if (event.relatedTarget && pop.contains(event.relatedTarget)) return; // focus moved into the pop-up
    hide();
  });
  root.addEventListener('click', event => {
    const dot = event.target.closest('.help-dot');
    if (dot) { clearTimers(); show(dot); return; }
    // Pressing the described control closes its help: this catches Enter and Space
    // on a focused control, which fire click but no pointerdown.
    if (event.target.closest('[data-help]')) hide();
  });

  // The pointer can land on the pop-up right after it leaves the trigger; leaving
  // the pop-up closes it after the grace, and re-entering the trigger or the
  // pop-up cancels the hide.
  pop.addEventListener('pointerenter', () => { clearTimeout(graceTimer); graceTimer = null; });
  pop.addEventListener('pointerleave', () => { graceTimer = setTimeout(hide, GRACE_MS); });

  // A pointerdown on the described control dismisses its help (native tooltip
  // behaviour): hide() clears the pending hover timer, and hoverFor stays set, so
  // the pop-up does not reopen on that control until the pointer leaves it.
  // Everything else keeps the outside-pointerdown close.
  root.addEventListener('pointerdown', event => {
    const trigger = event.target.closest('[data-help]');
    if (trigger && !trigger.classList.contains('help-dot')) { hide(); return; }
    if (!openFor) return;
    if (pop.contains(event.target) || openFor.contains(event.target)) return;
    hide();
  }, true);

  // Esc closes the pop-up first, before the page's own Escape handling (panel close);
  // capture phase, so stopPropagation keeps the panel handler from firing too.
  // preventDefault keeps a modal dialog under the trigger (settings) from closing
  // on this same Esc: a second Esc then closes the dialog natively.
  root.addEventListener('keydown', event => {
    if (event.key !== 'Escape' || !openFor) return;
    hide();
    event.preventDefault();
    event.stopPropagation();
  }, true);

  // A dialog's close event bubbles to the document: hide the pop-up and move it
  // back out of the (now closed) dialog into the body.
  root.addEventListener('close', event => {
    if (event.target?.tagName !== 'DIALOG') return;
    hide();
    if (pop.parentElement === event.target) root.body.append(pop);
  });

  if (conversation) conversation.addEventListener('scroll', hide, { passive: true });

  // app.js rewrites data-help when the model or the image note changes; refresh the
  // open pop-up in place.
  new MutationObserver(records => {
    for (const record of records) if (record.target === openFor) pop.textContent = openFor.dataset.help;
  }).observe(root, { subtree: true, attributes: true, attributeFilter: ['data-help'] });
}
