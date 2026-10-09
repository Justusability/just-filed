import { buildIndex, scoreAll, searchFolders, hostOf, pathOf, WEIGHTS } from '../src/ranker.js';
import { combine, LEVELS } from '../src/semantic.js';
import { bumpLearned } from '../src/learn.js';

const app = document.getElementById('app');
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const POPUP_MAX = 596; // Chrome's popup height limit is 600px

const el = (tag, props = {}, ...children) => {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
};

const TICK = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.4l3.1 3.1 6.5-7"/></svg>';
const PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 3v10M3 8h10"/></svg>';

const whereBlock = (path, sub) =>
  el(
    'span',
    { className: 'where' },
    ...(path.length > 1 ? [el('span', { className: 'parent', textContent: path.slice(0, -1).join(' / ') })] : []),
    el('span', { className: 'leaf', textContent: path.at(-1) || 'Bookmarks' }),
    ...(sub ? [el('span', { className: 'reason', textContent: sub })] : [])
  );

const filedCard = (path) => {
  const dot = el('span', { className: 'dot' });
  dot.innerHTML = TICK;
  return el('div', { className: 'filed' }, dot, whereBlock(path));
};

// What the popup is about: the bookmark for the page in front of the user if there is one,
// the page itself if it is not bookmarked yet, or the bookmark that was saved a moment ago.
async function getContext() {
  let { pending } = await chrome.storage.session.get('pending');
  if (pending) {
    try {
      await chrome.bookmarks.get(pending.bookmarkId);
    } catch {
      pending = null;
      await chrome.storage.session.remove('pending');
    }
  }

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {
    /* no tab access: fall back to the last saved bookmark */
  }
  const tabUrl = tab?.url && /^https?:/.test(tab.url) ? tab.url : '';

  if (tabUrl) {
    const matches = (await chrome.bookmarks.search({ url: tabUrl })).filter((m) => m.url);
    if (matches.length) {
      const node =
        (pending && matches.find((m) => m.id === pending.bookmarkId)) ||
        matches.sort((a, b) => (b.dateAdded || 0) - (a.dateAdded || 0))[0];
      return { mode: 'move', pending, bookmark: node };
    }
    return { mode: 'create', pending, bookmark: { title: tab.title || tabUrl, url: tabUrl } };
  }
  if (pending) {
    const [node] = await chrome.bookmarks.get(pending.bookmarkId);
    return { mode: 'move', pending, bookmark: node };
  }
  return null;
}

let state;

let tidyCount = 0;

// Each new screen eases in; typing and small updates do not replay it.
function enter() {
  app.classList.remove('enter');
  void app.offsetWidth;
  app.classList.add('enter');
  app.querySelector('.suggestions')?.classList.add('enter');
}

async function load() {
  await chrome.action.setBadgeText({ text: '' });
  tidyCount = (await tidyItems()).length;
  const { welcomed } = await chrome.storage.local.get('welcomed');
  if (!welcomed) return renderWelcome();
  const ctx = await getContext();
  if (!ctx) return renderEmpty();

  const [tree, { learned, settings }] = await Promise.all([chrome.bookmarks.getTree(), chrome.storage.local.get(['learned', 'settings'])]);
  const minLead = LEVELS[settings?.sensitivity] ?? LEVELS.balanced;
  const index = buildIndex(tree, { excludeId: ctx.bookmark.id });
  const scored = scoreAll(ctx.bookmark, index, learned || {});
  const currentFolderId = ctx.mode === 'move' ? ctx.bookmark.parentId : null;
  const { options, confident } = combine(scored, null, index, currentFolderId);

  state = {
    ...ctx,
    index,
    options,
    confident,
    misfit: false,
    currentFolderId,
    currentPath: currentFolderId ? pathOf(index, currentFolderId) : [],
    boost: new Map(scored.map((s) => [s.id, s.score])),
    host: hostOf(ctx.bookmark.url)
  };
  renderPicker();

  // The rules answer at once; the on-device model follows and sharpens the list.
  const mine = state;
  chrome.runtime
    .sendMessage({ type: 'jf-semantic', bookmark: { id: ctx.bookmark.id, title: ctx.bookmark.title, url: ctx.bookmark.url } })
    .then((reply) => {
      if (!reply?.scores || state !== mine || !mine.repaint) return;
      const next = combine(scored, reply.scores, index, currentFolderId, { minLead });
      Object.assign(mine, { options: next.options, confident: next.confident, misfit: next.misfit });
      mine.boost = new Map(next.blended.map((s) => [s.id, s.score]));
      mine.repaint();
    })
    .catch(() => {});
}

