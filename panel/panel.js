// Just Filed: Tidy up, in Chrome's side panel.
// Reviews bookmarks that look out of place, one at a time. The panel stays open while the user
// browses, so "Open" can show the page beside it, and closing the panel loses nothing:
// the queue is worked out afresh from what is stored each time, so it picks up where it left off.

import { buildIndex, scoreAll, hostOf, pathOf, WEIGHTS } from '../src/ranker.js';
import { combine } from '../src/semantic.js';
import { bumpLearned } from '../src/learn.js';
import { el, filedCard, bookmarkCard, arrowMark, shortPlace, tidyItems } from '../src/ui.js';
import { createPicker } from '../src/picker.js';

const app = document.getElementById('app');
const SUGGESTIONS = 5; // the panel has the height for more than the popup's three
const UP_NEXT = 4;
const NEXT_AFTER_MS = 900;

// --- What this sitting has done so far. Kept for the browser session, so reopening the panel carries on. ---

const FRESH_RUN = { moved: 0, kept: 0, skipped: 0, skippedIds: [] };
async function getRun() {
  const { tidyRun } = await chrome.storage.session.get('tidyRun');
  return { ...FRESH_RUN, ...(tidyRun || {}) };
}
const setRun = (run) => chrome.storage.session.set({ tidyRun: run });

let screen = 'loading'; // 'picker' | 'moved' | 'rest' | 'loading'
let current = null; // { item, node }: the bookmark on show
let lastMove = null; // the most recent move, so it can be undone after the panel has moved on
let revived = null; // a bookmark put back by Undo, until the next scan lists it again
let restWasEmpty = false;
let busy = false;
let renders = 0;
let nextTimer;

// Everything still waiting: the last scan's list, minus bookmarks that have moved or gone since,
// split into the ones to show and the ones skipped for now.
async function readQueue(run) {
  const [tree, items] = await Promise.all([chrome.bookmarks.getTree(), tidyItems()]);
  const nodes = new Map();
  const walk = (n) => {
    if (n.url) nodes.set(n.id, n);
    for (const c of n.children || []) walk(c);
  };
  tree.forEach(walk);
  const all = revived && !items.some((i) => i.id === revived.id) ? [revived, ...items] : items;
  const waiting = all.filter((i) => nodes.get(i.id)?.parentId === i.folderId);
  const skipped = new Set(run.skippedIds);
  return {
    tree,
    nodes,
    queue: waiting.filter((i) => !skipped.has(i.id)),
    skippedLeft: waiting.filter((i) => skipped.has(i.id)).length
  };
}

// Each new screen eases in and starts at the top.
function enter() {
  window.scrollTo(0, 0);
  app.classList.remove('enter');
  void app.offsetWidth;
  app.classList.add('enter');
  app.querySelector('.suggestions')?.classList.add('enter');
}

const kickerText = (run, waiting) => {
  const done = run.moved + run.kept + run.skipped;
  return `Tidy up · ${done + 1} of ${done + waiting}`;
};

// --- Open: show the bookmark's page beside the panel, reusing one tab so a long review does not pile tabs up ---

let reviewTabId = null;
const inOwnTab = chrome.tabs.getCurrent().then(Boolean, () => false); // true when shown in a tab, on browsers with no side panel
async function openBeside(bookmark) {
  const active = !(await inOwnTab); // in a tab, do not leave the review to look
  try {
    if (reviewTabId !== null) {
      try {
        await chrome.tabs.update(reviewTabId, { url: bookmark.url, active });
        return;
      } catch {
        reviewTabId = null; // that tab has been closed
      }
    }
    reviewTabId = (await chrome.tabs.create({ url: bookmark.url, active })).id;
  } catch {
    /* an address Chrome will not open from here, such as a bookmarklet */
  }
}

// --- One bookmark at a time ---

