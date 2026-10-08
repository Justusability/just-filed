// Just Filed: service worker.
// Watches for a newly saved bookmark, works out where it belongs, and offers
// the move in the toolbar popup. Nothing leaves the browser.

import { buildIndex, scoreAll, pathOf, hostOf } from './src/ranker.js';
import { combine, LEVELS } from './src/semantic.js';
import { semanticScores, warmUp, scanLibrary } from './src/semantic-client.js';

const SETTLE_MS = 400; // wait briefly so a sync or bulk add can be told apart from one save
const FRESH_MS = 15000; // older than this means it arrived by sync, not a click

let importing = false;
let lastCreatedAt = 0;

chrome.bookmarks.onImportBegan.addListener(() => (importing = true));
chrome.bookmarks.onImportEnded.addListener(() => (importing = false));

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return { autoOpen: true, sensitivity: 'balanced', ...(settings || {}) };
}

// Chrome refuses to open our popup while its own "Bookmark added" bubble has focus,
// so keep trying for a few seconds and open as soon as that bubble is gone.
// The badge is already showing, so nothing is lost if this never succeeds.
const OPEN_TRIES = 24;
const OPEN_GAP_MS = 500;
async function openWhenPossible(bookmarkId) {
  let error = '';
  for (let attempt = 1; attempt <= OPEN_TRIES; attempt++) {
    const { pending } = await chrome.storage.session.get('pending');
    const stillWanted =
      pending && pending.bookmarkId === bookmarkId && pending.currentFolderId === pending.originalFolderId;
    if (!stillWanted) return; // a newer save took over, or the user already moved it
    try {
      await chrome.action.openPopup();
      return chrome.storage.session.set({ openStatus: { ok: true, attempt, at: Date.now() } });
    } catch (e) {
      error = String(e?.message || e);
    }
    await new Promise((r) => setTimeout(r, OPEN_GAP_MS));
  }
  await chrome.storage.session.set({ openStatus: { ok: false, error, at: Date.now() } });
}

async function clearBadge() {
  await chrome.action.setBadgeText({ text: '' });
}

chrome.bookmarks.onCreated.addListener(async (id, node) => {
  if (!node.url || importing) return;
  // Bookmarks made from our own popup were filed by the user on purpose: nothing to suggest.
  const { skipCreated } = await chrome.storage.session.get('skipCreated');
  if (skipCreated && skipCreated === node.url) return chrome.storage.session.remove('skipCreated');
  if (node.dateAdded && Date.now() - node.dateAdded > FRESH_MS) return;

  const stamp = Date.now();
  const previous = lastCreatedAt;
  lastCreatedAt = stamp;
  if (stamp - previous < SETTLE_MS * 2) return; // part of a burst
  await new Promise((r) => setTimeout(r, SETTLE_MS));
  if (lastCreatedAt !== stamp) return; // more arrived while waiting

  let current;
  try {
    [current] = await chrome.bookmarks.get(id);
  } catch {
    return; // removed again already
  }

  const [tree, { learned }, settings] = await Promise.all([
    chrome.bookmarks.getTree(),
    chrome.storage.local.get('learned'),
    getSettings()
  ]);
  const index = buildIndex(tree, { excludeId: id });
  // Rules first; the on-device model gets a few seconds to add what it sees, then we go without it.
  const scored = scoreAll(current, index, learned || {});
  const minLead = LEVELS[settings.sensitivity] ?? LEVELS.balanced;

  const act = async (sem) => {
    const { options: suggestions, confident, misfit, fit } = combine(scored, sem, index, current.parentId, { minLead });
    const pending = {
      bookmarkId: id,
      title: current.title,
      url: current.url,
      host: hostOf(current.url),
      originalFolderId: current.parentId,
      currentFolderId: current.parentId,
      currentPath: pathOf(index, current.parentId),
      suggestions,
      confident,
      misfit,
      fit,
      usedModel: Boolean(sem),
      learnedFolderId: null,
      createdAt: stamp
    };
    await chrome.storage.session.set({ pending, lastSave: { title: current.title, folder: pending.currentPath.at(-1), confident, misfit, fit, usedModel: Boolean(sem), at: Date.now() } });

    // Only interrupt when another folder clearly beats where Chrome put it.
    // Otherwise stay quiet: the options are still there if the user opens the popup.
    if (!confident) return clearBadge();
    await chrome.action.setBadgeBackgroundColor({ color: '#68DBAA' });
    await chrome.action.setBadgeText({ text: String(suggestions.length) });
    if (settings.autoOpen) await openWhenPossible(id);
  };

  // The model normally answers in well under a second. If it is still reading the library,
  // go with the rules now and look again when it finishes.
  const asked = semanticScores(tree, current);
  const quick = await Promise.race([asked, new Promise((r) => setTimeout(() => r(undefined), 4000))]);
  await act(quick ?? null);
  if (quick === undefined) {
    const sem = await asked;
    const { pending } = await chrome.storage.session.get('pending');
    const untouched = pending && pending.bookmarkId === id && pending.currentFolderId === pending.originalFolderId;
    if (sem && untouched) await act(sem);
  }
});

