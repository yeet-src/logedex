// Tests for log search. Run with: cd server && npm test
//
// This runs in three runtimes against real production logs, and a wrong answer here
// hides lines rather than showing an error — the worst kind of bug in a log viewer,
// because "no matches" looks identical to "nothing happened".

import { test } from "node:test";
import assert from "node:assert/strict";
import { buildQuery, matchRanges, matches, parseQuery } from "./search.js";

const q = (s) => parseQuery(s);
const hit = (line, query) => matches(line, q(query));

test("a single term is a case-insensitive substring", () => {
  assert.ok(hit("upstream connect ERROR", "error"));
  assert.ok(hit("upstream connect error", "ERROR"));
  assert.ok(hit("Errors happened", "error"));
  assert.ok(!hit("all good", "error"));
});

test("several terms are AND, not OR", () => {
  // Narrowing is the point: hunting one request in a busy log.
  assert.ok(hit("req-8f3a GET /pay 500 error", "req-8f3a error"));
  assert.ok(!hit("req-8f3a GET /pay 200 ok", "req-8f3a error"));
  assert.ok(!hit("req-0000 error", "req-8f3a error"));
});

test("order of terms doesn't matter", () => {
  assert.ok(hit("error on req-8f3a", "req-8f3a error"));
  assert.ok(hit("error on req-8f3a", "error req-8f3a"));
});

test("a quoted phrase keeps its spaces", () => {
  assert.ok(hit("upstream: connection refused by peer", '"connection refused"'));
  // Without quotes those are two independent terms, so a line with both words
  // anywhere matches — which is why the quotes have to be honoured.
  assert.ok(!hit("connection was politely refused", '"connection refused"'));
  assert.ok(hit("connection was politely refused", "connection refused"));
});

test("a leading dash excludes", () => {
  assert.ok(hit("GET /pay 500 error", "error -health"));
  assert.ok(!hit("GET /health 500 error", "error -health"));
  // Exclusion alone is a valid query: everything except the noise.
  assert.ok(hit("GET /pay 200", "-health"));
  assert.ok(!hit("GET /health 200", "-health"));
});

test("an empty or blank query matches everything", () => {
  // "no search" and "search for nothing" must behave the same, or clearing the box
  // could leave a pane mysteriously empty.
  assert.ok(hit("anything at all", ""));
  assert.ok(hit("anything at all", "   "));
  assert.ok(q("").empty);
  assert.ok(q("   ").empty);
});

test("degenerate input contributes no term rather than matching nothing", () => {
  assert.ok(q("-").empty, "a lone dash isn't an exclusion of nothing");
  assert.ok(q('""').empty, "an empty phrase isn't a term");
  assert.ok(hit("anything", "-"));
  assert.ok(hit("anything", '""'));
});

test("an unclosed quote still parses to the end", () => {
  // People type as they think; a dangling quote shouldn't drop the query.
  const parsed = q('"connection refused');
  assert.deepEqual(parsed.terms, [{ text: "connection refused", negate: false }]);
  assert.ok(hit("got connection refused here", '"connection refused'));
});

test("a dash inside a word is part of the term, not an exclusion", () => {
  // Request ids and container names are full of dashes.
  assert.deepEqual(q("req-8f3a").terms, [{ text: "req-8f3a", negate: false }]);
  assert.ok(hit("handling req-8f3a now", "req-8f3a"));
});

// ── highlighting ────────────────────────────────────────────────────────────
test("matchRanges points at the original text, preserving case", () => {
  const line = "Upstream ERROR on req-8f3a";
  const ranges = matchRanges(line, q("error"));
  assert.equal(ranges.length, 1);
  assert.equal(line.slice(ranges[0].start, ranges[0].end), "ERROR");
});

test("matchRanges finds every occurrence", () => {
  const line = "retry retry retry";
  assert.equal(matchRanges(line, q("retry")).length, 3);
});

test("overlapping terms merge into one span", () => {
  // Crossing ranges would corrupt a highlighter that slices sequentially.
  const line = "an error occurred";
  const ranges = matchRanges(line, q("err error"));
  assert.equal(ranges.length, 1);
  assert.equal(line.slice(ranges[0].start, ranges[0].end), "error");
});

test("matchRanges returns ranges in order and never crossing", () => {
  const line = "alpha beta alpha gamma beta";
  const ranges = matchRanges(line, q("alpha beta"));
  for (let i = 1; i < ranges.length; i++) {
    assert.ok(ranges[i].start >= ranges[i - 1].end, "ranges must not overlap");
  }
});

test("excluded terms are never highlighted", () => {
  assert.deepEqual(matchRanges("error on /pay", q("error -health")).length, 1);
  assert.deepEqual(matchRanges("error on /pay", q("-error")), []);
});

test("an empty query highlights nothing", () => {
  assert.deepEqual(matchRanges("anything", q("")), []);
});


// ── the two boxes ───────────────────────────────────────────────────────────
/* The exclude box is a list of things you don't want to see, so its terms are OR:
 * a line matching any of them goes. That falls out of negating each and AND-ing. */
test("the exclude box hides a line matching any of its terms", () => {
  const q = buildQuery("", "/health /metrics");
  assert.equal(matches("GET /api/orders 200", q), true);
  assert.equal(matches("GET /health 200", q), false);
  assert.equal(matches("GET /metrics 200", q), false);
});

test("the two boxes narrow together", () => {
  const q = buildQuery("GET", "/health");
  assert.equal(matches("GET /api/orders 200", q), true);
  assert.equal(matches("GET /health 200", q), false, "excluded even though it matches the filter");
  assert.equal(matches("POST /api/orders 200", q), false, "does not match the filter");
});

/* Typed out of habit by anyone used to the old syntax. It must not become a double
 * negative that re-admits exactly what the box exists to hide. */
test("a leading dash in the exclude box still excludes", () => {
  const q = buildQuery("", "-/health");
  assert.equal(matches("GET /health 200", q), false);
  assert.equal(matches("GET /api/orders 200", q), true);
});

test("either box alone works, and neither means no filtering", () => {
  assert.equal(buildQuery("", "").empty, true);
  assert.equal(matches("anything at all", buildQuery("", "")), true);
  assert.equal(matches("GET /health", buildQuery("health", "")), true);
  assert.equal(matches("GET /orders", buildQuery("", "health")), true);
});

/* Highlighting marks what you searched FOR. A matching line by definition contains
 * none of the exclusions, so there would be nothing to mark even if it tried. */
test("only the filter box highlights", () => {
  const q = buildQuery("orders", "health");
  assert.deepEqual(matchRanges("GET /api/orders 200", q), [{ start: 9, end: 15 }]);
});

test("a quoted phrase survives either box", () => {
  const q = buildQuery("", '"connection refused"');
  assert.equal(matches("upstream: connection refused", q), false);
  assert.equal(matches("upstream: connection reset", q), true);
});
