import { element } from './ui.mjs';

// Popups keep this distance from the viewport edges.
const VIEWPORT_MARGIN = 4;

const tooltips = new Set();
let menu = null;
let menuListenersBound = false;
let tooltipListenersBound = false;

function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(value, maximum));
}

function horizontalPosition(anchor, width, align) {
  if (align === 'end') return anchor.right - width;
  if (align === 'center') return anchor.left + anchor.width / 2 - width / 2;
  return anchor.left;
}

function verticalPosition(anchor, height, { side, gap, fit }) {
  const bottomLimit = window.innerHeight - height - VIEWPORT_MARGIN;
  if (side === 'above') {
    const above = anchor.top - height - gap;
    return above >= VIEWPORT_MARGIN ? above : Math.min(anchor.bottom + gap, bottomLimit);
  }
  if (fit === 'shift') return clamp(anchor.bottom + gap, VIEWPORT_MARGIN, bottomLimit);
  return window.innerHeight - anchor.bottom >= height + VIEWPORT_MARGIN
    ? anchor.bottom + gap
    : Math.max(VIEWPORT_MARGIN, anchor.top - height - gap);
}

// Places a popup next to an anchor rectangle. `align` chooses the horizontal edge (start, end or
// center); `side` the preferred side; `fit` decides whether a popup that does not fit below flips
// above the anchor or shifts up to stay inside the viewport.
export function placePopup(node, anchor, { align = 'start', side = 'below', gap = 0, fit = 'flip' } = {}) {
  const width = node.offsetWidth;
  const height = node.offsetHeight;
  node.style.left = clamp(horizontalPosition(anchor, width, align), VIEWPORT_MARGIN, window.innerWidth - width - VIEWPORT_MARGIN) + 'px';
  node.style.top = verticalPosition(anchor, height, { side, gap, fit }) + 'px';
}

// Places a popup at a pointer position, moving it back inside the viewport when it overflows.
export function placePopupAtPoint(node, x, y) {
  node.style.left = x + 'px';
  node.style.top = y + 'px';
  const bounds = node.getBoundingClientRect();
  if (bounds.right > window.innerWidth) node.style.left = (window.innerWidth - bounds.width - VIEWPORT_MARGIN) + 'px';
  if (bounds.bottom > window.innerHeight) node.style.top = (window.innerHeight - bounds.height - VIEWPORT_MARGIN) + 'px';
}

function placeMenu() {
  if (menu.point) placePopupAtPoint(menu.node, menu.point.x, menu.point.y);
  else placePopup(menu.node, menu.trigger.getBoundingClientRect(), menu.placement);
}

function closeOnOutsideClick(event) {
  if (!menu || menu.node?.contains(event.target) || menu.trigger?.contains(event.target)) return;
  closeMenu();
}

function closeOnEscape(event) {
  if (event.key !== 'Escape' || !menu) return;
  const restoreFocus = menu.trigger && menu.node?.contains(document.activeElement);
  const trigger = menu.trigger;
  closeMenu();
  if (restoreFocus) trigger.focus();
}

function closeMenuFromEvent() {
  closeMenu();
}

function bindMenuListeners() {
  if (menuListenersBound) return;
  menuListenersBound = true;
  document.addEventListener('click', closeOnOutsideClick);
  document.addEventListener('keydown', closeOnEscape);
}

// Opens the single active menu, closing any other one. A menu belongs to an owner name so that
// modules close only their own menu. The content may be supplied later with setMenuContent while
// the menu waits for data; until then outside clicks and Escape still cancel it.
export function openMenu({ owner, trigger = null, content = null, point = null, placement = {}, focusFirst = false,
  closeOnScroll = null, closeOnResize = false, onClose = null }) {
  closeMenu();
  bindMenuListeners();
  menu = { owner, trigger, node: null, point, placement, focusFirst, closeOnScroll, closeOnResize, onClose };
  closeOnScroll?.addEventListener('scroll', closeMenuFromEvent, true);
  if (closeOnResize) window.addEventListener('resize', closeMenuFromEvent);
  if (content) setMenuContent(owner, content);
}

export function setMenuContent(owner, content) {
  if (!menu || menu.owner !== owner || menu.node) return;
  menu.node = content;
  document.body.append(content);
  placeMenu();
  menu.trigger?.setAttribute('aria-expanded', 'true');
  if (menu.focusFirst) content.querySelector('button')?.focus();
}

export function isMenuOpen(owner, trigger = null) {
  return !!menu && menu.owner === owner && (!trigger || menu.trigger === trigger);
}

export function menuContent(owner) {
  return menu && menu.owner === owner ? menu.node : null;
}

export function closeMenu(owner = null) {
  if (!menu || (owner && menu.owner !== owner)) return;
  const closing = menu;
  menu = null;
  closing.node?.remove();
  closing.trigger?.setAttribute('aria-expanded', 'false');
  closing.closeOnScroll?.removeEventListener('scroll', closeMenuFromEvent, true);
  if (closing.closeOnResize) window.removeEventListener('resize', closeMenuFromEvent);
  closing.onClose?.();
}

function bindTooltipListeners() {
  if (tooltipListenersBound) return;
  tooltipListenersBound = true;
  window.addEventListener('resize', refreshTooltips);
  window.addEventListener('scroll', refreshTooltips, true);
  window.addEventListener('blur', () => hideTooltips());
}

// Creates a hover tooltip shown next to the button under the pointer or keyboard focus. Each bound
// button supplies a render function that fills the tooltip and returns false when there is nothing
// to show; `placement` is a placePopup option object or a function of the button.
export function createTooltip(className, placement) {
  const node = element('div', className ? 'tooltip ' + className : 'tooltip');
  node.hidden = true;
  document.body.append(node);
  bindTooltipListeners();
  const renderers = new WeakMap();
  let anchor = null;
  const tooltip = {
    node,
    get anchor() {
      return anchor;
    },
    bind(button, render) {
      renderers.set(button, render);
      button.addEventListener('mouseenter', () => tooltip.show(button));
      button.addEventListener('mouseleave', () => tooltip.hide(button));
      button.addEventListener('focus', () => tooltip.show(button));
      button.addEventListener('blur', () => tooltip.hide(button));
    },
    show(button) {
      anchor = button;
      tooltip.refresh();
    },
    hide(button = null) {
      if (button && anchor !== button) return;
      anchor = null;
      node.hidden = true;
    },
    refresh() {
      if (!anchor) return;
      if (!anchor.isConnected || !anchor.getClientRects().length || renderers.get(anchor)(node, anchor) === false) {
        tooltip.hide();
        return;
      }
      node.hidden = false;
      placePopup(node, anchor.getBoundingClientRect(), typeof placement === 'function' ? placement(anchor) : placement);
    },
  };
  tooltips.add(tooltip);
  return tooltip;
}

export function refreshTooltips() {
  tooltips.forEach((tooltip) => tooltip.refresh());
}

export function hideTooltips() {
  tooltips.forEach((tooltip) => tooltip.hide());
}