async function step(pinId = current?.item.id) {
  const mine = ++renders;
  clearTimeout(nextTimer);
  const run = await getRun();
  const { tree, nodes, queue, skippedLeft } = await readQueue(run);
  if (mine !== renders) return;
  if (!queue.length) return renderRest(run, queue, skippedLeft);

  const item = queue.find((i) => i.id === pinId) || queue[0];
  const node = nodes.get(item.id);
  const { learned } = await chrome.storage.local.get('learned');
  if (mine !== renders) return;
  const index = buildIndex(tree, { excludeId: node.id });
  // No recency here: when this was saved has nothing to do with where it belongs.
  const scored = scoreAll(node, index, learned || {}, { weights: { ...WEIGHTS, recency: 0 } });
  const { options, blended } = combine(scored, Object.fromEntries(item.top), index, node.parentId, { limit: SUGGESTIONS });
  const state = {
    index,
    options,
    currentFolderId: node.parentId,
    boost: new Map((blended || scored).map((s) => [s.id, s.score]))
  };
  current = { item, node };
  screen = 'picker';

  const heading = el('h1');
  if (item.kind === 'unsorted') heading.append('Where does this bookmark ', el('em', { textContent: 'belong?' }), arrowMark());
  else heading.append('This bookmark looks ', el('em', { textContent: 'out of place.' }));

  const { input, note, list, refresh } = createPicker({ state, onChoose: move, quietNote: () => true, searchLimit: 10 });

  const keep = el('button', { className: 'pill quiet', type: 'button', textContent: 'Keep it here' });
  keep.addEventListener('click', keepHere);
  const skip = el('button', { className: 'pill quiet', type: 'button', textContent: 'Skip' });
  skip.addEventListener('click', skipForNow);
  const stop = el('button', { className: 'pill quiet', type: 'button', textContent: 'Stop' });
  stop.addEventListener('click', async () => {
    const now = await getRun();
    const q = await readQueue(now);
    renderRest(now, q.queue, q.skippedLeft);
  });

  const upNext = el('section', { className: 'up-next' });
  upNext.setAttribute('aria-label', 'Up next');
  const kicker = el('p', { className: 'kicker' });

  app.replaceChildren(
    kicker,
    heading,
    bookmarkCard(node, pathOf(index, node.parentId), { onOpen: openBeside, openHint: 'beside this panel' }),
    input,
    note,
    list,
    el('div', { className: 'actions compact' }, keep, skip, stop),
    ...(lastMove ? [lastMoveLine()] : []),
    upNext
  );
  current.paintQueue = (r, q, n, ix) => {
    const rest = q.filter((i) => i.id !== item.id);
    kicker.textContent = kickerText(r, rest.length + 1);
    paintUpNext(upNext, rest, n, ix);
  };
  current.paintQueue(run, queue, nodes, index);
  refresh();
  enter();
  input.focus({ preventScroll: true });
}

function paintUpNext(section, rest, nodes, index) {
  section.hidden = !rest.length;
  if (!rest.length) return section.replaceChildren();
  const rows = rest.slice(0, UP_NEXT).map((i) => {
    const n = nodes.get(i.id);
    const row = el(
      'button',
      { className: 'next-item', type: 'button' },
      el('span', { className: 'next-title', textContent: n.title || n.url }),
      el('span', { className: 'next-meta', textContent: `In ${shortPlace(pathOf(index, i.folderId))} · ${hostOf(n.url) || 'link'}` })
    );
    row.title = 'Review this one now';
    row.addEventListener('click', () => step(i.id));
    return el('li', {}, row);
  });
  const more = rest.length - rows.length;
  section.replaceChildren(
    el('p', { className: 'kicker', textContent: 'Up next' }),
    el('ul', {}, ...rows),
    ...(more > 0 ? [el('p', { className: 'more', textContent: `and ${more.toLocaleString()} more` })] : [])
  );
}

function lastMoveLine() {
  const undo = el('button', { className: 'link', type: 'button', textContent: 'Undo' });
  undo.setAttribute('aria-label', `Undo moving ${lastMove.title} to ${lastMove.leaf}`);
  undo.addEventListener('click', undoLast, { once: true });
  // Shorten a long title here, so the line still has room to say where the bookmark went.
  const title = lastMove.title.length > 30 ? `${lastMove.title.slice(0, 28).trimEnd()}…` : lastMove.title;
  const said = el('span', { textContent: `Moved “${title}” to ${lastMove.leaf}.`, title: `Moved “${lastMove.title}” to ${lastMove.leaf}.` });
  return el('p', { className: 'last-move' }, said, undo);
}