function renderEmpty() {
  app.replaceChildren(
    el('p', { className: 'kicker', textContent: 'Ready' }),
    el('h1', { textContent: 'Open a page to file it.' }),
    el('p', {
      className: 'lede',
      textContent: 'Just Filed works on web pages. Open one, then click here or bookmark it with the star.'
    })
  );
  paintTidySlot(true);
  enter();
}

// Where a brand new folder goes: beside the folder the bookmark is in now,
// or under a named parent when the user types "Parent / New name".
function newFolderTarget(query) {
  const byId = (id) => state.index.folders.find((f) => f.id === id);
  const parts = query.split('/').map((p) => p.trim());
  const name = parts.pop();
  if (!name) return null;

  let parent;
  if (parts.length && parts.join('').length) parent = searchFolders(state.index, parts.join(' '), { limit: 1 })[0];
  if (!parent) {
    const current = byId(state.currentFolderId);
    parent = (current && byId(current.parentId)) || current || state.index.folders[0];
  }
  if (!parent) return null;
  const exists = state.index.folders.some((f) => f.parentId === parent.id && f.path.at(-1).toLowerCase() === name.toLowerCase());
  return exists ? null : { name, parentId: parent.id, parentPath: parent.path };
}

function itemsFor(query) {
  if (!query.trim()) return state.options.map((o) => ({ kind: 'folder', id: o.id, path: o.path, sub: o.reason }));
  const found = searchFolders(state.index, query, { boost: state.boost, excludeId: state.currentFolderId }).map((f) => ({
    kind: 'folder',
    id: f.id,
    path: f.path,
    sub: f.count === 1 ? '1 bookmark' : `${f.count} bookmarks`
  }));
  const fresh = newFolderTarget(query);
  if (fresh) found.push({ kind: 'create', ...fresh, path: [...fresh.parentPath, fresh.name] });
  return found;
}

