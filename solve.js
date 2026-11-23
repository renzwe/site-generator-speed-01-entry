// solve.js — a faster drop-in for makefun-site 1.0.0's build().
// Reimplemented from scratch against vendor/makefun-site/README.md and its reference
// code (the code wins wherever they differ). Self-contained: no imports, no state
// kept between run() calls. Every answer must be byte-identical to the reference.

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/;

function escapeHtml(text) {
  if (!ESC_RE.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

/** Per-run cache of escaped strings, for template {{ }} values: the same titles, urls and tag names are escaped on many renders, so the escape is paid once per distinct value. */
let escCache = new Map();

/** escapeHtml with a per-run cache (used only for template values; inline() keeps the uncached escapeHtml, whose plain runs are mostly unique slices). */
function escapeCached(text) {
  const hit = escCache.get(text);
  if (hit !== undefined) return hit;
  const out = escapeHtml(text);
  escCache.set(text, out);
  return out;
}

const SLUG_MAX = 64;

/** Per-run slug cache; replaced by run() for every case. */
let slugCache = new Map();

/**
 * The slug of `text`. Pure-ASCII text is unchanged by NFKD and holds no combining
 * marks, so it skips the (slow) normalise step entirely; anything else goes the
 * reference route. Results are cached per run. The slug rule, spelled out: keep
 * a-z0-9 (A-Z lowered), every other run becomes one '-', no leading or trailing
 * '-', cut to 64 chars before the trailing '-' is stripped. toLowerCase +
 * replace does exactly that (the NFKD step already ran for non-ASCII, so a
 * lowercasing that could add a combining mark cannot happen here).
 */
/** The dashed form of a lowercased string: a-z0-9 kept (A-Z lowered inline), every other run one '-', no leading or trailing '-', cut to 64 chars before the trailing '-' is stripped — exactly the regex chain's result, in one scan. */
function dashed(text) {
  let out = '';
  let dash = true;
  for (let i = 0; i < text.length; i++) {
    let c = text.charCodeAt(i);
    if (c >= 65 && c <= 90) c += 32;
    if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) { out += String.fromCharCode(c); dash = false; }
    else if (!dash) { out += '-'; dash = true; }
  }
  if (out.length > SLUG_MAX) out = out.slice(0, SLUG_MAX);
  let end = out.length;
  while (end > 0 && out[end - 1] === '-') end--;
  return out.slice(0, end);
}

function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  // Non-ASCII goes the reference route first (NFKD, strip marks, lowercase),
  // then the same single scan; pure ASCII skips the (slow) normalise step.
  const out = /[^\x00-\x7F]/.test(text) ? dashed(text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()) : dashed(text);
  const slug = out === '' ? 'untitled' : out;
  slugCache.set(text, slug);
  return slug;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  return `${Number(date.slice(8, 10))} ${MONTHS[Number(date.slice(5, 7)) - 1]} ${date.slice(0, 4)}`;
}

/** The words of a body: runs of characters other than whitespace (counted, not listed). Fast paths for the common ASCII bytes (space, LF, letters) keep the per-character cost to two or three comparisons; the full Unicode whitespace set is only consulted for non-ASCII bytes. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32 || c === 10) { inWord = false; continue; }
    if (c < 128) {
      if (c === 9 || c === 11 || c === 12 || c === 13) { inWord = false; continue; }
      if (!inWord) { inWord = true; n++; }
      continue;
    }
    const ws = c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff;
    if (ws) inWord = false;
    else if (!inWord) { inWord = true; n++; }
  }
  return n;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** Whether `target` is an absolute URI (a scheme, `^[A-Za-z][A-Za-z0-9+.-]*:`): a letter, then scheme characters, then ':'. */
