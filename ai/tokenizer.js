// BERT WordPiece tokenizer for the bundled MiniLM model: lower-case, strip accents,
// split on whitespace and punctuation, then greedy longest-match into word pieces.
// Checked token-for-token against the reference tokenizer on a real bookmark library.

const CLS = 101;
const SEP = 102;
const UNK = 100;

const isPunct = (ch) => {
  const c = ch.codePointAt(0);
  if ((c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126)) return true;
  return /\p{P}/u.test(ch);
};
const isCjk = (c) =>
  (c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x20000 && c <= 0x2a6df) ||
  (c >= 0x2a700 && c <= 0x2b73f) || (c >= 0x2b740 && c <= 0x2b81f) || (c >= 0x2b820 && c <= 0x2ceaf) ||
  (c >= 0xf900 && c <= 0xfaff) || (c >= 0x2f800 && c <= 0x2fa1f);

function words(text) {
  let clean = '';
  for (const ch of String(text || '')) {
    const c = ch.codePointAt(0);
    if (c === 0 || c === 0xfffd) continue;
    if (ch === '\t' || ch === '\n' || ch === '\r' || /\p{Zs}/u.test(ch)) clean += ' ';
    else if (/\p{Cc}|\p{Cf}/u.test(ch)) continue;
    else if (isCjk(c)) clean += ` ${ch} `;
    else clean += ch;
  }
  clean = clean.normalize('NFD').replace(/\p{Mn}/gu, '').toLowerCase();
  const out = [];
  for (const chunk of clean.split(/\s+/)) {
    let word = '';
    for (const ch of chunk) {
      if (isPunct(ch)) {
        if (word) out.push(word);
        out.push(ch);
        word = '';
      } else word += ch;
    }
    if (word) out.push(word);
  }
  return out;
}

export function makeTokenizer(vocabList, maxTokens = 64) {
  const vocab = new Map(vocabList.map((t, i) => [t, i]));
  return function encode(text) {
    const ids = [CLS];
    outer: for (const word of words(text)) {
      const chars = [...word];
      if (chars.length > 100) {
        ids.push(UNK);
        continue;
      }
      const pieces = [];
      let start = 0;
      while (start < chars.length) {
        let end = chars.length;
        let found = -1;
        while (start < end) {
          const piece = (start ? '##' : '') + chars.slice(start, end).join('');
          if (vocab.has(piece)) {
            found = vocab.get(piece);
            break;
          }
          end--;
        }
        if (found < 0) {
          ids.push(UNK);
          continue outer;
        }
        pieces.push(found);
        start = end;
      }
      ids.push(...pieces);
    }
    const body = ids.slice(0, maxTokens - 1);
    body.push(SEP);
    return body;
  };
}
