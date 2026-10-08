// Just Filed: the on-device model, running in a worker thread.
// Runs all-MiniLM-L6-v2 (quantised, 23 MB, bundled with the extension) through
// ONNX Runtime's WebAssembly build. No network requests: every file is local.
// It runs off the main thread because extension pages share one: inference there
// froze the toolbar pane while the library was being read.

import * as ort from './ort.wasm.bundle.min.mjs';
import { makeTokenizer } from './tokenizer.js';
import { prototypeScores, scanLibrary } from '../src/semantic.js';

ort.env.wasm.numThreads = 1;
ort.env.wasm.wasmPaths = new URL('./', import.meta.url).href;

const BATCH = 16;
const cache = new Map(); // text -> Float32Array(384)

// --- persistence, so the library is only read once ---
const db = new Promise((resolve) => {
  const req = indexedDB.open('just-filed-vectors', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('vec');
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => resolve(null);
});
const loaded = db.then(
  (d) =>
    new Promise((resolve) => {
      if (!d) return resolve();
      const cursor = d.transaction('vec').objectStore('vec').openCursor();
      cursor.onsuccess = () => {
        const c = cursor.result;
        if (!c) return resolve();
        cache.set(c.key, new Float32Array(c.value));
        c.continue();
      };
      cursor.onerror = () => resolve();
    })
);
async function persist(entries) {
  const d = await db;
  if (!d) return;
  const store = d.transaction('vec', 'readwrite').objectStore('vec');
  for (const [text, vec] of entries) store.put(vec.buffer.slice(0), text);
}

// --- the model ---
let model;
const init = () =>
  (model ||= (async () => {
    const vocab = await (await fetch(new URL('./vocab.json', import.meta.url))).json();
    const session = await ort.InferenceSession.create(new URL('./minilm-l6-v2-q8.onnx', import.meta.url).href, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all'
    });
    return { session, encode: makeTokenizer(vocab) };
  })());

async function embedBatch(texts) {
  const { session, encode } = await init();
  const rows = texts.map(encode);
  const len = Math.max(...rows.map((r) => r.length));
  const n = rows.length;
  const ids = new BigInt64Array(n * len);
  const mask = new BigInt64Array(n * len);
  rows.forEach((row, r) => row.forEach((id, c) => ((ids[r * len + c] = BigInt(id)), (mask[r * len + c] = 1n))));
  const feeds = {
    input_ids: new ort.Tensor('int64', ids, [n, len]),
    attention_mask: new ort.Tensor('int64', mask, [n, len])
  };
  if (session.inputNames.includes('token_type_ids')) feeds.token_type_ids = new ort.Tensor('int64', new BigInt64Array(n * len), [n, len]);
  const out = await session.run(feeds);
  const hidden = out[session.outputNames[0]];
  const dim = hidden.dims[2];
  const data = hidden.data;
  return rows.map((row, r) => {
    const v = new Float32Array(dim);
    for (let c = 0; c < row.length; c++) {
      const base = (r * len + c) * dim;
      for (let i = 0; i < dim; i++) v[i] += data[base + i];
    }
    let norm = 0;
    for (let i = 0; i < dim; i++) norm += v[i] * v[i];
    norm = Math.sqrt(norm) || 1;
    for (let i = 0; i < dim; i++) v[i] /= norm;
    return v;
  });
}

let status = { state: 'idle', done: 0, total: 0 };
function report(next) {
  status = { ...status, ...next };
  postMessage({ kind: 'status', status });
}

// One queue, so a save that arrives while the library is still being read waits its turn
// for the model but never runs two inferences at once.
let queue = Promise.resolve();
function ensureVectors(texts, { announce = false } = {}) {
  const run = async () => {
    await loaded;
    const missing = [...new Set(texts)].filter((t) => !cache.has(t)).sort((a, b) => a.length - b.length);
    if (!missing.length) return 0;
    if (announce) report({ state: 'learning', done: 0, total: missing.length });
    for (let i = 0; i < missing.length; i += BATCH) {
      const chunk = missing.slice(i, i + BATCH);
      const vecs = await embedBatch(chunk);
      chunk.forEach((t, k) => cache.set(t, vecs[k]));
      await persist(chunk.map((t, k) => [t, vecs[k]]));
      if (announce) report({ done: Math.min(i + BATCH, missing.length) });
    }
    return missing.length;
  };
  const p = queue.then(run, run);
  queue = p.catch(() => {});
  return p;
}

async function handle(msg) {
  const t0 = performance.now();
  const folders = msg.folders || [];
  const libraryTexts = folders.flatMap((f) => [f.name, ...f.items]);

  if (msg.type === 'warm') {
    const embedded = await ensureVectors(libraryTexts, { announce: true });
    report({ state: 'ready', done: cache.size, total: cache.size });
    return { ok: true, embedded, ms: Math.round(performance.now() - t0) };
  }

  if (msg.type === 'score') {
    // The page first, so an answer is possible as soon as the library is known.
    await ensureVectors([msg.query]);
    const embedded = await ensureVectors(libraryTexts, { announce: true });
    if (embedded) report({ state: 'ready', done: cache.size, total: cache.size });
    const scores = prototypeScores(
      cache.get(msg.query),
      folders.map((f) => ({ id: f.id, nameVec: cache.get(f.name), itemVecs: f.items.map((t) => cache.get(t)) }))
    );
    return { ok: true, scores, embedded, ms: Math.round(performance.now() - t0) };
  }

  if (msg.type === 'scan') {
    const embedded = await ensureVectors(libraryTexts, { announce: true });
    if (embedded) report({ state: 'ready', done: cache.size, total: cache.size });
    const items = scanLibrary((t) => cache.get(t), folders, new Set(msg.loose || []));
    return { ok: true, items, ms: Math.round(performance.now() - t0) };
  }

  if (msg.type === 'status') return { ok: true, status: { ...status, known: cache.size } };
  return { ok: false, error: 'unknown request' };
}

self.onmessage = ({ data }) => {
  handle(data.msg).then(
    (reply) => postMessage({ kind: 'reply', id: data.id, reply }),
    (e) => {
      report({ state: 'error', error: String(e?.message || e) });
      postMessage({ kind: 'reply', id: data.id, reply: { ok: false, error: String(e?.message || e) } });
    }
  );
};

loaded.then(() => report({ state: cache.size ? 'ready' : 'idle', done: cache.size, total: cache.size }));