function isAbsoluteUri(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let i = 1; i < target.length; i++) {
    const c = target.charCodeAt(i);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** `rel` from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

// ---------------------------------------------------------------- front matter

const KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare (never opening on " or [). */
function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    const inner = raw.slice(1, -1);
    if (inner.indexOf('\\') === -1) {
      if (inner.indexOf('"') !== -1) return { error: 'a quoted string holds a stray quote' };
      return { value: inner };
    }
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      // YYYY-MM-DD, 1970-01-01 to 2099-12-31, by character checks.
      let bad = raw.length !== 10 || raw[4] !== '-' || raw[7] !== '-';
      if (!bad) {
        for (let q = 0; q < 10; q++) {
          if (q === 4 || q === 7) continue;
          const c = raw.charCodeAt(q);
          if (c < 48 || c > 57) { bad = true; break; }
        }
      }
      const y = bad ? 0 : (raw.charCodeAt(0) - 48) * 1000 + (raw.charCodeAt(1) - 48) * 100 + (raw.charCodeAt(2) - 48) * 10 + (raw.charCodeAt(3) - 48);
      const mo = bad ? 0 : (raw.charCodeAt(5) - 48) * 10 + (raw.charCodeAt(6) - 48);
      const d = bad ? 0 : (raw.charCodeAt(8) - 48) * 10 + (raw.charCodeAt(9) - 48);
      if (bad || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      for (const t of tags) {
        if (t === '') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        for (let q = 0; q < t.length; q++) {
          const c = t[q];
          if (c === '"' || c === '[' || c === ']') return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
        }
      }
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout': {
      // A template name: [a-z0-9-]+.
      if (raw.length === 0) return { error: 'key "layout": not a template name' };
      for (let q = 0; q < raw.length; q++) {
        const c = raw.charCodeAt(q);
        if (!((c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 45)) return { error: 'key "layout": not a template name' };
      }
      return { value: raw };
    }
    case 'slug': {
      // A slug: [a-z0-9]+ segments joined by single '-', at most 64 chars.
      if (raw.length === 0 || raw.length > 64) return { error: 'key "slug": not a slug' };
      let prevDash = true;
      for (let q = 0; q < raw.length; q++) {
        const c = raw.charCodeAt(q);
        if (c === 45) {
          if (prevDash) return { error: 'key "slug": not a slug' };
          prevDash = true;
        } else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) prevDash = false;
        else return { error: 'key "slug": not a slug' };
      }
      if (prevDash) return { error: 'key "slug": not a slug' };
      return { value: raw };
    }
    default:
      return { error: `unknown key "${key}"` };
  }
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. Scans lines by index instead of splitting the whole body.
 */
function parseFrontMatter(text) {
  let nl = text.indexOf('\n');
  const firstEnd = nl === -1 ? text.length : nl;
  if (text.slice(0, firstEnd) !== '---') return { error: 'no front matter' };
  if (nl === -1) return { error: 'the front matter is not closed' };
  // Scan for the closing line first (a bad data line never beats "not closed").
  const fmLines = [];
  let pos = nl + 1;
  let closeEnd = -1;
  let closed = false;
  while (pos <= text.length) {
    const e = text.indexOf('\n', pos);
    const le = e === -1 ? text.length : e;
    const line = text.slice(pos, le);
    if (line === '---') {
      closed = true;
      closeEnd = e === -1 ? text.length : e + 1;
      break;
    }
    fmLines.push(line);
    if (e === -1) break;
    pos = e + 1;
  }
  if (!closed) return { error: 'the front matter is not closed' };
  const data = {};
  for (let i = 0; i < fmLines.length; i++) {
    const line = fmLines[i];
    if (line[0] === '#' || isBlank(line)) continue;
    const colon = line.indexOf(':');
    if (colon <= 0) return { error: `line ${i + 2} is not "key: value"` };
    const key = line.slice(0, colon);
    let keyOk = true;
    for (let q = 0; q < key.length; q++) {
      const c = key.charCodeAt(q);
      if (!((c >= 97 && c <= 122) || c === 95)) { keyOk = false; break; }
    }
    if (!keyOk) return { error: `line ${i + 2} is not "key: value"` };
    let raw;
    if (colon === line.length - 1) raw = '';
    else if (line[colon + 1] === ' ') {
      raw = line.slice(colon + 2);
      let end = raw.length;
      while (end > 0 && (raw[end - 1] === ' ' || raw[end - 1] === '\t')) end--;
      raw = raw.slice(0, end);
    } else return { error: `line ${i + 2} is not "key: value"` };
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd) };
}

// ---------------------------------------------------------------- Markdown

/** A bullet line's item text, or null: '-' or '*' plus one space (the /^[-*] (.*)$/ test, by hand). */
function bulletOf(line) {
  if ((line[0] === '-' || line[0] === '*') && line[1] === ' ') return line.slice(2);
  return null;
}