function renderPicker() {
  const { mode, bookmark, confident, currentPath } = state;
  const heading = el('h1');
  const title = () => {
    heading.replaceChildren();
    if (mode === 'tidy' && state.tidy.item.kind === 'unsorted') heading.append('Where does this bookmark ', el('em', { textContent: 'belong?' }), arrowMark());
    else if (mode === 'tidy') heading.append('This bookmark looks ', el('em', { textContent: 'out of place.' }));
    else if (mode === 'create') heading.append('Where should ', el('em', { textContent: 'this go?' }));
    else if (state.misfit) heading.append('This looks like it belongs ', el('em', { textContent: 'somewhere else.' }));
    else if (state.confident) heading.append('Move it to a ', el('em', { textContent: 'better folder?' }));
    else heading.append('Filed. ', el('em', { textContent: 'Wrong place?' }));
  };
  title();

  const input = el('input', {
    type: 'text',
    className: 'search',
    placeholder: 'Find a folder, or name a new one',
    autocomplete: 'off',
    spellcheck: false
  });
  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-label', 'Find a folder, or name a new one');
  input.setAttribute('aria-controls', 'results');
  input.setAttribute('aria-expanded', 'true');
  input.setAttribute('aria-autocomplete', 'list');

  const list = el('ul', { className: 'suggestions', id: 'results' });
  list.setAttribute('role', 'listbox');
  const note = el('p', { className: 'lede' });
  const hint = el('span', { className: 'hint' });

  let items = [];
  let selected = 0;
  let painted = false;

  // Chrome cuts popups off at 600px tall. Give the list whatever room the rest of the pane leaves,
  // so a long page title or a two-line heading makes the list scroll instead of the whole pane.
  const fitList = () => {
    const rest = document.body.offsetHeight - list.offsetHeight;
    list.style.maxHeight = `${Math.max(140, Math.min(318, POPUP_MAX - rest))}px`;
  };

  const paint = () => {
    // Only the first paint eases in. After that, typing, arrow keys and hovering repaint the list
    // instantly, so the results do not flicker on every keystroke.
    if (painted) list.classList.remove('enter');
    painted = true;
    list.replaceChildren(
      ...items.map((item, i) => {
        const badge = el('span', { className: item.kind === 'create' ? 'num new' : 'num' });
        if (item.kind === 'create') badge.innerHTML = PLUS;
        else badge.textContent = String(i + 1);
        badge.setAttribute('aria-hidden', 'true');
        const body =
          item.kind === 'create'
            ? el(
                'span',
                { className: 'where' },
                el('span', { className: 'leaf', textContent: `Create “${item.name}”` }),
                el('span', { className: 'reason', textContent: `New folder in ${item.parentPath.at(-1)}` })
              )
            : whereBlock(item.path, item.sub);
        const row = el('li', { className: 'suggestion', id: `opt-${i}` }, badge, body);
        row.setAttribute('role', 'option');
        row.setAttribute('aria-selected', String(i === selected));
        row.addEventListener('click', () => choose(item));
        row.addEventListener('mousemove', () => {
          if (selected !== i) {
            selected = i;
            paint();
          }
        });
        return row;
      })
    );
    if (items.length) input.setAttribute('aria-activedescendant', `opt-${selected}`);
    else input.removeAttribute('aria-activedescendant');
    fitList();
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
  };

  const refresh = () => {
    const q = input.value;
    items = itemsFor(q);
    selected = 0;
    const typing = Boolean(q.trim());
    if (!items.length) note.textContent = typing ? 'Nothing else matches.' : 'Type to find any folder, or name a new one.';
    else note.textContent = 'These are the closest other folders.';
    note.hidden = items.length > 0 && (typing || mode === 'create' || mode === 'tidy' || state.confident);
    hint.textContent = items.length ? '↑ ↓ to choose · Enter to file' : '';
    paint();
  };

  input.addEventListener('input', refresh);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!items.length) return;
      selected = (selected + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
      paint();
    } else if (e.key === 'Enter' && items[selected]) {
      e.preventDefault();
      choose(items[selected]);
    }
  });

  const dismiss = el('button', {
    className: 'pill quiet',
    type: 'button',
    textContent: mode === 'create' ? 'Not now' : 'Keep it here'
  });
  dismiss.addEventListener('click', () => (mode === 'tidy' ? tidyKeep() : window.close()));

  let actions;
  let kicker;
  if (mode === 'tidy') {
    const { queue, i } = state.tidy;
    kicker = `Tidy up · ${i + 1} of ${queue.length}`;
    const skip = el('button', { className: 'pill quiet', type: 'button', textContent: 'Skip' });
    skip.addEventListener('click', () => tidyStep(state.tidy.queue, state.tidy.i + 1, { ...state.tidy.tally, skipped: state.tidy.tally.skipped + 1 }));
    const stop = el('button', { className: 'pill quiet', type: 'button', textContent: 'Stop' });
    stop.addEventListener('click', () => renderTidyDone(state.tidy.tally, state.tidy.queue.length - state.tidy.i));
    actions = el('div', { className: 'actions compact' }, dismiss, skip, stop);
  } else {
    kicker = mode === 'create' ? 'New bookmark' : 'Saved';
    actions = el('div', { className: 'actions' }, dismiss, hint);
  }

  const subject =
    mode === 'tidy'
      ? bookmarkCard(bookmark, currentPath)
      : bookmarkCard(bookmark, currentPath, {
          open: false,
          meta:
            mode === 'create'
              ? `Not bookmarked yet · ${hostOf(bookmark.url) || 'this page'}`
              : `In ${currentPath.slice(1).slice(-2).join(' / ') || currentPath.at(-1) || 'Bookmarks'} · ${hostOf(bookmark.url) || 'link'}`
        });

  app.replaceChildren(
    el('p', { className: 'kicker', textContent: kicker }),
    heading,
    subject,
    input,
    note,
    list,
    actions
  );
  paintTidySlot(mode !== 'tidy');
  refresh();
  enter();
  input.focus();
  // Lets late results from the on-device model update the list, unless the user is already typing.
  state.repaint = () => {
    if (!app.contains(input)) return;
    title();
    if (!input.value.trim()) {
      refresh();
      list.classList.remove('enter');
      void list.offsetWidth; // restart the stagger so updated suggestions arrive gently too
      list.classList.add('enter');
    }
  };
}

let busy = false;
async function choose(item) {
  if (busy) return;
  busy = true;
  try {
    let createdFolderId = null;
    let targetId = item.id;
    if (item.kind === 'create') {
      const folder = await chrome.bookmarks.create({ parentId: item.parentId, title: item.name });
      createdFolderId = targetId = folder.id;
    }
    if (state.mode === 'tidy') await tidyMove(targetId, item.path, createdFolderId);
    else if (state.mode === 'create') await saveNew(targetId, item.path, createdFolderId);
    else await moveExisting(targetId, item.path, createdFolderId);
  } finally {
    busy = false;
  }
}

