// The folder picker: a search box over a list of folders, used wherever a bookmark needs a home.
// With nothing typed it lists the suggested folders; typing searches every folder and offers to
// create one that does not exist yet ("Name", or "Parent / Name" to say where).

import { searchFolders } from './ranker.js';
import { el, PLUS, whereBlock } from './ui.js';

// Where a brand new folder goes: beside the folder the bookmark is in now,
// or under a named parent when the user types "Parent / New name".
function newFolderTarget(state, query) {
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

function itemsFor(state, query, searchLimit) {
  if (!query.trim()) return state.options.map((o) => ({ kind: 'folder', id: o.id, path: o.path, sub: o.reason }));
  const found = searchFolders(state.index, query, { limit: searchLimit, boost: state.boost, excludeId: state.currentFolderId }).map((f) => ({
    kind: 'folder',
    id: f.id,
    path: f.path,
    sub: f.count === 1 ? '1 bookmark' : `${f.count} bookmarks`
  }));
  const fresh = newFolderTarget(state, query);
  if (fresh) found.push({ kind: 'create', ...fresh, path: [...fresh.parentPath, fresh.name] });
  return found;
}

// `state` needs: index, options, boost, currentFolderId.
// `onChoose(item)` is called with the folder (or folder-to-create) the user picked.
// `fit(list)` lets the host cap the list's height after each paint (the popup has a height limit).
// `quietNote()` says whether to hide the "closest other folders" line above the suggestions.
export function createPicker({ state, onChoose, fit, quietNote = () => false, searchLimit = 6 }) {
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
        row.addEventListener('click', () => onChoose(item));
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
    fit?.(list);
    list.children[selected]?.scrollIntoView({ block: 'nearest' });
  };

  const refresh = () => {
    const q = input.value;
    items = itemsFor(state, q, searchLimit);
    selected = 0;
    const typing = Boolean(q.trim());
    if (!items.length) note.textContent = typing ? 'Nothing else matches.' : 'Type to find any folder, or name a new one.';
    else note.textContent = 'These are the closest other folders.';
    note.hidden = items.length > 0 && (typing || quietNote());
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
      onChoose(items[selected]);
    }
  });

  // Replays the gentle one-by-one arrival, for when the suggestions themselves change.
  const restagger = () => {
    list.classList.remove('enter');
    void list.offsetWidth;
    list.classList.add('enter');
  };

  return { input, note, list, hint, refresh, restagger };
}
