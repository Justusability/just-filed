import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, rank, baseDomain, hostOf, tokenize } from '../src/ranker.js';

let nextId = 100;
const bm = (title, url) => ({ id: String(nextId++), title, url });
const folder = (id, title, children = []) => ({ id, title, parentId: 'p', children });

const tree = [
  {
    id: '0',
    title: '',
    children: [
      folder('1', 'Bookmarks bar', [
        bm('Random article', 'https://example.org/a'),
        folder('10', 'Design', [
          folder('11', 'Research', [
            bm('Nielsen Norman Group: 10 usability heuristics', 'https://www.nngroup.com/articles/ten-usability-heuristics/'),
            bm('How many test users in a usability study?', 'https://www.nngroup.com/articles/how-many-test-users/'),
            bm('Usability testing 101', 'https://www.nngroup.com/articles/usability-testing-101/')
          ]),
          folder('12', 'Figma', [bm('Auto layout guide', 'https://help.figma.com/hc/en-us/articles/360040451373')]),
          folder('13', 'Accessibility', [
            bm('WCAG 2.2 quick reference', 'https://www.w3.org/WAI/WCAG22/quickref/'),
            bm('Screen reader testing with NVDA', 'https://webaim.org/articles/nvda/')
          ])
        ]),
        folder('20', 'Recipes', [bm('Loaded baked potato', 'https://www.taste.com.au/recipes/loaded-baked-potato')]),
        folder('30', 'Government', [bm('myGov help', 'https://my.gov.au/en/about/help')])
      ]),
      folder('2', 'Other bookmarks', [])
    ]
  }
];

const index = buildIndex(tree);
const top = (title, url, learned) => rank({ title, url }, index, learned)[0];

test('helpers', () => {
  assert.equal(hostOf('https://www.nngroup.com/x'), 'nngroup.com');
  assert.equal(hostOf('chrome://settings'), '');
  assert.equal(baseDomain('docs.servicesaustralia.gov.au'), 'servicesaustralia.gov.au');
  assert.equal(baseDomain('help.figma.com'), 'figma.com');
  assert.deepEqual(tokenize('The AI UX of forms'), ['ai', 'ux', 'form']);
});

test('same site wins', () => {
  const s = top('Empty states', 'https://www.nngroup.com/articles/empty-state-interface-design/');
  assert.equal(s.id, '11');
  assert.deepEqual(s.path, ['Bookmarks bar', 'Design', 'Research']);
  assert.match(s.reason, /3 other bookmarks from nngroup\.com/);
});

test('subdomain of a known site still matches', () => {
  assert.equal(top('Community file', 'https://www.figma.com/community/file/123').id, '12');
});

test('folder name in the title matches an unseen site', () => {
  const s = top('An accessibility checklist for forms', 'https://unknown-blog.dev/post/42');
  assert.equal(s.id, '13');
  assert.match(s.reason, /accessibility/);
});

test('shared vocabulary matches an unseen site', () => {
  assert.equal(top('Running a moderated usability study', 'https://somewhere.else/usability-study').id, '11');
});

test('an unrelated page gets no suggestion', () => {
  assert.deepEqual(rank({ title: 'Flight deals to Tokyo', url: 'https://airline.example/deals' }, index), []);
});

test('learning overrides a weak signal', () => {
  const learned = { hosts: { 'airline.example': { 20: 2 } } };
  const s = top('Flight deals to Tokyo', 'https://airline.example/deals', learned);
  assert.equal(s.id, '20');
  assert.match(s.reason, /filed airline\.example here before/);
});

test('the bookmark being filed does not vote for its own folder', () => {
  const t = structuredClone(tree);
  t[0].children[1].children.push({ id: '999', title: 'Tokyo deals', url: 'https://airline.example/deals' });
  const withSelf = rank({ title: 'Tokyo deals', url: 'https://airline.example/deals' }, buildIndex(t));
  const without = rank({ title: 'Tokyo deals', url: 'https://airline.example/deals' }, buildIndex(t, { excludeId: '999' }));
  assert.equal(withSelf[0]?.id, '2');
  assert.deepEqual(without, []);
});