async function moveExisting(targetId, path, createdFolderId) {
  const { bookmark, currentFolderId, host } = state;
  // Make this the bookmark the service worker is tracking, so the move teaches it.
  if (!state.pending || state.pending.bookmarkId !== bookmark.id) {
    await chrome.storage.session.set({
      pending: {
        bookmarkId: bookmark.id,
        title: bookmark.title,
        url: bookmark.url,
        host,
        originalFolderId: currentFolderId,
        currentFolderId,
        learnedFolderId: null
      }
    });
  }
  await chrome.bookmarks.move(bookmark.id, { parentId: targetId });
  await pause(120); // let the service worker record the move

  renderDone('Moved', path, async () => {
    await chrome.bookmarks.move(bookmark.id, { parentId: currentFolderId });
    if (createdFolderId) await chrome.bookmarks.remove(createdFolderId).catch(() => {});
    await pause(120);
    load();
  });
}

async function saveNew(targetId, path, createdFolderId) {
  const { bookmark, host } = state;
  await chrome.storage.session.set({ skipCreated: bookmark.url });
  const node = await chrome.bookmarks.create({ parentId: targetId, title: bookmark.title, url: bookmark.url });
  await bumpLearned(host, targetId, 1);
  await chrome.storage.session.set({
    pending: {
      bookmarkId: node.id,
      title: node.title,
      url: node.url,
      host,
      originalFolderId: targetId,
      currentFolderId: targetId,
      learnedFolderId: targetId
    }
  });

  renderDone('Saved', path, async () => {
    await chrome.bookmarks.remove(node.id);
    await bumpLearned(host, targetId, -1);
    if (createdFolderId) await chrome.bookmarks.remove(createdFolderId).catch(() => {});
    await pause(120);
    load();
  });
}

// Confirmation: the tick draws itself, then the pane closes without another click.
// Undo stays reachable for that moment; pointing at it or tabbing to it holds the pane open.
const CLOSE_AFTER_MS = 1700;
function renderDone(kicker, path, undoAction) {
  let timer;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => window.close(), CLOSE_AFTER_MS);
  };
  const hold = () => clearTimeout(timer);

  const undo = el('button', { className: 'pill quiet', type: 'button', textContent: 'Undo' });
  undo.addEventListener('mouseenter', hold);
  undo.addEventListener('focus', hold);
  undo.addEventListener('mouseleave', arm);
  undo.addEventListener('blur', arm);
  undo.addEventListener(
    'click',
    () => {
      hold();
      undoAction();
    },
    { once: true }
  );

  const card = filedCard(path);
  card.classList.add('landed');
  const status = el('p', { className: 'kicker', textContent: kicker });
  status.setAttribute('role', 'status');

  app.replaceChildren(
    status,
    el('h1', { textContent: 'Just filed.' }),
    el('p', { className: 'page', textContent: state.bookmark.title || state.bookmark.url, title: state.bookmark.url }),
    card,
    el('div', { className: 'actions' }, undo, el('span', { className: 'hint', textContent: 'Closing…' }))
  );
  arm();
}

// --- Tidy up: review bookmarks that look out of place, one at a time ---

async function tidyItems() {
  const { tidy, tidyKept = {} } = await chrome.storage.local.get(['tidy', 'tidyKept']);
  return (tidy?.items || []).filter((i) => tidyKept[i.id] !== i.folderId);
}