async function move(choice) {
  if (busy || !current) return;
  busy = true;
  try {
    const { item, node } = current;
    let createdFolderId = null;
    let targetId = choice.id;
    if (choice.kind === 'create') {
      const folder = await chrome.bookmarks.create({ parentId: choice.parentId, title: choice.name });
      createdFolderId = targetId = folder.id;
    }
    const host = hostOf(node.url);
    await chrome.bookmarks.move(node.id, { parentId: targetId });
    await bumpLearned(host, targetId, 1);
    const run = await getRun();
    const waiting = (await readQueue(run)).queue.length + 1;
    const label = kickerText(run, waiting);
    await setRun({ ...run, moved: run.moved + 1 });
    lastMove = { item, bookmarkId: node.id, title: node.title || node.url, host, targetId, createdFolderId, leaf: choice.path.at(-1) };
    revived = null;
    current = null;
    screen = 'moved';
    renders++;

    // The tick draws itself, then the next bookmark arrives. Undo stays on the next screen too.
    const undo = el('button', { className: 'pill quiet', type: 'button', textContent: 'Undo' });
    undo.addEventListener('click', undoLast, { once: true });
    const card = filedCard(choice.path);
    card.classList.add('landed');
    const status = el('p', { className: 'kicker', textContent: label });
    status.setAttribute('role', 'status');
    app.replaceChildren(
      status,
      el('h1', { textContent: 'Moved.' }),
      el('p', { className: 'page', textContent: node.title || node.url }),
      card,
      el('div', { className: 'actions' }, undo, el('span', { className: 'hint', textContent: 'Next one…' }))
    );
    window.scrollTo(0, 0);
    nextTimer = setTimeout(() => step(null), NEXT_AFTER_MS);
  } catch {
    step(null); // the bookmark or the folder went away underneath us: move on
  } finally {
    busy = false;
  }
}

async function undoLast() {
  if (busy || !lastMove) return;
  busy = true;
  clearTimeout(nextTimer);
  const m = lastMove;
  lastMove = null;
  try {
    await chrome.bookmarks.move(m.bookmarkId, { parentId: m.item.folderId });
    await bumpLearned(m.host, m.targetId, -1);
    if (m.createdFolderId) await chrome.bookmarks.remove(m.createdFolderId).catch(() => {});
    const run = await getRun();
    await setRun({ ...run, moved: Math.max(0, run.moved - 1) });
    revived = m.item;
  } catch {
    /* the bookmark has gone since: nothing to put back */
  } finally {
    busy = false;
  }
  step(m.bookmarkId);
}

async function keepHere() {
  if (busy || !current) return;
  busy = true;
  try {
    const { item } = current;
    const { tidyKept = {} } = await chrome.storage.local.get('tidyKept');
    tidyKept[item.id] = item.folderId;
    await chrome.storage.local.set({ tidyKept });
    const run = await getRun();
    await setRun({ ...run, kept: run.kept + 1 });
    if (revived?.id === item.id) revived = null;
    current = null;
  } finally {
    busy = false;
  }
  step(null);
}

async function skipForNow() {
  if (busy || !current) return;
  busy = true;
  try {
    const run = await getRun();
    await setRun({ ...run, skipped: run.skipped + 1, skippedIds: [...run.skippedIds, current.item.id] });
    current = null;
  } finally {
    busy = false;
  }
  step(null);
}

// --- Between bookmarks: stopped for now, finished, or nothing to do ---