test('returns at most three, best first', () => {
  const r = rank({ title: 'Design research on accessibility in Figma', url: 'https://x.dev/p' }, index);
  assert.ok(r.length <= 3 && r.length >= 2);
  assert.ok(r[0].score >= r[1].score);
});

// --- recency and the decision to speak ---
import { scoreAll, decide, recencyChance } from '../src/ranker.js';

const NOW = Date.UTC(2026, 9, 8, 1, 0, 0);
const minutesAgo = (m) => NOW - m * 60000;
const dated = (title, url, at) => ({ ...bm(title, url), dateAdded: at });
const recentTree = (lastSave = 3) => [
  {
    id: '0',
    title: '',
    children: [
      folder('1', 'Bookmarks bar', [
        folder('40', 'Client project', [dated('Pricing page teardown', 'https://a.example/pricing', minutesAgo(lastSave))]),
        folder('41', 'Recipes', [dated('Loaded baked potato', 'https://taste.example/potato', minutesAgo(60 * 24 * 9))]),
        folder('42', 'Research', [
          dated('Usability heuristics', 'https://www.nngroup.com/articles/ten-usability-heuristics/', minutesAgo(60 * 24 * 30)),
          dated('Test users', 'https://www.nngroup.com/articles/how-many-test-users/', minutesAgo(60 * 24 * 31)),
          dated('Testing 101', 'https://www.nngroup.com/articles/usability-testing-101/', minutesAgo(60 * 24 * 32))
        ])
      ])
    ]
  }
];

test('recency fades with time', () => {
  assert.ok(recencyChance(60000) > recencyChance(3600000));
  assert.ok(recencyChance(3600000) > recencyChance(86400000));
  assert.equal(recencyChance(30 * 86400000), 0.15);
});

test('an unrelated page goes to the folder saved into minutes ago', () => {
  const idx = buildIndex(recentTree());
  const s = scoreAll({ title: 'AI video generator', url: 'https://vid.example/' }, idx, {}, { now: NOW });
  assert.equal(s[0].id, '40');
  assert.equal(s[0].reason, 'The folder you saved to last');
});

// In the library these weights were fitted to, a folder saved into minutes ago was right
// about two times in three even when another folder held the same site. After a few hours
// the site evidence wins.
test('a save minutes ago outweighs site evidence', () => {
  const idx = buildIndex(recentTree(3));
  const s = scoreAll({ title: 'Empty states', url: 'https://www.nngroup.com/articles/empty-states/' }, idx, {}, { now: NOW });
  assert.equal(s[0].id, '40');
  assert.equal(s[1].id, '42');
});

test('site evidence outweighs a save from hours ago', () => {
  const idx = buildIndex(recentTree(180));
  const s = scoreAll({ title: 'Empty states', url: 'https://www.nngroup.com/articles/empty-states/' }, idx, {}, { now: NOW });
  assert.equal(s[0].id, '42');
});

test('stays quiet when the bookmark landed where the evidence points', () => {
  const idx = buildIndex(recentTree());
  const s = scoreAll({ title: 'AI video generator', url: 'https://vid.example/' }, idx, {}, { now: NOW });
  const d = decide(s, '40');
  assert.equal(d.confident, false);
});

test('speaks when another folder clearly beats where it landed', () => {
  const idx = buildIndex(recentTree(60 * 24));
  const s = scoreAll({ title: 'Empty states', url: 'https://www.nngroup.com/articles/empty-states/' }, idx, {}, { now: NOW });
  const d = decide(s, '40');
  assert.equal(d.confident, true);
  assert.equal(d.options[0].id, '42');
  assert.ok(!d.options.some((o) => o.id === '40'));
});