/** An ordered line's [number, text], or null: 1-9 digits, '. ', then text (the /^(\d{1,9})\. (.*)$/ test, by hand). */
function orderedOf(line) {
  let d = 0;
  while (d < 9 && line.charCodeAt(d) >= 48 && line.charCodeAt(d) <= 57) d++;
  if (d === 0) return null;
  if (d === 9 && line.charCodeAt(9) >= 48 && line.charCodeAt(9) <= 57) return null;
  if (line[d] !== '.' || line[d + 1] !== ' ') return null;
  return [line.slice(0, d), line.slice(d + 2)];
}

/** Whether `line` continues a list item: 2+ spaces, then a non-whitespace character (the /^ {2,}\S/ test, by hand). */
function isContinued(line) {
  let i = 0;
  while (line[i] === ' ') i++;
  if (i < 2 || i >= line.length) return false;
  const c = line.charCodeAt(i);
  return !(c === 32 || (c >= 9 && c <= 13) || c === 0x00a0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) || c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f || c === 0x3000 || c === 0xfeff);
}

/** Whether `line` holds only spaces and tabs (or is empty). */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A fence-open line's language, or null: ``` plus lang chars [A-Za-z0-9_+-]* plus trailing space/tab only. */
function fenceLang(line) {
  if (!line.startsWith('```')) return null;
  let i = 3;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) i++;
    else break;
  }
  const lang = line.slice(3, i);
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i === line.length ? lang : null;
}

/** Whether `line` closes a fence: ``` plus trailing space/tab only. */
function isFenceClose(line) {
  if (!line.startsWith('```')) return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** Whether `line` is a thematic break: --- or *** plus trailing space/tab only. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let i = 3; i < line.length; i++) {
    if (line[i] !== ' ' && line[i] !== '\t') return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty): 1-6 #'s, 1+ spaces/tabs, text with trailing space/tab stripped. */
function headingOf(line) {
  let i = 0;
  while (i < line.length && line[i] === '#') i++;
  if (i === 0 || i > 6) return null;
  if (i >= line.length || (line[i] !== ' ' && line[i] !== '\t')) return null;
  let j = i;
  while (j < line.length && (line[j] === ' ' || line[j] === '\t')) j++;
  let k = line.length;
  while (k > j && (line[k - 1] === ' ' || line[k - 1] === '\t')) k--;
  if (k <= j) return null;
  return { depth: i, text: line.slice(j, k) };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (line.length === 0) return true;
  const c0 = line[0];
  if (c0 === ' ' || c0 === '\t') return isBlank(line);
  if (c0 === '`') return fenceLang(line) !== null;
  if (c0 === '#') return headingOf(line) !== null;
  if (c0 === '-' || c0 === '*') return isHr(line);
  return false;
}

