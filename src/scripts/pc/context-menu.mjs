// WebPC context menu: a role=menu rendered at the pointer (clamped to the viewport)
// from items `[{ label, action, disabled? }]`. Keys: Up/Down move (wrapping), Home/End
// jump, Enter/Space activate the focused item, Escape closes and refocuses `returnFocus`.
// Closes on outside pointerdown, on scroll (any scrollable), on resize and window blur,
// and after an action. Only one menu is open at a time.
let open = null;

export function showMenu({ x, y, items, returnFocus = null }) {
  if (open) open.close();

  const menu = document.createElement('div');
  menu.className = 'pc-context-menu';
  menu.setAttribute('role', 'menu');
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';

  const buttons = items.map(item => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'pc-context-menu-item';
    button.setAttribute('role', 'menuitem');
    button.textContent = item.label;
    if (item.disabled) button.disabled = true;
    return button;
  });
  for (const button of buttons) {
    button.addEventListener('click', () => {
      const item = items[buttons.indexOf(button)];
      state.close();
      item.action?.();
    });
    menu.append(button);
  }
  document.body.append(menu);
  // Clamp inside the viewport once the menu has laid out.
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.max(0, Math.min(x, innerWidth - rect.width))}px`;
  menu.style.top = `${Math.max(0, Math.min(y, innerHeight - rect.height))}px`;

  const enabled = buttons.filter(button => !button.disabled);
  let position = 0;
  const state = {
    close() {
      if (open !== state) return;
      open = null;
      menu.remove();
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('scroll', closeAll, true);
      window.removeEventListener('resize', closeAll);
      window.removeEventListener('blur', closeAll);
    },
  };
  const closeAll = () => state.close();
  const onPointerDown = event => { if (!menu.contains(event.target)) state.close(); };
  const onKeydown = event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      const focus = returnFocus;
      state.close();
      focus?.focus();
      return;
    }
    if (!enabled.length) return;
    if (event.key === 'ArrowDown') position = (position + 1) % enabled.length;
    else if (event.key === 'ArrowUp') position = (position - 1 + enabled.length) % enabled.length;
    else if (event.key === 'Home') position = 0;
    else if (event.key === 'End') position = enabled.length - 1;
    else return;
    event.preventDefault();
    enabled[position].focus();
  };
  menu.addEventListener('keydown', onKeydown);
  document.addEventListener('pointerdown', onPointerDown, true);
  document.addEventListener('scroll', closeAll, true);
  window.addEventListener('resize', closeAll);
  window.addEventListener('blur', closeAll);
  open = state;
  enabled[0]?.focus();
}
