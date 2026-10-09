import { buildIndex, scoreAll, hostOf, pathOf } from '../src/ranker.js';
import { combine, LEVELS } from '../src/semantic.js';
import { bumpLearned } from '../src/learn.js';
import { el, pause, filedCard, bookmarkCard, shortPlace, tidyItems, openTidyPanel } from '../src/ui.js';
import { createPicker } from '../src/picker.js';

const app = document.getElementById('app');
const POPUP_MAX = 596; // Chrome's popup height limit is 600px

// Tidy up lives in the side panel. Chrome only opens a side panel straight from a click,
// so find out which window this is now, not when the click comes.
let windowId;
chrome.windows.getCurrent().then((w) => (windowId = w.id), () => {});
const openTidy = () => openTidyPanel(windowId).finally(() => window.close());


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
// Every screen calls enter(), so it also resets the header button: a cross on settings, the ⋯ everywhere else.
let showingSettings = false;
function enter() {
  headerButton(showingSettings);
  showingSettings = false;
  window.scrollTo(0, 0); // a new screen starts at the top, even if the last one was scrolled
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

function renderPicker() {
  const { mode, bookmark, currentPath } = state;
  const heading = el('h1');
  const title = () => {
    heading.replaceChildren();
    if (mode === 'create') heading.append('Where should ', el('em', { textContent: 'this go?' }));
    else if (state.misfit) heading.append('This looks like it belongs ', el('em', { textContent: 'somewhere else.' }));
    else if (state.confident) heading.append('Move it to a ', el('em', { textContent: 'better folder?' }));
    else heading.append('Filed. ', el('em', { textContent: 'Wrong place?' }));
  };
  title();

  const { input, note, list, hint, refresh, restagger } = createPicker({
    state,
    onChoose: choose,
    quietNote: () => mode === 'create' || state.confident,
    // Chrome cuts popups off at 600px tall. Give the list whatever room the rest of the pane leaves,
    // so a long page title or a two-line heading makes the list scroll instead of the whole pane.
    fit: (ul) => {
      const rest = document.body.offsetHeight - ul.offsetHeight;
      ul.style.maxHeight = `${Math.max(140, Math.min(318, POPUP_MAX - rest))}px`;
    }
  });

  const dismiss = el('button', {
    className: 'pill quiet',
    type: 'button',
    textContent: mode === 'create' ? 'Not now' : 'Keep it here'
  });
  dismiss.addEventListener('click', () => window.close());

  const subject = bookmarkCard(bookmark, currentPath, {
    meta:
      mode === 'create'
        ? `Not bookmarked yet · ${hostOf(bookmark.url) || 'this page'}`
        : `In ${shortPlace(currentPath)} · ${hostOf(bookmark.url) || 'link'}`
  });

  app.replaceChildren(
    el('p', { className: 'kicker', textContent: mode === 'create' ? 'New bookmark' : 'Saved' }),
    heading,
    subject,
    input,
    note,
    list,
    el('div', { className: 'actions' }, dismiss, hint)
  );
  paintTidySlot(true);
  refresh();
  enter();
  input.focus();
  // Lets late results from the on-device model update the list, unless the user is already typing.
  state.repaint = () => {
    if (!app.contains(input)) return;
    title();
    if (!input.value.trim()) {
      refresh();
      restagger(); // updated suggestions arrive gently too
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
    if (state.mode === 'create') await saveNew(targetId, item.path, createdFolderId);
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

// --- Tidy up: reviewing bookmarks that look out of place happens in the side panel ---

// A small "to tidy" chip in the footer, so it is always there but never in the way.
function paintTidySlot(show) {
  const slot = document.getElementById('tidy-slot');
  if (!show || !tidyCount) return slot.replaceChildren();
  const b = el(
    'button',
    { className: 'tidy-chip', type: 'button', title: 'Review bookmarks that look out of place or unsorted, in the side panel' },
    el('span', { className: 'spark', ariaHidden: 'true' }),
    `${tidyCount.toLocaleString()} to tidy`
  );
  b.setAttribute('aria-label', `${tidyCount} bookmarks could be tidier. Review them in the side panel.`);
  b.addEventListener('click', openTidy);
  slot.replaceChildren(b);
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
    if (tidyCount) return openTidy();
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
  showingSettings = true;
  enter();
  app.querySelector('input, button')?.focus({ preventScroll: true });
}

// The ⋯ button opens settings, and closes them again, so leaving settings never needs a scroll to the Back button.
const DOTS = document.getElementById('open-options').innerHTML;
const CROSS = '<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 5l10 10M15 5L5 15" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" fill="none"/></svg>';
function headerButton(close) {
  const b = document.getElementById('open-options');
  b.innerHTML = close ? CROSS : DOTS;
  b.setAttribute('aria-label', close ? 'Close settings' : 'Settings');
  b.title = close ? 'Close settings' : 'Settings';
  b.dataset.close = close ? 'true' : '';
}
document.getElementById('open-options').addEventListener('click', (e) => {
  if (e.currentTarget.dataset.close) load();
  else renderSettings();
});
load();
