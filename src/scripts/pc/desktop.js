import { apps, buddy } from './registry.mjs';
import { filterApps } from './app-search.mjs';
import { reduceDesktop, windowRect, MOBILE_WIDTH } from './window-state.mjs';
import { showMenu } from './context-menu.mjs';
import { gridSize, parseSaved, resolveLayout, moveIcon, cellAt, cellOrigin, visualOrder } from './icon-layout.mjs';

const shell = document.querySelector('[data-pc]');
if (shell) {
  const workspace = shell.querySelector('#pc-workspace');
  const windowLayer = shell.querySelector('[data-windows]');
  const tasks = shell.querySelector('[data-tasks]');
  const launcher = shell.querySelector('#pc-launcher');
  const launcherToggle = shell.querySelector('[data-launcher-toggle]');
  const appSearch = shell.querySelector('#pc-app-search');
  const appCategory = shell.querySelector('#pc-category');
  const announcement = shell.querySelector('[data-announcement]');
  const views = new Map();
  let state = { windows: [], activeId: null };
  const bounds = () => ({ width: workspace.clientWidth, height: workspace.clientHeight });
  const announce = text => { announcement.textContent = text; };
  const icon = id => shell.querySelector(`[data-shortcut="${id}"] .pc-app-icon`).cloneNode(true);
  const appById = id => apps.find(app => app.id === id);

  // Right-click (or Shift+F10 / the ContextMenu key on a focused shortcut, or a 500 ms
  // touch long-press) opens a context menu for shortcuts, launcher entries and the
  // desktop background. Windows, the taskbar and everything else keep the native menu.
  const appMenuItems = app => {
    const openWindow = () => window.open(app.src, 'webpc-' + app.id, `popup=yes,width=${app.width ?? 1180},height=${app.height ?? 760}${app.kind === 'external' ? ',noopener' : ''}`);
    const openTab = () => window.open(app.src, '_blank', 'noopener');
    if (app.kind === 'external') return [
      { label: 'Open in new tab', action: openTab },
      { label: 'Open in new window', action: openWindow },
    ];
    if (app.kind === 'about') return [{ label: 'Open', action: () => openApp(app.id) }];
    return [
      { label: 'Open', action: () => openApp(app.id) },
      { label: 'Open in new window', action: openWindow },
      { label: 'Open in new tab', action: openTab },
    ];
  };
  const backgroundMenuItems = () => [
    // "Arrange icons": clear the stored layout and re-apply the default (re-resolving
    // with no saved cells is the default layout); nothing is written back.
    { label: 'Arrange icons', action: () => { try { localStorage.removeItem(iconStorageKey); } catch {} applyIconLayout(); } },
  ];
  const showAppMenu = (target, x, y) => {
    const app = appById(target.dataset.shortcut ?? target.dataset.openApp);
    if (app) showMenu({ x, y, items: appMenuItems(app), returnFocus: target });
  };
  shell.addEventListener('contextmenu', event => {
    const target = event.target instanceof Element ? event.target.closest('.pc-shortcut, .pc-launcher-app') : null;
    if (target) { event.preventDefault(); showAppMenu(target, event.clientX, event.clientY); return; }
    if (event.target instanceof Element && event.target.closest('#pc-workspace') && !event.target.closest('[data-windows]')) {
      event.preventDefault();
      showMenu({ x: event.clientX, y: event.clientY, items: backgroundMenuItems(), returnFocus: null });
    }
  });
  shell.addEventListener('keydown', event => {
    if (event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) {
      const shortcut = event.target instanceof Element ? event.target.closest('.pc-shortcut') : null;
      if (!shortcut) return;
      event.preventDefault();
      const rect = shortcut.getBoundingClientRect();
      showAppMenu(shortcut, rect.left + rect.width / 2, rect.bottom); // the icon
      return;
    }
    if (event.key === 'Escape' && dragState.active && dragState.button) {
      event.preventDefault();
      endIconDrag(dragState.button, false); // cancel the drag
      return;
    }
    const cellDelta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[event.key];
    if (cellDelta && event.altKey && !event.ctrlKey && !event.metaKey) {
      const shortcut = event.target instanceof Element ? event.target.closest('.pc-shortcut') : null;
      if (!shortcut || !isFreeLayout()) return;
      event.preventDefault();
      moveIconBy(shortcut.dataset.shortcut, cellDelta[0], cellDelta[1]);
    }
  });
  // A 500 ms touch long-press opens the menu; the click the pointer-up then dispatches
  // is suppressed so it does not also open the app.
  let suppressedClick = null;
  const wireLongPress = button => {
    let timer = null, startX = 0, startY = 0;
    const clear = () => { if (timer) { clearTimeout(timer); timer = null; } };
    button.addEventListener('pointerdown', event => {
      if (event.pointerType !== 'touch' || event.button !== 0) return;
      startX = event.clientX; startY = event.clientY;
      clear();
      timer = setTimeout(() => {
        timer = null;
        suppressedClick = button;
        const rect = button.getBoundingClientRect();
        showAppMenu(button, rect.left + rect.width / 2, rect.top + rect.height / 2);
      }, 500);
    });
    for (const type of ['pointerup', 'pointercancel']) button.addEventListener(type, clear);
    button.addEventListener('pointermove', event => { if (timer && Math.hypot(event.clientX - startX, event.clientY - startY) > 10) clear(); });
  };

  // --- Free icon layout (fine pointer, desktop >= 640 px) ---------------------------
  // The whole desktop is the icon space: shortcuts sit absolutely at their cell origin,
  // resolved from localStorage (pc:desktop:icons:v1). A resize re-resolves without
  // saving; only a user move (drop, Alt+arrow) or "Arrange icons" (which clears) writes.
  // Coarse pointers and narrow screens keep the flow grid at full width (CSS), registry order.
  const iconStorageKey = 'pc:desktop:icons:v1';
  const iconIds = apps.map(app => app.id);
  const iconContainer = shell.querySelector('.pc-shortcuts');
  const shortcutOf = id => shell.querySelector(`[data-shortcut="${id}"]`);
  const isFreeLayout = () => matchMedia('(hover: hover) and (pointer: fine)').matches && workspace.clientWidth >= 640;
  const savedIcons = () => { try { return parseSaved(localStorage.getItem(iconStorageKey) ?? ''); } catch { return {}; } };
  const storeIcons = layout => { try { localStorage.setItem(iconStorageKey, JSON.stringify(layout)); } catch {} };
  let iconLayout = {};
  function applyIconLayout() {
    const { width, height } = bounds();
    const grid = gridSize(width, height);
    const free = isFreeLayout();
    shell.dataset.freeLayout = String(free);
    if (!free) {
      for (const id of iconIds) { const button = shortcutOf(id); if (button) iconContainer.append(button); }
      return;
    }
    iconLayout = resolveLayout(iconIds, savedIcons(), grid.cols, grid.rows);
    for (const [id, cell] of Object.entries(iconLayout)) {
      const button = shortcutOf(id);
      if (!button) continue;
      const origin = cellOrigin(cell);
      button.style.left = `${origin.x}px`;
      button.style.top = `${origin.y}px`;
      button.style.transform = '';
    }
    // DOM order is the Tab order: column-major over the resolved cells.
    for (const id of visualOrder(iconLayout)) { const button = shortcutOf(id); if (button) iconContainer.append(button); }
  }
  const commitIconMove = (id, cell) => {
    const { width, height } = bounds();
    const grid = gridSize(width, height);
    iconLayout = moveIcon(iconLayout, id, cell, grid.cols, grid.rows);
    storeIcons(iconLayout);
    applyIconLayout();
  };
  const moveIconBy = (id, dCol, dRow) => {
    const cell = iconLayout[id] ?? { col: 0, row: 0 };
    commitIconMove(id, { col: cell.col + dCol, row: cell.row + dRow });
  };
  const dragState = { button: null, active: false, x: 0, y: 0 };
  const dragClick = { button: null, until: 0 };
  const clicksSuppressed = button => button === dragClick.button && Date.now() < dragClick.until;
  const endIconDrag = (button, commit) => {
    // Measure the drop point while the icon is still translated, then reset it.
    const rect = button.getBoundingClientRect();
    button.classList.remove('pc-shortcut-dragging');
    button.style.transform = '';
    const wasDrag = dragState.active;
    dragState.button = null;
    dragState.active = false;
    if (!wasDrag) return;
    // The click/dblclick the pointer-up then dispatches must not open the app.
    dragClick.button = button;
    dragClick.until = Date.now() + 700;
    if (!commit) return;
    const ws = workspace.getBoundingClientRect();
    commitIconMove(button.dataset.shortcut, cellAt(rect.left + rect.width / 2 - ws.left, rect.top + rect.height / 2 - ws.top));
  };
  const wireIconDrag = button => {
    button.addEventListener('pointerdown', event => {
      if (!isFreeLayout() || event.pointerType !== 'mouse' || event.button !== 0) return;
      dragState.button = button;
      dragState.active = false;
      dragState.x = event.clientX;
      dragState.y = event.clientY;
      // Capture now, so a fast first move that leaves the icon still reaches it.
      button.setPointerCapture(event.pointerId);
    });
    button.addEventListener('pointermove', event => {
      if (dragState.button !== button) return;
      const dx = event.clientX - dragState.x, dy = event.clientY - dragState.y;
      if (!dragState.active && Math.hypot(dx, dy) > 5) {
        dragState.active = true;
        button.classList.add('pc-shortcut-dragging');
      }
      if (!dragState.active) return;
      button.style.transform = `translate(${dx}px, ${dy}px)`;
      event.preventDefault();
    });
    button.addEventListener('pointerup', () => endIconDrag(button, true));
    button.addEventListener('pointercancel', () => endIconDrag(button, false));
  };

  // --- Buddy side panel ----------------------------------------------------------------
  // The panel app (registry `buddy`) is not a window: the taskbar button toggles a
  // fixed right-third aside. The iframe is created once, on first open, with the same
  // attributes the window manager gives app iframes (loadApp); closing only hides the
  // panel, so the chat and any loaded model survive. The frame is never in `views`, so
  // the window message path ignores it; its own messages are handled below.
  const buddyButton = shell.querySelector('[data-buddy-toggle]');
  const buddyPanel = shell.querySelector('#pc-buddy');
  let buddyFrame = null;
  const isBuddyOpen = () => buddyPanel?.dataset.open === 'true';
  const ensureBuddyFrame = () => {
    if (buddyFrame?.isConnected) return buddyFrame;
    const frame = document.createElement('iframe');
    frame.title = 'Buddy';
    frame.className = 'pc-app-frame';
    frame.src = buddy.src;
    buddyPanel.querySelector('.pc-buddy-body').append(frame);
    return (buddyFrame = frame);
  };
  const setBuddyOpen = open => {
    buddyPanel.dataset.open = String(open);
    buddyButton.setAttribute('aria-expanded', String(open));
    buddyPanel.toggleAttribute('inert', !open);
    if (open) ensureBuddyFrame();
  };
  const openBuddy = () => { setBuddyOpen(true); buddyFrame.focus(); };
  const closeBuddy = () => { if (!isBuddyOpen()) return; setBuddyOpen(false); buddyButton.focus(); };
  if (buddyButton && buddyPanel) {
    // The panel ends at the taskbar's top edge, so Buddy's composer is never under the taskbar.
    const taskbar = shell.querySelector('.pc-taskbar');
    new ResizeObserver(() => shell.style.setProperty('--pc-taskbar-height', `${taskbar.offsetHeight}px`)).observe(taskbar);
    buddyButton.addEventListener('click', () => isBuddyOpen() ? closeBuddy() : openBuddy());
    window.addEventListener('message', event => {
      if (event.origin !== location.origin || !buddyFrame || event.source !== buddyFrame.contentWindow) return;
      if (event.data?.type === 'pc:ready') buddyFrame.contentWindow.postMessage({ type: 'pc:theme', theme: document.documentElement.dataset.theme ?? 'dark' }, location.origin);
      if (event.data?.type === 'pc:panel-close') closeBuddy();
    });
  }

  function dispatch(action) {
    state = reduceDesktop(state, action, bounds());
    render();
  }

  function toggleLauncher(open = launcher.hidden) {
    launcher.hidden = !open;
    launcherToggle.setAttribute('aria-expanded', String(open));
    if (open) {
      appSearch.value = '';
      appCategory.value = 'all';
      filterLauncher();
      appSearch.focus();
    }
  }

  function filterLauncher() {
    const matches = new Set(filterApps(apps, appSearch.value, appCategory.value).map(app => app.id));
    launcher.querySelectorAll('[data-app-result]').forEach(button => { button.hidden = !matches.has(button.dataset.appResult); });
    launcher.querySelector('[data-app-empty]').hidden = matches.size > 0;
  }
  appSearch.addEventListener('input', filterLauncher);
  appCategory.addEventListener('change', filterLauncher);
  appSearch.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === 'ArrowDown') {
      const first = launcher.querySelector('[data-app-result]:not([hidden])');
      if (first) { event.preventDefault(); event.key === 'Enter' ? first.click() : first.focus(); }
    }
  });

  function openApp(id) {
    const app = appById(id);
    if (!app) return;
    toggleLauncher(false);
    if (app.kind === 'external') {
      window.open(app.src, '_blank', 'noopener,noreferrer');
      announce(`${app.title.replace(' ↗', '')} opens in a new tab`);
      return;
    }
    dispatch({ type: 'open', id, app });
    views.get(id).title.focus({ preventScroll: true });
    announce(`${app.title} opened`);
  }

  function setLoadState(view, phase) {
    view.element.dataset.load = phase;
    view.content.setAttribute('aria-busy', String(phase === 'loading'));
    view.status.hidden = phase === 'ready';
    view.status.querySelector('h2').textContent = phase === 'error' ? `${view.app.title} couldn’t open` : `Opening ${view.app.title}`;
    view.status.querySelector('p').textContent = phase === 'error' ? 'The app did not finish loading. Try again or open it in a separate tab.' : 'Getting your workspace ready…';
    view.status.querySelector('[data-retry]').hidden = phase !== 'error';
    view.status.querySelector('a').hidden = phase !== 'error';
    if (phase !== 'loading') clearTimeout(view.timer);
    if (phase === 'error') announce(`${view.app.title} could not load. Retry is available.`);
  }

  function loadApp(view) {
    clearTimeout(view.timer);
    setLoadState(view, 'loading');
    view.frame?.remove();
    const frame = document.createElement('iframe');
    frame.title = view.app.title;
    frame.className = 'pc-app-frame';
    // Only same-origin registry entries are supported. Apps own their saved data.
    frame.src = view.app.src;
    frame.addEventListener('load', () => {
      try {
        const doc = frame.contentDocument;
        if (!doc || /404|not found/i.test(doc.title)) { setLoadState(view, 'error'); return; }
        doc.addEventListener('pointerdown', () => dispatch({ type: 'focus', id: view.app.id }), true);
        doc.addEventListener('focusin', () => dispatch({ type: 'focus', id: view.app.id }));
      } catch { setLoadState(view, 'error'); }
    });
    frame.addEventListener('error', () => setLoadState(view, 'error'));
    view.frame = frame;
    view.content.prepend(frame);
    view.timer = setTimeout(() => setLoadState(view, 'error'), view.app.loadTimeout ?? 20000);
  }

  function createView(app) {
    const element = document.createElement('section');
    element.className = 'pc-window';
    element.dataset.window = app.id;
    element.setAttribute('role', 'dialog');
    element.setAttribute('aria-modal', 'false');
    element.setAttribute('aria-label', app.title);
    element.innerHTML = `<header class="pc-window-bar"><button type="button" class="pc-window-title" data-move></button><div class="pc-window-controls"><button type="button" data-minimize title="Minimize"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 11h10"/></svg></button><button type="button" data-maximize title="Maximize"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3.5" y="3.5" width="9" height="9" rx=".5"/></svg></button><button type="button" data-close title="Close"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8m0-8-8 8"/></svg></button></div></header><div class="pc-window-content"></div><button type="button" class="pc-resize" title="Resize window; use arrow keys"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m5 13 8-8m-3 8 3-3"/></svg></button>`;
    const title = element.querySelector('[data-move]');
    title.append(icon(app.id), document.createTextNode(app.title));
    title.setAttribute('aria-label', `${app.title} window title; arrow keys move, Shift and arrows resize`);
    title.title = 'Drag to move · double-click to maximize · arrows move · Shift + arrows resize';
    for (const action of ['minimize', 'maximize', 'close']) element.querySelector(`[data-${action}]`).setAttribute('aria-label', `${action[0].toUpperCase() + action.slice(1)} ${app.title}`);
    element.querySelector('.pc-resize').setAttribute('aria-label', `Resize ${app.title}`);
    const content = element.querySelector('.pc-window-content');
    const task = document.createElement('button');
    task.type = 'button';
    task.className = 'pc-task';
    task.dataset.task = app.id;
    task.append(icon(app.id));
    const label = document.createElement('span');
    label.textContent = app.title;
    task.append(label);
    task.setAttribute('aria-label', `Switch to ${app.title}`);
    const view = { app, element, title, content, task, frame: null, timer: null, status: null };
    views.set(app.id, view);
    windowLayer.append(element);
    tasks.append(task);

    if (app.kind === 'about') content.append(document.querySelector('#pc-about-content').content.cloneNode(true));
    else {
      const status = document.createElement('div');
      status.className = 'pc-app-status';
      status.setAttribute('role', 'status');
      status.innerHTML = '<div class="pc-loading-mark" aria-hidden="true"></div><h2></h2><p></p><div><button type="button" class="pc-primary" data-retry>Try again</button><a target="_blank" rel="noopener">Open separately ↗</a></div>';
      status.querySelector('a').href = app.src;
      status.querySelector('[data-retry]').addEventListener('click', () => loadApp(view));
      content.append(status);
      view.status = status;
      loadApp(view);
    }
    element.addEventListener('pointerdown', () => {
      if (state.activeId !== app.id) dispatch({ type: 'focus', id: app.id });
    });
    element.addEventListener('focusin', () => {
      if (state.activeId !== app.id) dispatch({ type: 'focus', id: app.id });
    });
    element.querySelector('[data-minimize]').addEventListener('click', () => {
      dispatch({ type: 'minimize', id: app.id });
      task.focus();
      announce(`${app.title} minimized`);
    });
    element.querySelector('[data-maximize]').addEventListener('click', () => dispatch({ type: 'maximize', id: app.id }));
    element.querySelector('[data-close]').addEventListener('click', () => {
      try {
        if (view.frame?.contentWindow?.pcBeforeClose?.() === false) {
          announce(`${app.title} could not save. Keep this window open and export a backup.`);
          return;
        }
      } catch {
        announce(`${app.title} could not save. Keep this window open and export a backup.`);
        return;
      }
      dispatch({ type: 'close', id: app.id });
      const next = views.get(state.activeId)?.title ?? shell.querySelector(`[data-shortcut="${app.id}"]`);
      next.focus({ preventScroll: true });
      announce(`${app.title} closed`);
    });
    task.addEventListener('click', () => {
      const win = state.windows.find(win => win.id === app.id);
      const minimize = state.activeId === app.id && !win.minimized;
      dispatch({ type: minimize ? 'minimize' : 'focus', id: app.id });
      if (!minimize) title.focus({ preventScroll: true });
    });
    title.addEventListener('dblclick', () => dispatch({ type: 'maximize', id: app.id }));
    wireGeometry(title, app.id, false);
    wireGeometry(element.querySelector('.pc-resize'), app.id, true);
    return view;
  }

  function render() {
    for (const [id, view] of views) {
      if (!state.windows.some(win => win.id === id)) {
        // Closing removes the task, but caches the iframe so pending saves finish.
        view.element.hidden = true;
        view.task.remove();
      }
    }
    state.windows.forEach((win, index) => {
      const view = views.get(win.id) ?? createView(appById(win.id));
      if (!view.task.isConnected) tasks.append(view.task);
      const rect = windowRect(win, bounds());
      Object.assign(view.element.style, { left: `${rect.x}px`, top: `${rect.y}px`, width: `${rect.width}px`, height: `${rect.height}px`, zIndex: String(index + 1) });
      view.element.hidden = win.minimized;
      view.element.dataset.active = String(state.activeId === win.id);
      view.element.dataset.maximized = String(win.maximized || bounds().width < MOBILE_WIDTH);
      view.task.setAttribute('aria-pressed', String(state.activeId === win.id && !win.minimized));
      view.task.dataset.minimized = String(win.minimized);
      view.task.title = `${view.app.title}${win.minimized ? ' — minimized' : ''}`;
      view.element.querySelector('[data-maximize]').setAttribute('aria-label', `${win.maximized ? 'Restore' : 'Maximize'} ${view.app.title}`);
      view.element.querySelector('[data-maximize]').title = win.maximized ? 'Restore' : 'Maximize';
    });
  }

  function wireGeometry(handle, id, resize) {
    handle.addEventListener('pointerdown', event => {
      const win = state.windows.find(win => win.id === id);
      if (event.button !== 0 || win.maximized || bounds().width < MOBILE_WIDTH) return;
      event.preventDefault();
      handle.focus({ preventScroll: true });
      dispatch({ type: 'focus', id });
      const initial = { ...win.rect };
      const start = { x: event.clientX, y: event.clientY };
      handle.setPointerCapture(event.pointerId);
      shell.classList.add('pc-interacting');
      const move = event => {
        const dx = event.clientX - start.x;
        const dy = event.clientY - start.y;
        dispatch({ type: 'rect', id, rect: resize
          ? { ...initial, width: initial.width + dx, height: initial.height + dy }
          : { ...initial, x: initial.x + dx, y: initial.y + dy } });
      };
      const finish = () => {
        shell.classList.remove('pc-interacting');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', finish);
        handle.removeEventListener('pointercancel', finish);
        handle.removeEventListener('lostpointercapture', finish);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
      handle.addEventListener('lostpointercapture', finish);
    });
    handle.addEventListener('keydown', event => {
      const deltas = { ArrowLeft: [-20, 0], ArrowRight: [20, 0], ArrowUp: [0, -20], ArrowDown: [0, 20] };
      if (!deltas[event.key]) return;
      event.preventDefault();
      const win = state.windows.find(win => win.id === id);
      const [dx, dy] = deltas[event.key];
      dispatch({ type: 'rect', id, rect: resize || event.shiftKey
        ? { ...win.rect, width: win.rect.width + dx, height: win.rect.height + dy }
        : { ...win.rect, x: win.rect.x + dx, y: win.rect.y + dy } });
    });
  }

  shell.querySelectorAll('[data-shortcut]').forEach(button => {
    button.addEventListener('click', event => {
      shell.querySelectorAll('[data-shortcut]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
      if (suppressedClick === button) { suppressedClick = null; return; } // long-press opened the menu
      if (clicksSuppressed(button)) return; // a drag just ended; it must not open the app
      if (event.detail === 0 || event.pointerType === 'touch' || matchMedia('(pointer: coarse)').matches) openApp(button.dataset.shortcut);
    });
    button.addEventListener('dblclick', () => { if (clicksSuppressed(button)) return; openApp(button.dataset.shortcut); });
    wireLongPress(button);
    wireIconDrag(button);
  });
  shell.querySelectorAll('[data-open-app]').forEach(button => button.addEventListener('click', () => {
    if (suppressedClick === button) { suppressedClick = null; return; }
    openApp(button.dataset.openApp);
  }));
  shell.querySelectorAll('.pc-launcher-app').forEach(wireLongPress);
  launcherToggle.addEventListener('click', () => toggleLauncher());
  document.addEventListener('pointerdown', event => {
    if (!launcher.hidden && !launcher.contains(event.target) && !launcherToggle.contains(event.target)) toggleLauncher(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key !== 'Escape') return; // Escape inside Buddy arrives as pc:panel-close
    if (!launcher.hidden) { toggleLauncher(false); launcherToggle.focus(); }
  });
  shell.querySelector('[data-show-desktop]').addEventListener('click', () => {
    state.windows.forEach(win => { state = reduceDesktop(state, { type: 'minimize', id: win.id }, bounds()); });
    render();
    announce('All windows minimized');
  });
  window.addEventListener('message', event => {
    if (event.origin !== location.origin) return;
    const view = views.get(event.data?.appId);
    if (!view || event.source !== view.frame?.contentWindow) return;
    if (event.data.type === 'pc:ready') {
      setLoadState(view, 'ready');
      view.frame.contentWindow.postMessage({ type: 'pc:theme', theme: document.documentElement.dataset.theme ?? 'dark' }, location.origin);
    }
    if (event.data.type === 'pc:focus' && state.windows.some(win => win.id === view.app.id && !win.minimized)) dispatch({ type: 'focus', id: view.app.id });
  });
  new ResizeObserver(() => { dispatch({ type: 'bounds' }); applyIconLayout(); }).observe(workspace);
  applyIconLayout(); // the initial layout before the observer's first callback
  shell.querySelector('[data-theme-toggle]').addEventListener('click', () => {
    const theme = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('theme', theme); } catch {}
    for (const view of views.values()) view.frame?.contentWindow?.postMessage({ type: 'pc:theme', theme }, location.origin);
    if (buddyFrame?.isConnected) buddyFrame.contentWindow.postMessage({ type: 'pc:theme', theme }, location.origin);
  });
  const clock = shell.querySelector('[data-clock]');
  const updateClock = () => {
    const now = new Date();
    clock.dateTime = now.toISOString();
    clock.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    clock.title = now.toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  };
  updateClock();
  setInterval(updateClock, 15000);
}