/** A paragraph line as it is rendered: spaces and tabs at either end dropped. */
const trimLine = (line) => {
  let a = 0;
  let b = line.length;
  while (a < b && (line[a] === ' ' || line[a] === '\t')) a++;
  while (b > a && (line[b - 1] === ' ' || line[b - 1] === '\t')) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. With no backslash at all in range, a plain indexOf is exact. */
function findUnescaped(s, what, from) {
  if (s.indexOf('\\', from) === -1) return s.indexOf(what, from);
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. With no backslash in range, hop between '*' runs with indexOf: a run's last star is single exactly when the run has odd length, which is what the scan below also returns. */
function findSingleStar(s, from) {
  if (s.indexOf('\\', from) === -1) {
    let j = s.indexOf('*', from);
    while (j !== -1 && s[j + 1] === '*') j = s.indexOf('*', j + 2);
    return j;
  }
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs between the
 * special characters (`\`, backtick, `*`, `[`) are escaped in one pass each, instead
 * of one escape call per character.
 */
function inline(s, env) {
  const n = s.length;
  let out = '';
  let i = 0;
  while (i < n) {
    // The next special character, by native indexOf (no per-call regex, and
    // recursion-safe: no shared regex state to clobber).
    let next = n;
    let kind = 0;
    let j = s.indexOf('\\', i);
    if (j !== -1 && j < next) { next = j; kind = 1; }
    j = s.indexOf('`', i);
    if (j !== -1 && j < next) { next = j; kind = 2; }
    j = s.indexOf('*', i);
    if (j !== -1 && j < next) { next = j; kind = 3; }
    j = s.indexOf('[', i);
    if (j !== -1 && j < next) { next = j; kind = 4; }
    if (next > i) out += escapeHtml(s.slice(i, next));
    if (next >= n) break;
    i = next;
    if (kind === 1) {
      const c = s[i + 1];
      if (c !== undefined && ESCAPABLE.has(c)) {
        out += escapeHtml(c);
        i += 2;
      } else {
        out += '\\';
        i++;
      }
    } else if (kind === 2) {
      const j2 = s.indexOf('`', i + 1);
      if (j2 > i + 1) {
        out += `<code>${escapeHtml(s.slice(i + 1, j2))}</code>`;
        i = j2 + 1;
      } else {
        out += '`';
        i++;
      }
    } else if (kind === 3) {
      if (s[i + 1] === '*') {
        const j2 = findUnescaped(s, '**', i + 2);
        if (j2 > i + 2) {
          out += `<strong>${inline(s.slice(i + 2, j2), env)}</strong>`;
          i = j2 + 2;
        } else {
          out += '**';
          i += 2;
        }
      } else {
        const j2 = findSingleStar(s, i + 1);
        if (j2 > i + 1) {
          out += `<em>${inline(s.slice(i + 1, j2), env)}</em>`;
          i = j2 + 1;
        } else {
          out += '*';
          i++;
        }
      }
    } else {
      const k = findUnescaped(s, ']', i + 1);
      const mm = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = mm === -1 ? '' : s.slice(k + 2, mm);
      if (target !== '' && !/\s/.test(target)) {
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = mm + 1;
      } else {
        out += '[';
        i++;
      }
    }
  }
  return out;
}

/**
 * `src` rendered in one pass over its lines (no token objects): its HTML, its
 * table of contents (level 2 and 3 headings) and its excerpt (first paragraph).
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (line.length === 0 || ((line[0] === ' ' || line[0] === '\t') && isBlank(line))) {
      i++;
      continue;
    }
    const lang = line.startsWith('```') ? fenceLang(line) : null;
    if (lang !== null) {
      const body = [];
      i++;
      while (i < n && !isFenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`;
      // Escaping is char-wise and '\n' is never escaped, so escaping the joined
      // body once is the same as escaping each line: one call, not one per line.
      const code = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
      blocks.push(`<pre><code${cls}>${code}</code></pre>`);
      continue;
    }
    const heading = line[0] === '#' ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if ((line[0] === '-' || line[0] === '*') && isHr(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (line[0] === '>') {
      const body = [];
      while (i < n && lines[i][0] === '>') body.push(lines[i++].replace(/^> ?/, ''));
      const qlines = [];
      for (let k = 0; k < body.length; k++) {
        const t = trimLine(body[k]);
        if (t !== '') qlines.push(t);
      }
      blocks.push(qlines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(qlines.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    let bulletText = null;
    let orderedPair = null;
    if (line[0] === '-' || line[0] === '*') bulletText = bulletOf(line);
    if (bulletText === null && line[0] >= '0' && line[0] <= '9') orderedPair = orderedOf(line);
    if (bulletText !== null || orderedPair !== null) {
      const isOrdered = orderedPair !== null;
      const startNum = isOrdered ? Number(orderedPair[0]) : 1;
      const items = [];
      while (i < n) {
        const ln = lines[i];
        let text = null;
        if (isOrdered) {
          if (ln[0] >= '0' && ln[0] <= '9') {
            const o = orderedOf(ln);
            if (o !== null) text = o[1];
          }
        } else if (ln[0] === '-' || ln[0] === '*') text = bulletOf(ln);
        if (text !== null) {
          items.push([trimLine(text)]);
          i++;
        } else if (ln[0] === ' ' && ln[1] === ' ' && isContinued(ln)) {
          items[items.length - 1].push(trimLine(ln));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && startNum !== 1 ? `<ol start="${startNum}">` : `<${tag}>`;
      let lis = '';
      for (let k = 0; k < items.length; k++) lis += `<li>${inline(items[k].join('\n'), env)}</li>\n`;
      blocks.push(`${open}\n${lis}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF = /^if (not )?(\S+)$/;
const INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/**
 * Whether rendering `nodes` depends only on the loop variable(s) in `allowed`
 * (plus the innermost `loop`, when `loopOk`): every var/if path's first segment
 * is allowed, every nested for's iterable is allowed, and every include's
 * template is likewise pure. Include cycles are impure (conservative). A pure
 * for-body renders the same fragment for the same item wherever it is rendered,
 * so it can be memoised per item.
 */
function refsPure(nodes, allowed, loopOk, templates, stack) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        break;
      case 'var':
      case 'raw':
        if (!allowed.has(n.path[0]) && !(loopOk && n.path[0] === 'loop')) return false;
        break;
      case 'if':
        if (!allowed.has(n.path[0]) && !(loopOk && n.path[0] === 'loop')) return false;
        if (!refsPure(n.then, allowed, loopOk, templates, stack)) return false;
        if (n.else !== null && !refsPure(n.else, allowed, loopOk, templates, stack)) return false;
        break;
      case 'for': {
        if (!allowed.has(n.path[0])) return false;
        const inner = new Set(allowed);
        inner.add(n.name);
        if (!refsPure(n.body, inner, true, templates, stack)) return false;
        break;
      }
      case 'include': {
        const t = templates.get(n.name);
        if (t === undefined) break;
        if (stack.has(n.name)) return false;
        stack.add(n.name);
        const ok = refsPure(t, allowed, loopOk, templates, stack);
        stack.delete(n.name);
        if (!ok) return false;
        break;
      }
    }
  }
  return true;
}