async function check() {
  screen = 'loading';
  current = null;
  renders++;
  app.replaceChildren(
    el('p', { className: 'kicker', textContent: 'Tidy up' }),
    el('h1', { textContent: 'Checking your library…' }),
    el('p', { className: 'lede', textContent: 'Looking for bookmarks that are out of place, and loose ones with a likely home.' })
  );
  enter();
  const reply = await chrome.runtime.sendMessage({ type: 'jf-tidy-scan' }).catch(() => null);
  if (reply?.items) return step(null);
  const again = el('button', { className: 'pill', type: 'button', textContent: 'Check again' });
  again.addEventListener('click', check);
  app.replaceChildren(
    el('p', { className: 'kicker', textContent: 'Tidy up' }),
    el('h1', { textContent: 'Not ready yet.' }),
    el('p', { className: 'lede', textContent: 'The AI is still reading your library. Try again in a minute.' }),
    el('div', { className: 'actions start' }, again)
  );
  enter();
}

async function renderRest(run, queue, skippedLeft) {
  const { tidy } = await chrome.storage.local.get('tidy');
  if (!tidy) return check(); // never scanned: do it now, without being asked
  const mine = ++renders;
  screen = 'rest';
  current = null;
  clearTimeout(nextTimer);
  restWasEmpty = !queue.length;

  const parts = [];
  if (run.moved) parts.push(`moved ${run.moved}`);
  if (run.kept) parts.push(`kept ${run.kept} where ${run.kept === 1 ? 'it was' : 'they were'}`);
  if (run.skipped) parts.push(`skipped ${run.skipped}`);
  const left = queue.length + skippedLeft;
  // The tally has been told: the next stretch starts counting from one.
  await setRun({ ...FRESH_RUN, skippedIds: run.skippedIds });
  if (mine !== renders) return;

  const buttons = [];
  if (queue.length) {
    const on = el('button', { className: 'pill', type: 'button', textContent: 'Carry on' });
    on.addEventListener('click', () => step(null));
    buttons.push(on);
  } else {
    if (skippedLeft) {
      const back = el('button', {
        className: 'pill',
        type: 'button',
        textContent: skippedLeft === 1 ? 'Review the one you skipped' : `Review the ${skippedLeft} you skipped`
      });
      back.addEventListener('click', async () => {
        await setRun({ ...FRESH_RUN });
        step(null);
      });
      buttons.push(back);
    }
    const again = el('button', { className: skippedLeft ? 'pill quiet' : 'pill', type: 'button', textContent: 'Check again' });
    again.addEventListener('click', check);
    buttons.push(again);
  }
  const close = el('button', { className: 'pill quiet', type: 'button', textContent: 'Close' });
  close.addEventListener('click', () => window.close());
  buttons.push(close);

  app.replaceChildren(
    el('p', { className: 'kicker', textContent: 'Tidy up' }),
    el('h1', { textContent: left ? 'Good for now.' : 'All tidy.' }),
    el('p', {
      className: 'lede',
      textContent:
        (parts.length ? `You ${parts.join(', ')}. ` : '') +
        (left
          ? `${left.toLocaleString()} left for another time.`
          : parts.length
            ? 'Bookmarks you kept will not be suggested again.'
            : 'Nothing looks out of place.')
    }),
    ...(lastMove ? [lastMoveLine()] : []),
    el('div', { className: 'actions compact' }, ...buttons)
  );
  enter();
  buttons[0].focus({ preventScroll: true });
}

// --- Keep up with changes made elsewhere while the panel is open ---

// A new scan lands a few seconds after every change. Refresh the queue around the bookmark on show,
// but never swap that bookmark out from under the user.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== 'local' || !(changes.tidy || changes.tidyKept) || busy) return;
  const mine = renders;
  const run = await getRun();
  const { tree, nodes, queue, skippedLeft } = await readQueue(run);
  if (mine !== renders || busy) return;
  if (screen === 'picker' && current) current.paintQueue(run, queue, nodes, buildIndex(tree));
  else if (screen === 'rest' && restWasEmpty && queue.length) renderRest(run, queue, skippedLeft);
});

// If the bookmark on show is moved or deleted somewhere else, go to the next one.
const changedElsewhere = (id) => {
  if (screen === 'picker' && !busy && current?.node.id === id) step(null);
};
chrome.bookmarks.onMoved.addListener(changedElsewhere);
chrome.bookmarks.onRemoved.addListener(changedElsewhere);

step(null);
