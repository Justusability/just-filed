// Just Filed: matching by meaning.
// Pure functions that turn embedding vectors into per-folder scores and combine them
// with the rule-based ranking. The model itself runs in ai/embedder.js.

import { hostOf, decide } from './ranker.js';

// Thresholds measured on a real library of 1,187 bookmarks in 264 folders.
// `minLead` is how much better a page must fit a folder in another branch than the
// folder it landed in before we speak up. On that library:
//   0.4  opens on 1 save in 10, and the bookmark really was misfiled 96% of the time
//   0.3  opens on 1 save in 5,  94%
//   0.2  opens on 1 save in 3,  86%
export const SEM = { weight: 0.5, nameWeight: 2, minFit: 0.3, minLead: 0.3, minShown: 0.25 };
export const LEVELS = { rarely: 0.4, balanced: 0.3, often: 0.2 };

// Folders that hold bookmarks nobody has sorted yet.
const LOOSE_NAME = /uncategori[sz]ed|unsorted|unfiled|loose|misc|imported|inbox|to.?sort/i;


export const bookmarkText = (title, url) => {
  const host = hostOf(url);
  return host ? `${title || ''} (${host})`.trim() : String(title || url || '');
};

// A folder is described by its own name and its parent's, without the root ("Bookmarks bar").
export const folderText = (path) => path.slice(1).slice(-2).join(' / ') || path.at(-1) || '';

// What the embedder needs to know about the library: each folder's name and what is in it.
export function folderTexts(tree, { excludeId } = {}) {
  const out = [];
  const walk = (node, trail) => {
    if (node.url) return;
    const isRoot = node.id === '0' || node.parentId === undefined;
    const path = isRoot ? trail : [...trail, node.title || 'Untitled folder'];
    if (!isRoot && !node.unmodifiable) {
      const kids = (node.children || []).filter((c) => c.url && c.id !== excludeId);
      out.push({
        id: node.id,
        path,
        name: folderText(path),
        items: kids.map((c) => bookmarkText(c.title, c.url)),
        itemIds: kids.map((c) => c.id)
      });
    }
    for (const child of node.children || []) walk(child, path);
  };
  for (const root of tree) walk(root, []);
  return out;
}

const dot = (a, b) => {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * b[i];
  return s;
};

// Each folder becomes one vector: the sum of what is in it plus its name counted twice.
// The score is the cosine between that and the page.
export function prototypeScores(queryVec, folders) {
  const scores = {};
  const proto = new Float32Array(queryVec.length);
  for (const f of folders) {
    proto.fill(0);
    for (const v of f.itemVecs) for (let i = 0; i < proto.length; i++) proto[i] += v[i];
    for (let i = 0; i < proto.length; i++) proto[i] += SEM.nameWeight * f.nameVec[i];
    const norm = Math.sqrt(dot(proto, proto)) || 1;
    scores[f.id] = Math.round((dot(proto, queryVec) / norm) * 1000) / 1000;
  }
  return scores;
}

const branchOf = (path) => path.slice(0, 2).join('\u0000');

// Does the page fit a folder in a different branch far better than where it landed?
// Returns that folder, or null. `fit` receives the numbers behind the decision.
export function misfit(sem, index, currentFolderId, minLead = SEM.minLead, fit = {}) {
  const current = index.folders.find((f) => f.id === currentFolderId);
  if (!sem || !current) return null;
  const here = sem[currentFolderId] ?? 0;
  const branch = branchOf(current.path);
  let best = -1;
  let bestFolder = null;
  for (const f of index.folders) {
    if (f.id === currentFolderId || branchOf(f.path) === branch) continue;
    const s = sem[f.id] ?? -1;
    if (s > best) {
      best = s;
      bestFolder = f;
    }
  }
  Object.assign(fit, {
    here: here,
    best: Math.max(best, 0),
    bestPath: bestFolder?.path || [],
    lead: Math.round((best - here) * 1000) / 1000,
    needs: minLead
  });
  return best >= SEM.minFit && best - here >= minLead ? bestFolder : null;
}

// Adds meaning to the rule-based scores and decides whether to speak up.
// With no semantic scores (model still loading, or unavailable) this is the rules alone.
// Catch-all folders ("Uncategorized", "Imported") are never suggested as a destination;
// they stay reachable through search.
const isCatchAll = (f) => f.path.length > 1 && LOOSE_NAME.test(f.path.at(-1) || '');