/** Mark every for-node in every template with `pure` (see refsPure). */
function markForPure(templates) {
  const walk = (nodes) => {
    for (const n of nodes) {
      if (n.kind === 'for') {
        n.pure = refsPure(n.body, new Set([n.name]), false, templates, new Set());
        walk(n.body);
      } else if (n.kind === 'if') {
        walk(n.then);
        if (n.else !== null) walk(n.else);
      }
    }
  };
  for (const nodes of templates.values()) walk(nodes);
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
const hasOwn = Object.hasOwn;
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * `nodes` rendered into `out` (joined once by the caller, not concatenated per
 * node). `scope` is { vars, parent }; `ctx` holds the parsed templates, the HTML
 * escape and the include depth.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let ni = 0; ni < nodes.length; ni++) {
    const n = nodes[ni];
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var': {
        const v = lookup(scope, n.path);
        out.push(ctx.escape(typeof v === 'string' ? v : textOf(v)));
        break;
      }
      case 'raw': {
        const v = lookup(scope, n.path);
        out.push(typeof v === 'string' ? v : textOf(v));
        break;
      }
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        // One scope object per loop, mutated per item: rendering is synchronous,
        // so nothing can observe the previous item's bindings. `loop` still wins
        // over the element when the loop variable is itself named `loop`, so the
        // per-item overwrite of vars.loop only runs in that case.
        const loop = { index: 0, first: false, last: false, length: xs.length };
        const vars = { loop };
        const child = { vars, parent: scope };
        const namedLoop = n.name === 'loop';
        if (n.pure === true) {
          // Fragment memoisation: a pure body depends only on the item (and the
          // include depth, which caps includes), so the same item renders the
          // same fragment wherever the loop runs — the card include on the index
          // page and on every tag page, for instance.
          let perNode = ctx.fragCache.get(n);
          if (perNode === undefined) { perNode = new Map(); ctx.fragCache.set(n, perNode); }
          for (let k = 0; k < xs.length; k++) {
            const item = xs[k];
            let arr = perNode.get(item);
            let frag = arr === undefined ? undefined : arr[depth];
            if (frag === undefined) {
              vars[n.name] = item;
              if (namedLoop) vars.loop = loop;
              loop.index = k + 1;
              loop.first = k === 0;
              loop.last = k === xs.length - 1;
              const tmp = [];
              renderNodes(n.body, child, ctx, depth, tmp);
              frag = tmp.join('');
              if (arr === undefined) { arr = []; perNode.set(item, arr); }
              arr[depth] = frag;
            }
            out.push(frag);
          }
        } else {
          for (let k = 0; k < xs.length; k++) {
            vars[n.name] = xs[k];
            if (namedLoop) vars.loop = loop;
            loop.index = k + 1;
            loop.first = k === 0;
            loop.last = k === xs.length - 1;
            renderNodes(n.body, child, ctx, depth, out);
          }
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

/** The report file every build writes. */
const REPORT_FILE = 'build-report.txt';

/** The top-level directories the generator writes itself. */
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** 1. The sources, in code-unit order of their paths; a source that is not .md is static. */
function readSources(b) {
  const files = [...b.input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) b.sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n'), card: null });
    else b.statics.push({ path: f.path, content: f.content });
  }
}

