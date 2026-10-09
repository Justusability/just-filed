// Small DOM pieces shared by the toolbar pane (popup/) and the Tidy up side panel (panel/).

import { hostOf } from './ranker.js';

export const pause = (ms) => new Promise((r) => setTimeout(r, ms));

export const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
};

export const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.4l3.1 3.1 6.5-7"/></svg>';
export const PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';

export const whereBlock = (path, sub) =>
  el(
    'span',
    { className: 'where' },
    ...(path.length > 1 ? [el('span', { className: 'parent', textContent: path.slice(0, -1).join(' / ') })] : []),
    el('span', { className: 'leaf', textContent: path.at(-1) || 'Bookmarks' }),
    ...(sub ? [el('span', { className: 'reason', textContent: sub })] : [])
  );

export const filedCard = (path) => {
  const dot = el('span', { className: 'dot' });
  dot.innerHTML = TICK;
  return el('div', { className: 'filed' }, dot, whereBlock(path));
};

// Where a bookmark sits, said briefly: its folder and that folder's parent, without the root.
export const shortPlace = (path) => path.slice(1).slice(-2).join(' / ') || path.at(-1) || 'Bookmarks';

// Hand-drawn arrow that curls down from the question towards the suggestions.
// "Hand drawn arrow" by Max Miner from Noun Project (https://thenounproject.com/browse/icons/term/hand-drawn-arrow/), CC BY 3.0
// (https://creativecommons.org/licenses/by/3.0/). Credited in the settings pane and README.
const ARROW_PATH = 'M73.61 41.7C75.05 42.53 76.07 43.07 77.05 43.7C78.45 44.59 78.86 45.6 78.19 46.55C78.0477 46.7852 77.8571 46.9874 77.6308 47.1433C77.4045 47.2993 77.1476 47.4053 76.8772 47.4545C76.6068 47.5037 76.329 47.4948 76.0623 47.4285C75.7955 47.3622 75.5459 47.24 75.33 47.07C72.0479 45.0959 68.205 44.2626 64.4 44.7C63.8638 44.8247 63.3002 44.7398 62.8244 44.4629C62.3486 44.186 61.9965 43.7378 61.84 43.21C61.6838 42.6783 61.7265 42.108 61.9603 41.6055C62.194 41.1031 62.6027 40.703 63.11 40.48C66.5792 38.5005 69.458 35.632 71.45 32.17C71.5571 31.916 71.7156 31.6869 71.9155 31.4971C72.1154 31.3073 72.3523 31.1608 72.6115 31.0669C72.8706 30.973 73.1464 30.9337 73.4215 30.9514C73.6966 30.9692 73.965 31.0436 74.21 31.17C74.7287 31.4474 75.1214 31.9129 75.3074 32.4709C75.4934 33.0289 75.4585 33.6369 75.21 34.17C74.98 34.82 74.61 35.43 74.1 36.48C74.7598 36.2898 75.3969 36.0283 76 35.7C77.7846 34.4954 79.476 33.1583 81.06 31.7C86.99 25.63 87.28 18.4 82.06 11.7C77.59 5.87 71.7 3.5 64.48 4.25C57.83 4.95 51.67 7.25 45.71 10.15C38.54 13.58 31.47 17.21 24.31 20.67C18.93 23.27 13.41 25.52 7.43 26.33C4.96088 26.8078 2.41327 26.6878 0 25.98C0.48061 25.9135 0.964864 25.8768 1.45 25.87C6.62298 26.1765 11.7807 25.0557 16.36 22.63C21.62 19.83 26.8 16.87 31.91 13.81C39.82 9.06 47.74 4.38 56.65 1.7C60.1861 0.582572 63.8716 0.00935279 67.58 0C72.4947 0.0939161 77.2523 1.74779 81.1655 4.72269C85.0787 7.69759 87.9449 11.8395 89.35 16.55C90.85 21.94 89.69 26.93 86.58 31.5C84.1192 35.0945 80.7984 38.0165 76.92 40C76 40.49 75 40.96 73.61 41.7Z';
export function arrowMark() {
  const span = el('span', { className: 'arrow-mark' });
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 90 48"><path fill="currentColor" d="${ARROW_PATH}"/></svg>`;
  return span;
}

// The bookmark being filed or reviewed, shown plainly: its title, its site and the folder it sits in now.
// With `onOpen` it also gets an Open button, for a bookmark that is not the page in front of the user.
const BOOKMARK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5h7v11L8 10.8 4.5 13.5z"/></svg>';
export function bookmarkCard(bookmark, path, { onOpen, openHint = '', meta } = {}) {
  const icon = el('span', { className: 'bm-icon' });
  icon.innerHTML = BOOKMARK_ICON;
  const parts = [
    icon,
    el(
      'span',
      { className: 'bm-body' },
      el('span', { className: 'bm-title', textContent: bookmark.title || bookmark.url, title: bookmark.url }),
      el('span', {
        className: 'bm-meta',
        textContent: meta || `In ${shortPlace(path)} · ${hostOf(bookmark.url) || 'link'}`,
        title: path.length ? `In ${path.join(' / ')}` : bookmark.url
      })
    )
  ];
  if (onOpen) {
    const open = el('button', { className: 'bm-open', type: 'button', textContent: 'Open' });
    open.setAttribute('aria-label', `Open ${bookmark.title || 'this bookmark'}${openHint ? ` ${openHint}` : ''}`);
    open.addEventListener('click', () => onOpen(bookmark));
    parts.push(open);
  }
  return el('div', { className: onOpen ? 'bm-card' : 'bm-card no-open' }, ...parts);
}

// Bookmarks waiting in Tidy up: the last scan, minus anything the user chose to keep where it is.
export async function tidyItems() {
  const { tidy, tidyKept = {} } = await chrome.storage.local.get(['tidy', 'tidyKept']);
  return (tidy?.items || []).filter((i) => tidyKept[i.id] !== i.folderId);
}

// Opens Tidy up in Chrome's side panel. It has to be called straight from a click, with the window id
// already in hand: Chrome refuses to open a side panel once the click has been waited on.
// Browsers without a side panel get the same page in a tab.
export function openTidyPanel(windowId) {
  const inTab = () => chrome.tabs.create({ url: chrome.runtime.getURL('panel/panel.html') });
  if (!chrome.sidePanel?.open || windowId == null) return Promise.resolve(inTab());
  return chrome.sidePanel.open({ windowId }).catch(inTab);
}