export function combine(scored, sem, index, currentFolderId, opts = {}) {
  const catchAll = new Set(index.folders.filter(isCatchAll).map((f) => f.id));
  scored = scored.filter((s) => !catchAll.has(s.id));
  const rules = decide(scored, currentFolderId, opts);
  if (!sem) return { ...rules, misfit: false, fit: null };

  const byId = new Map(scored.map((s) => [s.id, { ...s }]));
  for (const f of index.folders) {
    const s = sem[f.id] ?? 0;
    if (s <= 0 || catchAll.has(f.id)) continue;
    const add = SEM.weight * s;
    const have = byId.get(f.id);
    if (have) {
      if (add > have.score) have.reason = 'Similar in meaning to this folder';
      have.score = Math.round((have.score + add) * 1000) / 1000;
    } else if (s >= SEM.minShown) {
      byId.set(f.id, { id: f.id, path: f.path, score: Math.round(add * 1000) / 1000, reason: 'Similar in meaning to this folder', parts: {} });
    }
  }
  const blended = [...byId.values()].sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  const fit = {};
  const elsewhere = currentFolderId ? misfit(sem, index, currentFolderId, opts.minLead, fit) : null;
  const options = decide(blended, currentFolderId, opts).options;
  // If we say it belongs elsewhere, the folder that made us say so must be on show.
  if (elsewhere && !options.some((o) => o.id === elsewhere.id)) {
    const { parts, ...pick } = byId.get(elsewhere.id) || { id: elsewhere.id, path: elsewhere.path, score: 0, reason: 'Similar in meaning to this folder' };
    options.splice(Math.max(0, (opts.limit || 3) - 1), 1, pick);
  }
  return { options, confident: rules.confident || Boolean(elsewhere), misfit: Boolean(elsewhere), blended, fit: currentFolderId ? fit : null };
}

// --- Tidy up: scanning the whole library ---

// Bar for the library scan. Stricter than at save time, because most bookmarks sit
// where the user put them on purpose. On the library these were measured on, 17 of
// 768 bookmarks in sorted folders were flagged, about half of them genuine mistakes,
// while 366 of 419 in catch-all folders had a confident home elsewhere.
export const TIDY = { minLead: 0.4, minFit: 0.3, minLooseFit: 0.35, keep: 5 };

// Bookmarks sitting directly in a root (Bookmarks bar, Other bookmarks, Mobile bookmarks)
// are unsorted too, so those roots count, as does anything inside a catch-all folder.
export function looseFolderIds(tree) {
  const loose = new Set();
  const walk = (node, depth, inLoose) => {
    if (node.url) return;
    const isLoose = inLoose || depth === 1 || (depth > 1 && LOOSE_NAME.test(node.title || ''));
    if (isLoose && depth >= 1) loose.add(node.id);
    for (const c of node.children || []) walk(c, depth + 1, isLoose && depth > 1);
  };
  for (const root of tree) walk(root, 0, false);
  return loose;
}

const branchKey = (path) => path.slice(0, 2).join('\u0000');

// Scores every bookmark against every folder in one pass.
// `vecOf(text)` returns the cached vector for a text. Each bookmark is compared with its own
// folder as if it were not in it, so a folder never vouches for its own contents.
export function scanLibrary(vecOf, folders, loose, opts = {}) {
  const t = { ...TIDY, ...opts };
  if (!folders.length) return [];
  const dim = vecOf(folders[0].name).length;
  const protos = folders.map((f) => {
    const p = new Float32Array(dim);
    for (const text of f.items) {
      const v = vecOf(text);
      for (let i = 0; i < dim; i++) p[i] += v[i];
    }
    const n = vecOf(f.name);
    for (let i = 0; i < dim; i++) p[i] += SEM.nameWeight * n[i];
    return p;
  });
  const norms = protos.map((p) => Math.sqrt(dot(p, p)) || 1);
  const branches = folders.map((f) => branchKey(f.path));
  const isLoose = folders.map((f) => loose.has(f.id));

  const found = [];
  folders.forEach((f, fi) => {
    f.items.forEach((text, k) => {
      const v = vecOf(text);
      const own = protos[fi];
      const vv = dot(v, v);
      const ownDot = dot(own, v) - vv;
      const ownNorm = Math.sqrt(Math.max(norms[fi] ** 2 - 2 * dot(own, v) + vv, 0)) || 1;
      const here = ownDot / ownNorm;

      const top = [];
      for (let gi = 0; gi < folders.length; gi++) {
        if (gi === fi || isLoose[gi]) continue;
        if (!isLoose[fi] && branches[gi] === branches[fi]) continue;
        const s = dot(protos[gi], v) / norms[gi];
        if (top.length < t.keep || s > top[top.length - 1][1]) {
          top.push([folders[gi].id, Math.round(s * 1000) / 1000]);
          top.sort((a, b) => b[1] - a[1]);
          if (top.length > t.keep) top.pop();
        }
      }
      if (!top.length) return;
      const best = top[0][1];
      const lead = best - here;
      const flagged = isLoose[fi] ? best >= t.minLooseFit : best >= t.minFit && lead >= t.minLead;
      if (!flagged) return;
      // One-word titles ("Content", "Home") give the model little to go on: show those last.
      const words = text.replace(/ \([^)]*\)$/, '').trim().split(/\s+/).filter(Boolean).length;
      found.push({
        id: f.itemIds[k],
        weak: words < 2,
        folderId: f.id,
        kind: isLoose[fi] ? 'unsorted' : 'misplaced',
        here: Math.round(here * 1000) / 1000,
        best,
        lead: Math.round(lead * 1000) / 1000,
        top
      });
    });
  });
  // Unsorted first, most confident first, then the misplaced ones by how far out they are.
  const rank = (x) => (x.kind === 'unsorted' ? 0 : 2) + (x.weak ? 1 : 0);
  return found.sort((a, b) => rank(a) - rank(b) || (a.kind === 'unsorted' ? b.best - a.best : b.lead - a.lead));
}