/** 2. Each source's front matter: a refused source is reported and dropped, and so is a draft. */
function frontMatter(b) {
  const kept = [];
  for (const s of b.sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      b.report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    let own;
    for (const d of RESERVED) {
      if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
    }
    if (own !== undefined) {
      b.report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      b.report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!b.templates.has(layout)) {
      b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      b.report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }
  b.sources = kept;
}

/** 3. Each page's output directory and url: its slug made unique in its directory, in source order. */
function permalinks(b) {
  const taken = new Map();
  const takenIn = (dir) => {
    if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
    return taken.get(dir);
  };
  for (const s of b.sources) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${b.base}/${s.outDir}/`;
    b.bySource.set(s.path, s);
  }
}

/** 4. Each body's Markdown, its links resolved to the pages and static files they name. */
function markdown(b) {
  const staticPaths = new Set(b.statics.map((f) => f.path));
  for (const s of b.sources) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (isAbsoluteUri(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && b.bySource.has(path)) return `${b.bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${b.base}/${path}${frag}`;
        b.broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }
}

/** 5. The posts, newest first and then by slug; each post's newer and older neighbours. */
function collections(b) {
  const posts = b.sources.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  b.posts = posts;
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });
}

/** 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug. */
function tags(b) {
  const bySlug = new Map();
  /** A source's tags, each slug once, in its own order. */
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of (s.data.tags ?? [])) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of b.posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${b.base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  // A page's tags link to the posts' tag of the same slug, and to nothing (url "") where no post has it.
  for (const s of b.sources) {
    if (s.post) continue;
    s.tagRefs = ownTags(s).map((name) => {
      const slug = slugify(name);
      return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
    });
  }
  b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A tag as templates read it (its posts as cards). */
const tagOf = (b, t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) });

/** A post's card, as lists show it (built once per source, reused by its page). */
function cardOf(s) {
  if (s.card !== null) return s.card;
  const card = {
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  };
  s.card = card;
  return card;
}

/** A page as its layout reads it. Built field by field (no spread of the card, and the toc array is shared: templates only read it, never write it, so the copy the reference builds is unobservable). */
function pageOf(s) {
  const card = cardOf(s);
  return {
    title: card.title,
    url: card.url,
    date: card.date,
    date_long: card.date_long,
    summary: card.summary,
    excerpt: card.excerpt,
    reading_minutes: card.reading_minutes,
    tags: card.tags,
    slug: s.slug,
    content: s.html,
    toc: s.toc,
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** 7. Every page through its layout, the index pages and the tag pages through theirs. */
function layouts(b) {
  b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
  const site = { title: b.input.site.title, base_url: b.base };
  const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = b.posts.slice(0, b.input.site.recent).map((p) => b.cards.get(p));
  // One shared base scope: every render's own vars hang under it instead of
  // being spread into a fresh object per render (render vars are page, posts,
  // pager and tag, never site, tags or recent, so nothing is shadowed).
  const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
  const ctx = { templates: b.templates, escape: escapeCached, fragCache: new Map() };
  const render = (name, vars) => {
    const nodes = b.templates.get(name);
    if (nodes === undefined) return null;
    const out = [];
    renderNodes(nodes, { vars, parent: baseScope }, ctx, 0, out);
    return out.join('');
  };
  for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = b.input.site.per_page;
  const pages = Math.max(1, Math.ceil(b.posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${b.base}/` : `${b.base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of b.tags) {
    const html = render('tag', { tag: tagOf(b, t) });
    if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
  for (const f of b.statics) {
    if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
    else b.output[f.path] = f.content;
  }
}

/** 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts. */
function report(b) {
  const lines = [...b.report, ...b.broken].sort(byCodeUnits);
  const pages = b.sources.filter((s) => !s.post).length;
  lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
  b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
}

/** The plugins, in the order a build runs them. */
const PIPELINE = Object.freeze([readSources, frontMatter, permalinks, markdown, collections, tags, layouts, report]);

/** One site's output tree: path -> text. */
function build(input) {
  const templates = new Map();
  const reportLines = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      reportLines.push(err.message);
    }
  }
  markForPure(templates);
  const b = {
    input,
    base: input.site.base_url.replace(/\/+$/, ''),
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report: reportLines,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };
  for (const plugin of PIPELINE) plugin(b);
  return b.output;
}

/** makefun-site 1.0.0's answer for one case's input. */
export function run(input) {
  slugCache = new Map();
  escCache = new Map();
  return build(input);
}