test('a weak match is offered on request but does not interrupt', () => {
  const idx = buildIndex(recentTree());
  const s = scoreAll({ title: 'Potato growing guide', url: 'https://garden.example/' }, idx, {}, { now: NOW });
  const d = decide(s, '40');
  assert.equal(d.confident, false);
  assert.ok(d.options.some((o) => o.id === '41'));
});

// --- type-to-find ---
import { searchFolders } from '../src/ranker.js';

test('search finds a folder by the start of its name', () => {
  const r = searchFolders(index, 'acc');
  assert.equal(r[0].id, '13');
});

test('search matches every word, in the name or its parents', () => {
  assert.equal(searchFolders(index, 'design fig')[0].id, '12');
  assert.deepEqual(searchFolders(index, 'design zzz'), []);
});

test('an exact name comes first, and the current folder can be left out', () => {
  assert.equal(searchFolders(index, 'design')[0].id, '10');
  assert.ok(!searchFolders(index, 'design', { excludeId: '10' }).some((f) => f.id === '10'));
});

test('the page ranking breaks ties between equal matches', () => {
  // "Recipes" and "Research" both start with "re"; the shallower one wins unless the page points elsewhere.
  assert.equal(searchFolders(index, 're')[0].id, '20');
  assert.equal(searchFolders(index, 're', { boost: new Map([['11', 0.9]]) })[0].id, '11');
});

// --- matching by meaning ---
import { prototypeScores, misfit, combine, folderTexts, bookmarkText, folderText } from '../src/semantic.js';

const unit = (...v) => {
  const n = Math.hypot(...v);
  return Float32Array.from(v.map((x) => x / n));
};

test('texts handed to the model', () => {
  assert.equal(bookmarkText('Fasset – Islamic Bank', 'https://www.fasset.com/'), 'Fasset – Islamic Bank (fasset.com)');
  assert.equal(folderText(['Bookmarks bar', 'Design', 'Research']), 'Design / Research');
  assert.equal(folderText(['Bookmarks bar']), 'Bookmarks bar');
  const t = folderTexts(tree, { excludeId: 'nope' });
  const research = t.find((f) => f.id === '11');
  assert.equal(research.name, 'Design / Research');
  assert.equal(research.items.length, 3);
  assert.ok(!t.some((f) => f.id === '0'));
});

test('a folder scores by what is in it and what it is called', () => {
  const s = prototypeScores(unit(1, 0, 0), [
    { id: 'money', nameVec: unit(1, 0.1, 0), itemVecs: [unit(1, 0, 0.1), unit(0.9, 0.2, 0)] },
    { id: 'tools', nameVec: unit(0, 1, 0), itemVecs: [unit(0, 1, 0.1)] },
    { id: 'empty', nameVec: unit(0.6, 0.8, 0), itemVecs: [] }
  ]);
  assert.ok(s.money > 0.95);
  assert.ok(s.tools < 0.1);
  assert.ok(s.empty > 0.55 && s.empty < 0.65);
});

// folders: 13 Accessibility and 11 Research sit under Design; 20 Recipes and 30 Government are their own branches
test('a page that fits another branch far better is flagged as misfiled', () => {
  assert.equal(misfit({ 20: 0.05, 30: 0.5, 11: 0.2 }, index, '20').id, '30');
  assert.equal(misfit({ 20: 0.3, 30: 0.5 }, index, '20'), null, 'lead too small');
  assert.equal(misfit({ 20: 0.25, 30: 0.5 }, index, '20', 0.3), null, 'under the balanced bar');
  assert.equal(misfit({ 20: 0.25, 30: 0.5 }, index, '20', 0.2).id, '30', 'over the often bar');
  const fit = {};
  misfit({ 20: 0.25, 30: 0.56 }, index, '20', 0.3, fit);
  assert.deepEqual({ here: fit.here, best: fit.best, lead: fit.lead, needs: fit.needs }, { here: 0.25, best: 0.56, lead: 0.31, needs: 0.3 });
  assert.equal(misfit({ 20: 0.0, 30: 0.25 }, index, '20'), null, 'fit too weak');
  assert.equal(misfit({ 11: 0.05, 13: 0.6 }, index, '11'), null, 'same branch does not count');
});