// In Tidy up the bookmark under review is not the page in front of you, so show it plainly:
// its title, its site, the folder it sits in now, and a way to look at it.
const BOOKMARK_ICON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4.5 2.5h7v11L8 10.8 4.5 13.5z"/></svg>';
// Hand-drawn arrow that curls down from the question towards the suggestions.
// "Hand drawn arrow" by Max Miner from Noun Project (https://thenounproject.com/browse/icons/term/hand-drawn-arrow/), CC BY 3.0
// (https://creativecommons.org/licenses/by/3.0/). Credited in the settings pane and README.
const ARROW_PATH = 'M73.61 41.7C75.05 42.53 76.07 43.07 77.05 43.7C78.45 44.59 78.86 45.6 78.19 46.55C78.0477 46.7852 77.8571 46.9874 77.6308 47.1433C77.4045 47.2993 77.1476 47.4053 76.8772 47.4545C76.6068 47.5037 76.329 47.4948 76.0623 47.4285C75.7955 47.3622 75.5459 47.24 75.33 47.07C72.0479 45.0959 68.205 44.2626 64.4 44.7C63.8638 44.8247 63.3002 44.7398 62.8244 44.4629C62.3486 44.186 61.9965 43.7378 61.84 43.21C61.6838 42.6783 61.7265 42.108 61.9603 41.6055C62.194 41.1031 62.6027 40.703 63.11 40.48C66.5792 38.5005 69.458 35.632 71.45 32.17C71.5571 31.916 71.7156 31.6869 71.9155 31.4971C72.1154 31.3073 72.3523 31.1608 72.6115 31.0669C72.8706 30.973 73.1464 30.9337 73.4215 30.9514C73.6966 30.9692 73.965 31.0436 74.21 31.17C74.7287 31.4474 75.1214 31.9129 75.3074 32.4709C75.4934 33.0289 75.4585 33.6369 75.21 34.17C74.98 34.82 74.61 35.43 74.1 36.48C74.7598 36.2898 75.3969 36.0283 76 35.7C77.7846 34.4954 79.476 33.1583 81.06 31.7C86.99 25.63 87.28 18.4 82.06 11.7C77.59 5.87 71.7 3.5 64.48 4.25C57.83 4.95 51.67 7.25 45.71 10.15C38.54 13.58 31.47 17.21 24.31 20.67C18.93 23.27 13.41 25.52 7.43 26.33C4.96088 26.8078 2.41327 26.6878 0 25.98C0.48061 25.9135 0.964864 25.8768 1.45 25.87C6.62298 26.1765 11.7807 25.0557 16.36 22.63C21.62 19.83 26.8 16.87 31.91 13.81C39.82 9.06 47.74 4.38 56.65 1.7C60.1861 0.582572 63.8716 0.00935279 67.58 0C72.4947 0.0939161 77.2523 1.74779 81.1655 4.72269C85.0787 7.69759 87.9449 11.8395 89.35 16.55C90.85 21.94 89.69 26.93 86.58 31.5C84.1192 35.0945 80.7984 38.0165 76.92 40C76 40.49 75 40.96 73.61 41.7Z';
function arrowMark() {
  const span = el('span', { className: 'arrow-mark' });
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 90 48"><path fill="currentColor" d="${ARROW_PATH}"/></svg>`;
  return span;
}

function bookmarkCard(bookmark, path, { open: openable = true, meta } = {}) {
  const icon = el('span', { className: 'bm-icon' });
  icon.innerHTML = BOOKMARK_ICON;
  const open = el('button', { className: 'bm-open', type: 'button', textContent: 'Open' });
  open.setAttribute('aria-label', `Open ${bookmark.title || 'this bookmark'} in a background tab`);
  open.addEventListener('click', () => chrome.tabs.create({ url: bookmark.url, active: false }));
  return el(
    'div',
    { className: openable ? 'bm-card' : 'bm-card no-open' },
    icon,
    el(
      'span',
      { className: 'bm-body' },
      el('span', { className: 'bm-title', textContent: bookmark.title || bookmark.url, title: bookmark.url }),
      el('span', {
        className: 'bm-meta',
        textContent: meta || `In ${path.slice(1).slice(-2).join(' / ') || path.at(-1) || 'Bookmarks'} · ${hostOf(bookmark.url) || 'link'}`,
        title: path.length ? `In ${path.join(' / ')}` : bookmark.url
      })
    ),
    ...(openable ? [open] : [])
  );
}

// A small "to tidy" chip in the footer, so it is always there but never in the way.
function paintTidySlot(show) {
  const slot = document.getElementById('tidy-slot');
  if (!show || !tidyCount) return slot.replaceChildren();
  const b = el(
    'button',
    { className: 'tidy-chip', type: 'button', title: 'Review bookmarks that look out of place or unsorted' },
    el('span', { className: 'spark', ariaHidden: 'true' }),
    `${tidyCount.toLocaleString()} to tidy`
  );
  b.setAttribute('aria-label', `${tidyCount} bookmarks could be tidier. Review them.`);
  b.addEventListener('click', startTidy);
  slot.replaceChildren(b);
}

async function startTidy() {
  const queue = await tidyItems();
  tidyStep(queue, 0, { moved: 0, kept: 0, skipped: 0 });
}