// Learn from where the bookmark ends up, whether moved from our popup or by hand.
chrome.bookmarks.onMoved.addListener(async (id, info) => {
  const { pending } = await chrome.storage.session.get('pending');
  if (!pending || pending.bookmarkId !== id || !pending.host) return;

  const { learned = {} } = await chrome.storage.local.get('learned');
  learned.hosts ||= {};
  const forHost = (learned.hosts[pending.host] ||= {});

  // Take back what this same bookmark taught us a moment ago (undo, or a second move).
  if (pending.learnedFolderId && forHost[pending.learnedFolderId]) {
    forHost[pending.learnedFolderId] -= 1;
    if (forHost[pending.learnedFolderId] <= 0) delete forHost[pending.learnedFolderId];
  }
  pending.learnedFolderId = null;

  // Going back to where Chrome first put it teaches nothing.
  if (info.parentId !== pending.originalFolderId) {
    forHost[info.parentId] = (forHost[info.parentId] || 0) + 1;
    pending.learnedFolderId = info.parentId;
  }
  if (!Object.keys(forHost).length) delete learned.hosts[pending.host];

  pending.currentFolderId = info.parentId;
  await chrome.storage.local.set({ learned });
  await chrome.storage.session.set({ pending });
});

chrome.bookmarks.onRemoved.addListener(async (id) => {
  const { pending } = await chrome.storage.session.get('pending');
  if (pending && pending.bookmarkId === id) {
    await chrome.storage.session.remove('pending');
    await clearBadge();
  }
});

// First run: the welcome lives in the pane itself. Flag the toolbar icon so it is easy
// to find; the welcome shows on the first click. (Opening the pane by itself at install
// was unreliable: Chrome could close it again while the model was starting.)
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install') return;
  await chrome.action.setBadgeBackgroundColor({ color: '#68DBAA' });
  await chrome.action.setBadgeText({ text: 'new' });
});

// Read the library into the on-device model in the background, on install and at each start,
// then look for bookmarks to tidy.
chrome.runtime.onInstalled.addListener(() => void warmUp().then(runTidyScan));
chrome.runtime.onStartup.addListener(() => void warmUp().then(runTidyScan));

// Tidy up: keep a list of bookmarks that look out of place, refreshed after changes settle.
async function runTidyScan() {
  const items = await scanLibrary();
  if (!items) return null;
  const { tidyKept = {} } = await chrome.storage.local.get('tidyKept');
  const list = items.filter((i) => tidyKept[i.id] !== i.folderId);
  await chrome.storage.local.set({ tidy: { at: Date.now(), items: list } });
  return list;
}
let tidyTimer;
const scheduleTidy = () => {
  clearTimeout(tidyTimer);
  tidyTimer = setTimeout(runTidyScan, 8000);
};
for (const ev of ['onCreated', 'onMoved', 'onRemoved', 'onChanged']) chrome.bookmarks[ev].addListener(scheduleTidy);

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === 'jf-ai-status') {
    chrome.storage.session.set({ aiStatus: msg.status });
    return;
  }
  if (msg?.type === 'jf-tidy-scan') {
    runTidyScan().then((items) => sendResponse({ items }), () => sendResponse({ items: null }));
    return true;
  }
  if (msg?.type === 'jf-semantic') {
    chrome.bookmarks
      .getTree()
      .then((tree) => semanticScores(tree, msg.bookmark, { timeoutMs: 20000 }))
      .then((scores) => sendResponse({ scores }), () => sendResponse({ scores: null }));
    return true;
  }
});