test('meaning joins the rules, and a misfit puts its folder on show', () => {
  const scored = scoreAll({ title: 'Stablecoin bank', url: 'https://fasset.example/' }, index, {});
  const without = combine(scored, null, index, '20');
  assert.equal(without.confident, false);
  assert.equal(without.misfit, false);

  const withMeaning = combine(scored, { 20: 0.02, 30: 0.48, 13: 0.3, 11: 0.31, 12: 0.33 }, index, '20');
  assert.equal(withMeaning.misfit, true);
  assert.equal(withMeaning.confident, true);
  assert.equal(withMeaning.options[0].id, '30');
  assert.equal(withMeaning.options[0].reason, 'Similar in meaning to this folder');
  assert.ok(!withMeaning.options.some((o) => o.id === '20'));
});

// --- tidy up ---
import { looseFolderIds, scanLibrary } from '../src/semantic.js';

test('catch-all folders and the roots count as unsorted, their sorted children do not', () => {
  const t = [
    {
      id: '0',
      title: '',
      children: [
        {
          id: '1',
          title: 'Bookmarks bar',
          parentId: '0',
          children: [
            { id: '2', title: 'Design', parentId: '1', children: [] },
            { id: '3', title: 'Uncategorized', parentId: '1', children: [{ id: '4', title: '_Loose Bookmarks', parentId: '3', children: [] }] },
            { id: '5', title: 'Imported', parentId: '1', children: [] }
          ]
        },
        { id: '6', title: 'Other bookmarks', parentId: '0', children: [] }
      ]
    }
  ];
  assert.deepEqual([...looseFolderIds(t)].sort(), ['1', '3', '4', '5', '6']);
});

test('the scan flags misplaced bookmarks across branches and finds homes for unsorted ones', () => {
  const vec = {
    // folder names
    'Money': unit(1, 0, 0),
    'Tools / AI': unit(0, 1, 0),
    'Tools / Editors': unit(0, 0.9, 0.3),
    'Loose': unit(0.3, 0.3, 0.9),
    // bookmarks
    'bank (b.com)': unit(1, 0.05, 0),
    'budget app (c.com)': unit(0.95, 0.1, 0),
    'gpt (d.com)': unit(0.05, 1, 0),
    'stablecoin bank (e.com)': unit(1, 0, 0.05), // in AI tools by mistake
    'vim (f.com)': unit(0, 0.85, 0.35), // in AI tools: other folder is the same branch, so not flagged
    'savings tips (g.com)': unit(0.98, 0.1, 0.1) // unsorted
  };
  const folders = [
    { id: 'm', path: ['Bar', 'Money'], name: 'Money', items: ['bank (b.com)', 'budget app (c.com)'], itemIds: ['b', 'c'] },
    { id: 'ai', path: ['Bar', 'Tools', 'AI'], name: 'Tools / AI', items: ['gpt (d.com)', 'stablecoin bank (e.com)', 'vim (f.com)'], itemIds: ['d', 'e', 'f'] },
    { id: 'ed', path: ['Bar', 'Tools', 'Editors'], name: 'Tools / Editors', items: [], itemIds: [] },
    { id: 'lo', path: ['Bar', 'Loose'], name: 'Loose', items: ['savings tips (g.com)'], itemIds: ['g'] }
  ];
  const found = scanLibrary((t) => vec[t], folders, new Set(['lo']));
  assert.deepEqual(found.map((f) => [f.id, f.kind, f.top[0][0]]), [
    ['g', 'unsorted', 'm'],
    ['e', 'misplaced', 'm']
  ]);
  assert.ok(!found.some((f) => f.top.some(([id]) => id === 'lo')), 'never suggests a catch-all folder');
});
