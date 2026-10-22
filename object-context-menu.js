/** Accessible, reusable context menu for canvas objects and layer rows. */
export function createObjectContextMenu({ onAction, onClose } = {}) {
  const menu = document.createElement('div');
  menu.className = 'object-context-menu';
  menu.setAttribute('role', 'menu');
  menu.tabIndex = -1;
  menu.hidden = true;
  const supportsPopover = typeof menu.showPopover === 'function';
  if (supportsPopover) menu.setAttribute('popover', 'manual');
  document.body.append(menu);

  let isOpen = false;
  let returnFocus = null;
  let scrollAnchor = null;
  let buttons = [];

  function focusButton(index) {
    if (!buttons.length) {
      menu.focus({ preventScroll: true });
      return;
    }
    const next = (index + buttons.length) % buttons.length;
    buttons.forEach((button, position) => { button.tabIndex = position === next ? 0 : -1; });
    buttons[next].focus({ preventScroll: true });
  }

  function outsidePointer(event) {
    if (!menu.contains(event.target)) close();
  }

  function outsideScroll(event) {
    // A long menu can scroll without dismissing itself.
    const target = event.target;
    if (target instanceof Node && menu.contains(target)) return;
    // Selecting an image may reveal its source by scrolling the Assets panel.
    // Only scrolling the invocation surface (or its ancestors) moves this menu.
    if (target instanceof Node && scrollAnchor && !target.contains(scrollAnchor) && !scrollAnchor.contains(target)) return;
    close();
  }

  function viewportChanged() { close(); }

  function listen(enabled) {
    const method = enabled ? 'addEventListener' : 'removeEventListener';
    document[method]('pointerdown', outsidePointer, true);
    window[method]('scroll', outsideScroll, true);
    window[method]('resize', viewportChanged);
    window[method]('blur', viewportChanged);
    window.visualViewport?.[method]('scroll', viewportChanged);
    window.visualViewport?.[method]('resize', viewportChanged);
  }

  function close({ restoreFocus = false } = {}) {
    if (!isOpen) return;
    isOpen = false;
    listen(false);
    if (supportsPopover && menu.matches(':popover-open')) menu.hidePopover();
    menu.hidden = true;
    if (restoreFocus && returnFocus?.isConnected) returnFocus.focus?.({ preventScroll: true });
    returnFocus = null;
    scrollAnchor = null;
    onClose?.();
  }

  menu.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') return;
    // Native button activation still handles Enter and Space. Keep all menu
    // keystrokes away from the editor's object and clipboard shortcuts.
    event.stopPropagation();
    const current = buttons.indexOf(document.activeElement);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        focusButton(current < 0 ? 0 : current + 1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        focusButton(current < 0 ? buttons.length - 1 : current - 1);
        break;
      case 'Home':
        event.preventDefault();
        focusButton(0);
        break;
      case 'End':
        event.preventDefault();
        focusButton(buttons.length - 1);
        break;
      case 'Escape':
        event.preventDefault();
        close({ restoreFocus: true });
        break;
      case 'Tab':
        // Let the browser continue its normal tab order from the invoker.
        close({ restoreFocus: true });
        break;
    }
  });
  menu.addEventListener('keyup', event => event.stopPropagation());
  menu.addEventListener('contextmenu', event => {
    event.preventDefault();
    event.stopPropagation();
  });
  menu.addEventListener('pointerdown', event => event.stopPropagation());
  menu.addEventListener('click', event => {
    event.stopPropagation();
    const button = event.target.closest('[data-context-action]');
    if (!button || button.disabled || !menu.contains(button)) return;
    const action = button.dataset.contextAction;
    close({ restoreFocus: true });
    onAction?.(action);
  });

  function open({ x, y, title = 'Object actions', actions = [], anchor = null }) {
    const previousFocus = isOpen ? returnFocus : document.activeElement;
    close();
    returnFocus = previousFocus;
    scrollAnchor = anchor;
    menu.replaceChildren();
    menu.setAttribute('aria-label', title);
    const heading = document.createElement('div');
    heading.className = 'object-context-menu-title';
    heading.setAttribute('role', 'presentation');
    heading.textContent = title;
    menu.append(heading);

    buttons = [];
    let hasAction = false;
    let separatorPending = false;
    for (const action of actions) {
      separatorPending ||= Boolean(action.separator);
      if (action.id == null || action.label == null) continue;
      if (separatorPending && hasAction) {
        const separator = document.createElement('div');
        separator.className = 'object-context-menu-separator';
        separator.setAttribute('role', 'separator');
        menu.append(separator);
      }
      separatorPending = false;
      hasAction = true;
      const button = document.createElement('button');
      button.type = 'button';
      button.setAttribute('role', 'menuitem');
      button.dataset.contextAction = String(action.id);
      button.textContent = action.label;
      button.disabled = Boolean(action.disabled);
      button.tabIndex = -1;
      if (button.disabled) button.setAttribute('aria-disabled', 'true');
      else buttons.push(button);
      menu.append(button);
    }

    const viewport = window.visualViewport;
    const width = viewport?.width ?? window.innerWidth;
    const height = viewport?.height ?? window.innerHeight;
    const left = viewport?.offsetLeft ?? 0;
    const top = viewport?.offsetTop ?? 0;
    const margin = Math.min(8, width / 4, height / 4);
    menu.style.maxWidth = `${Math.max(1, width - margin * 2)}px`;
    menu.style.maxHeight = `${Math.max(1, height - margin * 2)}px`;
    menu.style.left = `${left + margin}px`;
    menu.style.top = `${top + margin}px`;
    menu.hidden = false;
    if (supportsPopover) menu.showPopover();
    const rect = menu.getBoundingClientRect();
    const requestedX = Number.isFinite(x) ? x : left + margin;
    const requestedY = Number.isFinite(y) ? y : top + margin;
    menu.style.left = `${Math.max(left + margin, Math.min(requestedX, left + width - rect.width - margin))}px`;
    menu.style.top = `${Math.max(top + margin, Math.min(requestedY, top + height - rect.height - margin))}px`;
    isOpen = true;
    focusButton(0);
    listen(true);
  }

  return { open, close, get isOpen() { return isOpen; } };
}