async function tidyStep(queue, i, tally) {
  // Skip anything that has moved or gone since the scan.
  let node;
  for (; i < queue.length; i++) {
    try {
      [node] = await chrome.bookmarks.get(queue[i].id);
      if (node.parentId === queue[i].folderId) break;
    } catch {
      /* removed since */
    }
  }
  if (i >= queue.length) return renderTidyDone(tally, 0);

  const item = queue[i];
  const [tree, { learned }] = await Promise.all([chrome.bookmarks.getTree(), chrome.storage.local.get('learned')]);
  const index = buildIndex(tree, { excludeId: node.id });
  // No recency here: when this was saved has nothing to do with where it belongs.
  const scored = scoreAll(node, index, learned || {}, { weights: { ...WEIGHTS, recency: 0 } });
  const { options, blended } = combine(scored, Object.fromEntries(item.top), index, node.parentId);
  state = {
    mode: 'tidy',
    bookmark: node,
    index,
    options,
    confident: true,
    misfit: item.kind === 'misplaced',
    currentFolderId: node.parentId,
    currentPath: pathOf(index, node.parentId),
    boost: new Map((blended || scored).map((s) => [s.id, s.score])),
    host: hostOf(node.url),
    tidy: { queue, i, tally, item }
  };
  renderPicker();
}

async function tidyKeep() {
  const { item, queue, i, tally } = state.tidy;
  const { tidyKept = {} } = await chrome.storage.local.get('tidyKept');
  tidyKept[item.id] = item.folderId;
  await chrome.storage.local.set({ tidyKept });
  tidyStep(queue, i + 1, { ...tally, kept: tally.kept + 1 });
}

async function tidyMove(targetId, path, createdFolderId) {
  const { item, queue, i, tally } = state.tidy;
  const { bookmark, host } = state;
  await chrome.bookmarks.move(bookmark.id, { parentId: targetId });
  await bumpLearned(host, targetId, 1);
  let undone = false;
  const next = () => !undone && tidyStep(queue, i + 1, { ...tally, moved: tally.moved + 1 });
  const timer = setTimeout(next, 900);

  const undo = el('button', { className: 'pill quiet', type: 'button', textContent: 'Undo' });
  undo.addEventListener(
    'click',
    async () => {
      undone = true;
      clearTimeout(timer);
      await chrome.bookmarks.move(bookmark.id, { parentId: item.folderId });
      await bumpLearned(host, targetId, -1);
      if (createdFolderId) await chrome.bookmarks.remove(createdFolderId).catch(() => {});
      tidyStep(queue, i, tally);
    },
    { once: true }
  );
  const card = filedCard(path);
  card.classList.add('landed');
  app.replaceChildren(
    el('p', { className: 'kicker', textContent: `Tidy up · ${i + 1} of ${queue.length}` }),
    el('h1', { textContent: 'Moved.' }),
    el('p', { className: 'page', textContent: bookmark.title || bookmark.url }),
    card,
    el('div', { className: 'actions' }, undo, el('span', { className: 'hint', textContent: 'Next one…' }))
  );
}

function renderTidyDone(tally, left) {
  tidyItems().then((items) => {
    tidyCount = items.length;
    paintTidySlot(true);
  });
  const parts = [];
  if (tally.moved) parts.push(`moved ${tally.moved}`);
  if (tally.kept) parts.push(`kept ${tally.kept} where ${tally.kept === 1 ? 'it was' : 'they were'}`);
  if (tally.skipped) parts.push(`skipped ${tally.skipped}`);
  const close = el('button', { className: 'pill', type: 'button', textContent: 'Close' });
  close.addEventListener('click', () => window.close());
  app.replaceChildren(
    el('p', { className: 'kicker', textContent: 'Tidy up' }),
    el('h1', { textContent: left ? 'Good for now.' : 'All tidy.' }),
    el('p', {
      className: 'lede',
      textContent:
        (parts.length ? `You ${parts.join(', ')}. ` : '') +
        (left ? `${left} left for another time.` : 'Bookmarks you kept will not be suggested again.')
    }),
    el('div', { className: 'actions end' }, close)
  );
  close.focus();
  enter();
}

async function shortcutLabel() {
  try {
    const all = await chrome.commands.getAll();
    return all.find((c) => c.name === '_execute_action')?.shortcut || '';
  } catch {
    return '';
  }
}

