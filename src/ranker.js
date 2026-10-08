// Just Filed: folder ranking.
// Pure functions with no Chrome APIs, so they can be tested in Node and
// swapped for an embedding-based ranker later without touching the rest.

const STOP = new Set(
  ('a an and are as at be by for from how in is it its of on or that the this to was what when where ' +
    'why with you your vs via www http https com org net gov edu html htm php aspx index home page ' +
    'new get use using amp au uk us io co app')
    .split(' ')
);

const SECOND_LEVEL = new Set(['com', 'co', 'org', 'net', 'gov', 'edu', 'ac', 'id', 'asn']);

export function hostOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

// "docs.servicesaustralia.gov.au" -> "servicesaustralia.gov.au"
export function baseDomain(host) {
  const parts = host.split('.');
  if (parts.length <= 2) return host;
  const n = parts.at(-1).length === 2 && SECOND_LEVEL.has(parts.at(-2)) ? 3 : 2;
  return parts.slice(-n).join('.');
}

export function tokenize(text) {
  const out = [];
  for (let raw of String(text || '').toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < 2 || raw.length > 24) continue;
    if (/^\d+$/.test(raw)) continue;
    if (/\d/.test(raw) && raw.length > 6) continue; // ids and hashes
    if (raw.length > 4 && raw.endsWith('s') && !raw.endsWith('ss')) raw = raw.slice(0, -1);
    if (STOP.has(raw)) continue;
    out.push(raw);
  }
  return out;
}

export function bookmarkTokens(title, url) {
  const tokens = new Set(tokenize(title));
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, '');
    for (const t of tokenize(baseDomain(host).split('.')[0])) tokens.add(t);
    for (const t of tokenize(decodeURIComponent(u.pathname))) tokens.add(t);
  } catch {
    /* not a parseable URL: title only */
  }
  return tokens;
}

const bump = (map, key, by = 1) => map.set(key, (map.get(key) || 0) + by);

// Turns chrome.bookmarks.getTree() output into one entry per folder.
export function buildIndex(tree, { excludeId, asOf = Infinity } = {}) {
  const folders = [];
  const hostTotals = new Map();
  const baseTotals = new Map();
  const folderFreq = new Map(); // token -> number of folders whose bookmarks use it

  const walk = (node, trail, ancestorTokens) => {
    if (node.url) return;
    const isRoot = node.id === '0' || node.parentId === undefined;
    const path = isRoot ? trail : [...trail, node.title || 'Untitled folder'];
    const nameTokens = new Set(isRoot ? [] : tokenize(node.title));
    const entry = {
      id: node.id,
      parentId: node.parentId,
      path,
      nameTokens,
      ancestorTokens,
      count: 0,
      lastAdded: 0,
      hosts: new Map(),
      bases: new Map(),
      tokens: new Map()
    };
    for (const child of node.children || []) {
      if (!child.url) continue;
      if (child.id === excludeId) continue;
      entry.count++;
      if (child.dateAdded && child.dateAdded < asOf && child.dateAdded > entry.lastAdded) entry.lastAdded = child.dateAdded;
      const host = hostOf(child.url);
      if (host) {
        bump(entry.hosts, host);
        bump(hostTotals, host);
        const base = baseDomain(host);
        bump(entry.bases, base);
        bump(baseTotals, base);
      }
      for (const t of bookmarkTokens(child.title, child.url)) bump(entry.tokens, t);
    }
    for (const t of entry.tokens.keys()) bump(folderFreq, t);
    if (!isRoot && !node.unmodifiable) folders.push(entry);
    const nextAncestors = new Set([...ancestorTokens, ...nameTokens]);
    for (const child of node.children || []) walk(child, path, nextAncestors);
  };
  for (const root of tree) walk(root, [], new Set());

  // The three folders most recently saved into, newest first.
  const recent = folders
    .filter((f) => f.lastAdded)
    .sort((a, b) => b.lastAdded - a.lastAdded)
    .slice(0, 3)
    .map((f) => ({ id: f.id, at: f.lastAdded }));

  return { folders, hostTotals, baseTotals, folderFreq, recent };
}

// How likely the next bookmark is to go where the last one went, given the time
// since that save. Fitted to a real library: about 80% within two minutes,
// 55% within the hour, 25% by the next day, levelling out near 15%.
export function recencyChance(msSince) {
  const minutes = Math.max(0, msSince) / 60000;
  return Math.min(0.8, Math.max(0.15, 0.93 - 0.235 * Math.log10(minutes + 1)));
}
const RECENT_SHARE = [1, 0.45, 0.3]; // most recent folder, then the two before it

const confidence = (n) => n / (n + 1); // 1 -> 0.5, 2 -> 0.67, 5 -> 0.83

// Tuned on one real library of 1,187 bookmarks in 264 folders (half to tune, half to check).
export const WEIGHTS = { domain: 0.7, name: 0.2, content: 0.2, learned: 0.6, recency: 1.1 };

