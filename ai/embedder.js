// Just Filed: the offscreen page that hosts the model.
// It only relays messages; the model itself runs in a worker (model-worker.js) so
// that inference never blocks the toolbar pane, which shares this page's main thread.

const worker = new Worker(new URL('./model-worker.js', import.meta.url), { type: 'module' });
const waiting = new Map();
let seq = 0;

worker.onmessage = ({ data }) => {
  if (data.kind === 'status') {
    chrome.runtime.sendMessage({ type: 'jf-ai-status', status: data.status }).catch(() => {});
    return;
  }
  const done = waiting.get(data.id);
  waiting.delete(data.id);
  done?.(data.reply);
};
worker.onerror = (e) => {
  const error = e.message || 'The model could not start';
  chrome.runtime.sendMessage({ type: 'jf-ai-status', status: { state: 'error', error } }).catch(() => {});
  for (const done of waiting.values()) done({ ok: false, error });
  waiting.clear();
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'jf-embedder') return;
  const id = ++seq;
  waiting.set(id, sendResponse);
  worker.postMessage({ id, msg });
  return true;
});