async function renderWelcome() {
  const keys = await shortcutLabel();
  const step = (n, strong, rest) =>
    el(
      'li',
      { className: 'step' },
      el('span', { className: 'num', textContent: String(n), ariaHidden: 'true' }),
      el('span', {}, el('strong', { textContent: strong }), ` ${rest}`)
    );
  const heading = el('h1');
  heading.append('No head scratching. ', el('em', { textContent: 'Just filed.' }));

  const start = el('button', { className: 'pill', type: 'button', textContent: 'Start filing' });
  start.addEventListener('click', async () => {
    await chrome.storage.local.set({ welcomed: true });
    load();
  });

  app.replaceChildren(
    el('p', { className: 'kicker', textContent: 'Welcome' }),
    heading,
    el('p', { className: 'lede', textContent: 'The quick way to put a bookmark in the right folder.' }),
    el(
      'ol',
      { className: 'steps' },
      step(1, 'Open Just Filed', keys ? `on any page. Click this icon or press ${keys}.` : 'on any page by clicking this icon.'),
      step(2, 'Type', 'to find a folder, or name a new one.'),
      step(3, 'Press Enter.', 'It is filed, and there is an undo.')
    ),
    el(
      'p',
      { className: 'tip' },
      el('strong', { textContent: 'Keep it handy: ' }),
      'click the puzzle icon in the toolbar, then the pin next to Just Filed.'
    ),
    el('p', { className: 'lede small', textContent: 'The AI runs on your computer. Your bookmarks never leave your browser.' }),
    el('div', { className: 'actions end' }, start)
  );
  start.focus();
  enter();
}

function credits() {
  const link = (href, text) => el('a', { href, textContent: text, target: '_blank', rel: 'noopener' });
  return el(
    'p',
    { className: 'credits' },
    'Hand drawn arrow by Max Miner from ',
    link('https://thenounproject.com/browse/icons/term/hand-drawn-arrow/', 'Noun Project'),
    ' (',
    link('https://creativecommons.org/licenses/by/3.0/', 'CC BY 3.0'),
    '). AI model all-MiniLM-L6-v2 (Apache 2.0). Fonts under the SIL Open Font License.'
  );
}

function tidyPanel() {
  const label = el('span', {
    className: 'reason',
    textContent: tidyCount
      ? `${tidyCount.toLocaleString()} ${tidyCount === 1 ? 'bookmark looks' : 'bookmarks look'} out of place or unsorted.`
      : 'Checks your library for bookmarks that look out of place.'
  });
  const go = el('button', { className: 'pill quiet', type: 'button', textContent: tidyCount ? 'Review' : 'Check now' });
  go.addEventListener('click', async () => {
    if (tidyCount) return startTidy();
    go.disabled = true;
    label.textContent = 'Checking your library…';
    const reply = await chrome.runtime.sendMessage({ type: 'jf-tidy-scan' }).catch(() => null);
    tidyCount = (await tidyItems()).length;
    label.textContent = reply?.items
      ? tidyCount
        ? `${tidyCount.toLocaleString()} to review.`
        : 'Nothing looks out of place.'
      : 'The AI is not ready yet. Try again in a minute.';
    go.disabled = false;
    go.textContent = tidyCount ? 'Review' : 'Check now';
  });
  return el('div', { className: 'panel split' }, el('span', {}, el('strong', { textContent: 'Tidy up' }), label), go);
}