// Every folder with any evidence at all, best first. `rank` trims this to what is shown.
export function scoreAll(bookmark, index, learned = {}, { now = Date.now(), weights = WEIGHTS } = {}) {
  const host = hostOf(bookmark.url);
  const base = host ? baseDomain(host) : '';
  const tokens = bookmarkTokens(bookmark.title, bookmark.url);
  const totalFolders = Math.max(index.folders.length, 1);
  const idf = (t) => Math.log(1 + totalFolders / (index.folderFreq.get(t) || 1));
  // Words no folder has seen yet say little either way, so they count for less.
  let idfSum = 0;
  for (const t of tokens) idfSum += idf(t) * (index.folderFreq.has(t) ? 1 : 0.35);

  const learnedHost = (learned.hosts && learned.hosts[host]) || {};
  const learnedBase = (learned.hosts && base !== host && learned.hosts[base]) || {};

  const scored = [];
  for (const f of index.folders) {
    const parts = { domain: 0, name: 0, content: 0, learned: 0, recency: 0 };
    let reason = '';

    // 1. Other bookmarks from the same site already live here.
    const hostN = host ? f.hosts.get(host) || 0 : 0;
    const baseN = base ? f.bases.get(base) || 0 : 0;
    if (hostN) parts.domain = (hostN / index.hostTotals.get(host)) * confidence(hostN);
    else if (baseN) parts.domain = 0.6 * (baseN / index.baseTotals.get(base)) * confidence(baseN);

    // 2. The folder's name appears in the page title or address.
    let own = 0;
    let matchedName = '';
    for (const t of f.nameTokens) {
      if (tokens.has(t)) {
        own++;
        matchedName ||= t;
      }
    }
    let anc = 0;
    for (const t of f.ancestorTokens) if (tokens.has(t)) anc++;
    if (f.nameTokens.size) parts.name = own / f.nameTokens.size;
    if (f.ancestorTokens.size) parts.name = Math.min(1, parts.name + 0.3 * (anc / f.ancestorTokens.size));

    // 3. The page shares vocabulary with bookmarks already in the folder.
    if (f.count && idfSum) {
      let sum = 0;
      for (const t of tokens) {
        const df = f.tokens.get(t);
        if (df) sum += idf(t) * Math.min(1, (2 * df) / f.count);
      }
      parts.content = (sum / idfSum) * confidence(f.count);
    }

    // 4. The user has filed this site here before.
    const learnedN = Math.max(learnedHost[f.id] || 0, 0.6 * (learnedBase[f.id] || 0));
    if (learnedN > 0) parts.learned = confidence(learnedN);

    // 5. You saved into this folder recently, so you are probably still on the same task.
    const recentAt = index.recent.findIndex((r) => r.id === f.id);
    if (recentAt >= 0) parts.recency = RECENT_SHARE[recentAt] * recencyChance(now - index.recent[recentAt].at);

    let score = 0;
    for (const k in parts) score += weights[k] * parts[k];
    if (score <= 0) continue;

    const top = Object.keys(parts).reduce((a, b) => (weights[a] * parts[a] >= weights[b] * parts[b] ? a : b));
    if (top === 'learned') reason = `You filed ${host} here before`;
    else if (top === 'recency') reason = recentAt === 0 ? 'The folder you saved to last' : 'You saved here recently';
    else if (top === 'domain') {
      const n = hostN || baseN;
      reason = `${n} other ${n === 1 ? 'bookmark' : 'bookmarks'} from ${hostN ? host : base}`;
    } else if (top === 'name') reason = matchedName ? `Folder name matches “${matchedName}”` : 'Parent folder matches';
    else reason = 'Similar to bookmarks already here';

    scored.push({ id: f.id, path: f.path, score: Math.round(score * 1000) / 1000, reason, parts });
  }

  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return scored;
}

// Decides what to do once a bookmark has landed in `currentFolderId`.
// `options` are the best other folders, always available if the user asks.
// `confident` is true only when the top option clearly beats where it landed,
// which is the bar for interrupting.
export const SPEAK = { minScore: 0.3, minLead: 0.2 };
export function decide(scored, currentFolderId, { limit = 3, minScore = 0.05 } = {}) {
  const current = scored.find((s) => s.id === currentFolderId);
  const options = scored
    .filter((s) => s.id !== currentFolderId && s.score >= minScore)
    .slice(0, limit)
    .map(({ parts, ...rest }) => rest);
  const top = options[0];
  const confident =
    !!top && scored[0].id !== currentFolderId && top.score >= SPEAK.minScore && top.score - (current?.score || 0) >= SPEAK.minLead;
  return { options, confident };
}

export function rank(bookmark, index, learned = {}, { limit = 3, minScore = 0.05, now } = {}) {
  return scoreAll(bookmark, index, learned, { now })
    .filter((s) => s.score >= minScore)
    .slice(0, limit)
    .map(({ parts, ...rest }) => rest);
}

// Type-to-find over folder names. Every word typed must appear somewhere in the
// folder's path; matches in the folder's own name count for more than matches in
// its parents. `boost` lets the ranker's scores for the current page break ties.
export function searchFolders(index, query, { limit = 6, boost = new Map(), excludeId } = {}) {
  const typed = String(query || '').toLowerCase().trim();
  const terms = typed.split(/[\s/]+/).filter(Boolean);
  if (!terms.length) return [];
  const out = [];
  for (const f of index.folders) {
    if (f.id === excludeId) continue;
    const leaf = (f.path.at(-1) || '').toLowerCase();
    const words = leaf.split(/[^\p{L}\p{N}]+/u);
    const full = f.path.join(' / ').toLowerCase();
    let score = 0;
    let matched = true;
    for (const t of terms) {
      if (leaf.startsWith(t)) score += 4;
      else if (words.some((w) => w.startsWith(t))) score += 3;
      else if (leaf.includes(t)) score += 2;
      else if (full.includes(t)) score += 1;
      else {
        matched = false;
        break;
      }
    }
    if (!matched) continue;
    if (leaf === typed) score += 5;
    score += Math.min(1, boost.get(f.id) || 0) - f.path.length * 0.01;
    out.push({ id: f.id, parentId: f.parentId, path: f.path, count: f.count, score });
  }
  out.sort((a, b) => b.score - a.score || a.path.join('/').localeCompare(b.path.join('/')));
  return out.slice(0, limit);
}

// Folder path for a given id, used to label where a bookmark currently sits.
export function pathOf(index, id) {
  const f = index.folders.find((x) => x.id === id);
  return f ? f.path : [];
}
