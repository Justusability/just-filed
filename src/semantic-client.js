// Service-worker side of the on-device model: keeps the offscreen document alive
// and asks it for per-folder scores. Every failure resolves to null so the rules carry on.

import { folderTexts, bookmarkText, looseFolderIds } from './semantic.js';

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: 'ai/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Runs the on-device model that matches a page to your bookmark folders.'
    });
  } catch (e) {
    if (!/single offscreen|already/i.test(String(e))) throw e;
  }
  await new Promise((r) => setTimeout(r, 150)); // let its message listener attach
}

const withTimeout = (promise, ms) =>
  ms ? Promise.race([promise, new Promise((r) => setTimeout(() => r(null), ms))]) : promise;

export async function semanticScores(tree, bookmark, { timeoutMs = 0 } = {}) {
  try {
    await ensureOffscreen();
    const reply = await withTimeout(
      chrome.runtime.sendMessage({
        target: 'jf-embedder',
        type: 'score',
        query: bookmarkText(bookmark.title, bookmark.url),
        folders: folderTexts(tree, { excludeId: bookmark.id })
      }),
      timeoutMs
    );
    return reply?.ok ? reply.scores : null;
  } catch {
    return null;
  }
}

// Finds bookmarks that look out of place, and unsorted ones with a likely home.
export async function scanLibrary() {
  try {
    await ensureOffscreen();
    const tree = await chrome.bookmarks.getTree();
    const reply = await chrome.runtime.sendMessage({
      target: 'jf-embedder',
      type: 'scan',
      folders: folderTexts(tree),
      loose: [...looseFolderIds(tree)]
    });
    return reply?.ok ? reply.items : null;
  } catch {
    return null;
  }
}

// Reads the whole library once so later saves are answered in milliseconds.
export async function warmUp() {
  try {
    await ensureOffscreen();
    const tree = await chrome.bookmarks.getTree();
    return await chrome.runtime.sendMessage({ target: 'jf-embedder', type: 'warm', folders: folderTexts(tree) });
  } catch {
    return null;
  }
}
