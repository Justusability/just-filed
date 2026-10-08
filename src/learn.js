// Remembers which folder the user files each site into. Stored on this device only.
export async function bumpLearned(host, folderId, delta) {
  if (!host || !folderId) return;
  const { learned = {} } = await chrome.storage.local.get('learned');
  learned.hosts ||= {};
  const forHost = (learned.hosts[host] ||= {});
  forHost[folderId] = (forHost[folderId] || 0) + delta;
  if (forHost[folderId] <= 0) delete forHost[folderId];
  if (!Object.keys(forHost).length) delete learned.hosts[host];
  await chrome.storage.local.set({ learned });
}