async function renderSettings() {
  const [{ settings, learned }, { openStatus, aiStatus, lastSave }, keys] = await Promise.all([
    chrome.storage.local.get(['settings', 'learned']),
    chrome.storage.session.get(['openStatus', 'aiStatus', 'lastSave']),
    shortcutLabel()
  ]);

  const toggle = el('input', { type: 'checkbox', id: 'auto-open', checked: settings?.autoOpen ?? true });
  toggle.addEventListener('change', async () => {
    const { settings: now } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...(now || {}), autoOpen: toggle.checked } });
  });
  const row = el(
    'label',
    { className: 'setting' },
    toggle,
    el(
      'span',
      {},
      el('strong', { textContent: 'Open by itself when confident' }),
      el('span', {
        className: 'reason',
        textContent: 'After you bookmark with the star. When off, the icon shows a number instead.'
      })
    )
  );

  // How readily it interrupts.
  const level = settings?.sensitivity || 'balanced';
  const levels = el('div', { className: 'levels' });
  levels.setAttribute('role', 'radiogroup');
  levels.setAttribute('aria-label', 'How often Just Filed speaks up');
  const levelNote = el('span', { className: 'reason' });
  const blurbs = {
    rarely: 'Only when a bookmark is clearly in the wrong place. About 1 save in 10.',
    balanced: 'When a bookmark looks out of place. About 1 save in 5.',
    often: 'Whenever another folder looks like a better fit. About 1 save in 3.'
  };
  const paintLevels = (now) => {
    for (const b of levels.children) {
      const on = b.dataset.level === now;
      b.setAttribute('aria-checked', String(on));
      b.className = on ? 'pill' : 'pill quiet';
    }
    levelNote.textContent = blurbs[now];
  };
  for (const [key, label] of [['rarely', 'Rarely'], ['balanced', 'Balanced'], ['often', 'Often']]) {
    const b = el('button', { type: 'button', textContent: label });
    b.dataset.level = key;
    b.setAttribute('role', 'radio');
    b.addEventListener('click', async () => {
      const { settings: now } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...(now || {}), sensitivity: key } });
      paintLevels(key);
    });
    levels.append(b);
  }
  paintLevels(level);
  const levelPanel = el('div', { className: 'panel' }, el('strong', { textContent: 'How often it speaks up' }), levels, levelNote);

  const notes = [];
  if (lastSave) {
    const f = lastSave.fit;
    const why = !lastSave.usedModel
      ? 'the AI was still reading your library, so only the rules were used.'
      : f && f.bestPath?.length
        ? `fit with ${lastSave.folder} ${f.here.toFixed(2)}, best elsewhere ${f.best.toFixed(2)} (${f.bestPath.at(-1)}). Lead ${f.lead.toFixed(2)}, needs ${f.needs.toFixed(2)}.`
        : 'nothing else to compare with.';
    notes.push(
      el('p', {
        className: 'lede small',
        textContent: `Last save, “${(lastSave.title || '').slice(0, 40)}”: ${lastSave.confident ? 'spoke up' : 'stayed quiet'}; ${why}`
      })
    );
  }
  if (openStatus && !openStatus.ok)
    notes.push(el('p', { className: 'lede small', textContent: `Last time it could not open by itself. Chrome said: “${openStatus.error}”` }));
  notes.push(
    el('p', {
      className: 'lede small',
      textContent: keys ? `Keyboard shortcut: ${keys}. Change it at chrome://extensions/shortcuts.` : 'No keyboard shortcut set. Add one at chrome://extensions/shortcuts.'
    })
  );

  const ai =
    aiStatus?.state === 'ready'
      ? `Ready. It has read ${aiStatus.done.toLocaleString()} bookmarks and folders.`
      : aiStatus?.state === 'learning'
        ? `Reading your library: ${aiStatus.done.toLocaleString()} of ${aiStatus.total.toLocaleString()}. Suggestions use the rules until it finishes.`
        : aiStatus?.state === 'error'
          ? `Not running (${aiStatus.error}). Suggestions use the rules alone.`
          : 'Starts the first time you file something.';
  const aiPanel = el(
    'div',
    { className: 'panel' },
    el('strong', { textContent: 'On-device AI' }),
    el('span', { className: 'reason', textContent: ai })
  );

  const sites = Object.keys(learned?.hosts || {}).length;
  const summary = el('span', {
    className: 'reason',
    textContent: sites
      ? `Where you file bookmarks from ${sites} ${sites === 1 ? 'site' : 'sites'}. Kept on this device.`
      : 'Nothing yet. It learns from where you file things.'
  });
  const forget = el('button', { className: 'pill quiet', type: 'button', textContent: 'Forget', disabled: !sites });
  forget.addEventListener('click', async () => {
    await chrome.storage.local.remove('learned');
    summary.textContent = 'Forgotten.';
    forget.disabled = true;
  });

  const back = el('button', { className: 'pill', type: 'button', textContent: 'Back' });
  back.addEventListener('click', load);
  const intro = el('button', { className: 'pill quiet', type: 'button', textContent: 'Show the intro' });
  intro.addEventListener('click', renderWelcome);

  app.replaceChildren(
    el('p', { className: 'kicker', textContent: 'Settings' }),
    el('h1', { textContent: 'How Just Filed behaves.' }),
    el('div', { className: 'panel' }, row),
    levelPanel,
    ...notes,
    aiPanel,
    tidyPanel(),
    el('div', { className: 'panel split' }, el('span', {}, el('strong', { textContent: 'What it has learned' }), summary), forget),
    el('p', { className: 'lede small', textContent: 'The AI runs on your computer. Your bookmarks never leave your browser.' }),
    credits(),
    el('div', { className: 'actions' }, intro, back)
  );
  back.focus();
  enter();
}

document.getElementById('open-options').addEventListener('click', renderSettings);
load();
