// Log search: parsing a query, and testing a line against it.
//
// Shared by all three runtimes deliberately, because a query has to mean the same
// thing everywhere or the UI lies about its own results:
//
//   agent/logstream.js  (yeet isolate)  filters at the source, so only matching
//                                       lines ever cross the network
//   server/index.js     (node)          validates what it forwards
//   server/public/      (browser)       highlights matches inside a line
//
// It's plain string work with no dependencies, no Intl and no regex, so the same
// file runs unchanged in the isolate, which has no npm and a bare-bones global set.
//
// WHY NO REGEX. It's the obvious feature and it's deliberately absent. A pattern
// typed in a browser would be compiled and run inside the yeet isolate, once per
// log line, on someone's production host — and a catastrophically backtracking
// pattern there doesn't just fail, it can wedge the daemon for every script on that
// box. Substring terms cost the same on every input, so the worst a query can do is
// match nothing. The term syntax below covers what regex was wanted for anyway.

/**
 * Parse a query string into terms.
 *
 *   error                     lines containing "error"
 *   req-8f3a error            lines containing BOTH (AND, not OR — narrowing is
 *                             what you want when hunting one request)
 *   "connection refused"      a quoted phrase, spaces included
 *   error -health             contains "error", does NOT contain "health"
 *
 * Matching is case-insensitive: log levels are written `ERROR`, `Error` and
 * `error` by different services in the same fleet, and requiring the right one is
 * a trap with no upside.
 *
 * @param {string} input
 * @returns {{terms: Array<{text:string, negate:boolean}>, empty: boolean}}
 */
export function parseQuery(input) {
  const terms = [];
  const src = String(input ?? "");
  let i = 0;

  while (i < src.length) {
    // Skip whitespace between terms.
    if (/\s/.test(src[i])) { i++; continue; }

    let negate = false;
    if (src[i] === "-") {
      const next = src[i + 1];
      if (next === undefined || /\s/.test(next)) {
        // A dash with nothing attached: skip it entirely rather than searching for
        // a literal hyphen. This is the halfway state of typing `-health`, and
        // treating it literally would narrow the results to lines containing a
        // dash — nearly all of them, but not all, so it silently drops lines for a
        // reason the operator never asked for. `"-"` still searches for one.
        i++;
        continue;
      }
      negate = true;
      i++;
    }

    let text = "";
    if (src[i] === '"') {
      i++;                                  // opening quote
      while (i < src.length && src[i] !== '"') text += src[i++];
      if (i < src.length) i++;              // closing quote, if they typed one
    } else {
      while (i < src.length && !/\s/.test(src[i])) text += src[i++];
    }

    // A lone `-` or an empty `""` contributes nothing rather than matching all.
    if (text) terms.push({ text: text.toLowerCase(), negate });
  }

  return { terms, empty: terms.length === 0 };
}

/**
 * Combine what to keep and what to drop into one query.
 *
 * Two boxes rather than one box with a `-` convention, because excluding noise is a
 * distinct thing you do — `/health` drowning out everything else is the common case,
 * and it should not require knowing a syntax to fix. Everything in `exclude` is
 * negated no matter how it was written, so a stray `-` typed out of habit doesn't
 * turn into a double negative that quietly re-admits what you were hiding.
 *
 * The terms within `exclude` are OR, not AND, which falls out of negating each and
 * AND-ing the result: `not health AND not debug` hides a line matching either. That's
 * what a list of things you don't want to see should mean.
 *
 * @param {string} include  terms a line must contain
 * @param {string} exclude  terms that disqualify a line
 */
export function buildQuery(include, exclude) {
  const terms = [
    ...parseQuery(include).terms,
    ...parseQuery(exclude).terms.map((t) => ({ text: t.text, negate: true })),
  ];
  return { terms, empty: terms.length === 0 };
}

/**
 * Does this line satisfy the query? An empty query matches everything, so "no
 * search" and "search for nothing" are the same thing and neither hides lines.
 *
 * @param {string} line
 * @param {{terms:Array<{text:string,negate:boolean}>, empty:boolean}} query
 */
export function matches(line, query) {
  if (!query || query.empty) return true;
  const hay = String(line ?? "").toLowerCase();
  for (const t of query.terms) {
    const hit = hay.includes(t.text);
    if (t.negate ? hit : !hit) return false;
  }
  return true;
}

/**
 * Where the positive terms occur in a line, as non-overlapping ranges sorted by
 * position — for highlighting. Excluded terms are not marked: by definition a
 * matching line doesn't contain them.
 *
 * Returns offsets into the ORIGINAL line (not the lowercased copy), so a caller
 * can slice the real text and keep its casing.
 *
 * @param {string} line
 * @param {{terms:Array<{text:string,negate:boolean}>, empty:boolean}} query
 * @returns {Array<{start:number, end:number}>}
 */
export function matchRanges(line, query) {
  if (!query || query.empty) return [];
  const hay = String(line ?? "").toLowerCase();
  const spans = [];
  for (const t of query.terms) {
    if (t.negate || !t.text) continue;
    let from = 0;
    for (;;) {
      const at = hay.indexOf(t.text, from);
      if (at < 0) break;
      spans.push({ start: at, end: at + t.text.length });
      from = at + t.text.length;            // don't re-find inside this hit
    }
  }
  if (spans.length < 2) return spans;

  // Two terms can overlap ("err" and "error"), and a highlighter must not be
  // handed crossing ranges — merge them into one span each.
  spans.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [spans[0]];
  for (const s of spans.slice(1)) {
    const last = merged[merged.length - 1];
    if (s.start <= last.end) last.end = Math.max(last.end, s.end);
    else merged.push(s);
  }
  return merged;
}

