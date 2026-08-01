// Tests for the interleaving order. Run with: cd server && npm test
//
// This is the only logic in the dashboard worth testing on its own: everything else
// there is DOM wiring, but getting timestamp order wrong would silently present two
// hosts' logs in a plausible, false sequence — which is worse than an obvious bug.

import { test } from "node:test";
import assert from "node:assert/strict";

/** Run a body with a fixed timezone, so "renders in the viewer's zone" is a real
 *  assertion rather than one that only holds on the machine that wrote it. Node
 *  re-reads process.env.TZ per Date construction, which makes this possible. */
function inZone(tz, fn) {
  const prev = process.env.TZ;
  process.env.TZ = tz;
  try { fn(); } finally { process.env.TZ = prev; }
}
import { KEY_MAX, blockCross, clockSpread, compareLines, localTime, memberLabels, mergeCandidates, mergeWatermark, orderBatch, posToTime, pushWithin, splitAtWatermark, timeToPos, tsKey } from "./order.js";

// ── scrubber mapping ────────────────────────────────────────────────────────
test("scrubber edges map to the ends of the span", () => {
  const span = { from: 1000, to: 2000 };
  assert.equal(posToTime(0, span), 1000);
  assert.equal(posToTime(1000, span), 2000);
  assert.equal(timeToPos(1000, span), 0);
  assert.equal(timeToPos(2000, span), 1000);
});

test("scrubber midpoint is the middle of the span", () => {
  assert.equal(posToTime(500, { from: 0, to: 3600 }), 1800);
  assert.equal(timeToPos(1800, { from: 0, to: 3600 }), 500);
});

test("a position round-trips back to itself", () => {
  // Six days over 1000 steps: the coarsest realistic case.
  const span = { from: 1784850365, to: 1785391061 };
  for (const p of [0, 1, 37, 250, 499, 500, 750, 999, 1000]) {
    assert.equal(timeToPos(posToTime(p, span), span), p, `position ${p} should survive a round trip`);
  }
});

test("times outside the span clamp to its edges", () => {
  // A pane whose history starts later than the span's left edge must not push a
  // handle off the track.
  const span = { from: 1000, to: 2000 };
  assert.equal(timeToPos(500, span), 0);
  assert.equal(timeToPos(5000, span), 1000);
  assert.equal(posToTime(-50, span), 1000, "a negative position clamps to the start");
  assert.equal(posToTime(9999, span), 2000, "an over-range position clamps to the end");
});

test("a zero-width span doesn't divide by zero", () => {
  // Two containers that both started this second, or a single line of history.
  const span = { from: 1785391061, to: 1785391061 };
  assert.equal(posToTime(0, span), 1785391061);
  assert.ok(Number.isFinite(posToTime(1000, span)));
  assert.equal(timeToPos(1785391061, span), 0);
});

// ── the width limit ─────────────────────────────────────────────────────────
test("handles inside the limit are left where they are", () => {
  assert.equal(pushWithin(400, 450, 100), 450);
  assert.equal(pushWithin(400, 500, 100), 500, "exactly at the limit still counts as inside");
  assert.equal(pushWithin(400, 300, 100), 300);
});

test("no limit means no push", () => {
  for (const none of [0, -1, undefined]) assert.equal(pushWithin(0, 1000, none), 1000);
});

/* The point of pushing rather than blocking: a bounded window has to be able to
 * travel to the far end of the track, in one gesture, from either handle. */
test("dragging into the limit takes the other handle along", () => {
  assert.equal(pushWithin(200, 900, 100), 300, "left handle pushes the right one left");
  assert.equal(pushWithin(900, 200, 100), 800, "right handle pushes the left one right");
});

test("the pushed handle keeps its side, so the window can't invert", () => {
  for (const [at, other] of [[0, 1000], [1000, 0], [500, 900], [500, 100]]) {
    const moved = pushWithin(at, other, 100);
    assert.equal(Math.sign(moved - at), Math.sign(other - at), `${at}/${other} flipped sides`);
  }
});

test("a push stops at the ends of the track", () => {
  assert.equal(pushWithin(1000, 0, 100), 900);
  assert.equal(pushWithin(0, 1000, 100), 100);
  // A limit wider than the track can't shove a handle off the end.
  assert.equal(pushWithin(0, 1000, 100, 50), 50);
});

// ── the handles can't cross ─────────────────────────────────────────────────
test("a handle that isn't crossing is left where it is", () => {
  assert.equal(blockCross(300, 700, "a"), 300);
  assert.equal(blockCross(700, 300, "b"), 700);
});

test("the start handle stops before the end handle", () => {
  assert.equal(blockCross(900, 400, "a"), 399, "dragged past, so it stops a step short");
  assert.equal(blockCross(400, 400, "a"), 399, "landing exactly on it still leaves a gap");
});

test("the end handle stops after the start handle", () => {
  assert.equal(blockCross(100, 600, "b"), 601);
  assert.equal(blockCross(600, 600, "b"), 601);
});

/* The gap is what keeps a committed window from being `since === until` — a selection
 * describing no time at all, which would come back empty and look like a broken filter. */
test("blocking leaves the requested gap wherever the track has room for it", () => {
  for (const which of ["a", "b"]) {
    for (const [at, other] of [[0, 1000], [1000, 0], [500, 500], [501, 500], [499, 500]]) {
      const moved = blockCross(at, other, which, 1);
      assert.ok(moved >= 0 && moved <= 1000, `${which} ${at}/${other} left the track`);
      // The one case with nowhere to put the gap: the other handle is on the very end the
      // dragged one would need a step past. Then it may sit on top of it — see the next
      // test — but it still must not go through it.
      const pinned = which === "a" ? other === 0 : other === 1000;
      if (pinned) {
        assert.equal(moved, other, `${which} ${at}/${other} should stop at the pinned handle`);
      } else {
        assert.ok(which === "a" ? moved < other : moved > other, `${which} ${at}/${other} crossed`);
      }
    }
  }
});

test("blocking stays on the track", () => {
  // The degenerate pair: the other handle is already at an end, so the gap can't fit
  // inside the track. Staying in range wins over keeping the gap — an out-of-range
  // value would leave the native input's own clamp to decide, which paints a handle
  // where no position maps.
  assert.equal(blockCross(500, 0, "a"), 0);
  assert.equal(blockCross(500, 1000, "b"), 1000);
});

test("an unknown span yields null rather than NaN", () => {
  assert.equal(posToTime(500, null), null);
  assert.equal(posToTime(500, { from: NaN, to: 10 }), null);
  assert.equal(timeToPos(500, null), 0);
});

// ── timestamp display ───────────────────────────────────────────────────────
const UTC_STAMP = "2026-07-30T04:50:30.574159802Z";

test("renders a UTC stamp in the viewer's own timezone", () => {
  // The bug this guards: slicing the raw string shows UTC, while the range picker
  // reads local — so a filtered window looks wrong by exactly the zone offset.
  inZone("UTC", () => assert.equal(localTime(UTC_STAMP), "04:50:30.574"));
  inZone("America/Los_Angeles", () => assert.equal(localTime(UTC_STAMP), "21:50:30.574"));
  inZone("Asia/Tokyo", () => assert.equal(localTime(UTC_STAMP), "13:50:30.574"));
  inZone("Asia/Kolkata", () => assert.equal(localTime(UTC_STAMP), "10:20:30.574"));  // :30 offset
});

test("localTime pads every field", () => {
  inZone("UTC", () => {
    assert.equal(localTime("2026-01-02T03:04:05.006Z"), "03:04:05.006");
    assert.equal(localTime("2026-01-02T03:04:05Z"), "03:04:05.000");
  });
});

test("localTime degrades to empty rather than NaN", () => {
  assert.equal(localTime(null), "");
  assert.equal(localTime(""), "");
  assert.equal(localTime("not a timestamp"), "");
});

test("display truncates to ms but the sort key keeps nanoseconds", () => {
  // Two lines 200ns apart read identically on screen yet must not compare equal —
  // that's the division of labour between localTime and tsKey.
  const a = "2026-07-30T04:50:30.000000100Z";
  const b = "2026-07-30T04:50:30.000000300Z";
  inZone("UTC", () => assert.equal(localTime(a), localTime(b)));
  assert.notEqual(tsKey(a), tsKey(b));
  assert.ok(tsKey(a) < tsKey(b));
});

// ── merge candidates ────────────────────────────────────────────────────────
const S = (hostLabel, container, image) => ({ hostId: hostLabel, hostLabel, container, image });

test("pre-selects the same service on other hosts", () => {
  const origin = S("web-01", "api", "registry/api:1.4");
  const out = mergeCandidates(origin, [
    S("web-02", "api", "registry/api:1.4"),
    S("web-03", "api", "registry/api:1.4"),
    S("web-02", "cache", "redis:7"),
  ]);
  const picked = out.filter((x) => x.preselect).map((x) => `${x.stream.hostLabel}/${x.stream.container}`);
  assert.deepEqual(picked, ["web-02/api", "web-03/api"]);
});

test("a shared base image does not drag in every container", () => {
  // The over-selection this guards: everything built FROM alpine ticking itself on
  // just because the base image matches.
  const origin = S("web-01", "worker", "alpine");
  const out = mergeCandidates(origin, [
    S("web-02", "worker", "alpine"),   // the real counterpart
    S("web-02", "cron", "alpine"),     // same base image, unrelated service
    S("web-01", "cron", "alpine"),
  ]);
  const picked = out.filter((x) => x.preselect).map((x) => `${x.stream.hostLabel}/${x.stream.container}`);
  assert.deepEqual(picked, ["web-02/worker"]);
});

test("falls back to image alone when no name also matches", () => {
  // Same image deployed under different names — still the same service.
  const origin = S("web-01", "api-blue", "registry/api:1.4");
  const out = mergeCandidates(origin, [
    S("web-02", "api-green", "registry/api:1.4"),
    S("web-02", "cache", "redis:7"),
  ]);
  const picked = out.filter((x) => x.preselect).map((x) => x.stream.container);
  assert.deepEqual(picked, ["api-green"]);
});

test("same name but a different image is offered, ranked, not pre-selected", () => {
  const origin = S("web-01", "nginx", "nginx:1.27");
  const out = mergeCandidates(origin, [
    S("web-02", "nginx", "nginx:1.21"),   // same name, different build
    S("web-02", "redis", "redis:7"),
  ]);
  assert.equal(out[0].stream.container, "nginx", "the same name should rank first");
  assert.equal(out[0].preselect, false, "a different image shouldn't be assumed");
  assert.equal(out[0].why, "same name");
  assert.deepEqual(out.filter((x) => x.preselect), []);
});

test("a missing image never counts as a match", () => {
  const origin = S("web-01", "api", undefined);
  const out = mergeCandidates(origin, [S("web-02", "api", undefined)]);
  assert.equal(out[0].preselect, false);
  assert.equal(out[0].why, "same name");
});


test("tsKey pads the fraction so string order is time order", () => {
  // The bug this guards: comparing raw stamps of different fractional widths.
  // "…:02.9Z" > "…:02.10Z" as strings, but 0.9s is AFTER 0.10s.
  const a = tsKey("2026-07-30T04:08:02.9Z");
  const b = tsKey("2026-07-30T04:08:02.10Z");
  assert.ok(a > b, `${a} should sort after ${b}`);
  assert.equal(a, "2026-07-30T04:08:02.900000000");
  assert.equal(b, "2026-07-30T04:08:02.100000000");
});

test("tsKey keeps nanosecond resolution", () => {
  // Date.parse would collapse these two into the same millisecond.
  const a = tsKey("2026-07-30T04:08:02.000000100Z");
  const b = tsKey("2026-07-30T04:08:02.000000300Z");
  assert.notEqual(a, b);
  assert.ok(a < b);
});

test("tsKey handles a stamp with no fraction, and rejects junk", () => {
  assert.equal(tsKey("2026-07-30T04:08:02Z"), "2026-07-30T04:08:02.000000000");
  assert.equal(tsKey("2026-07-30T04:08:02"), "2026-07-30T04:08:02.000000000");
  assert.equal(tsKey(null), null);
  assert.equal(tsKey(""), null);
  assert.equal(tsKey("not a timestamp"), null);
});

test("interleaves two hosts by timestamp, not by arrival", () => {
  // The shape that matters: host B's lines reach us late (higher arrival numbers)
  // but belong between host A's. Sorting by arrival would clump them.
  const batch = [
    { key: tsKey("2026-07-30T04:08:01.000Z"), arrival: 0, who: "a1" },
    { key: tsKey("2026-07-30T04:08:03.000Z"), arrival: 1, who: "a2" },
    { key: tsKey("2026-07-30T04:08:05.000Z"), arrival: 2, who: "a3" },
    { key: tsKey("2026-07-30T04:08:02.000Z"), arrival: 3, who: "b1" },
    { key: tsKey("2026-07-30T04:08:04.000Z"), arrival: 4, who: "b2" },
  ];
  assert.deepEqual(orderBatch(batch).map((x) => x.who), ["a1", "b1", "a2", "b2", "a3"]);
});

test("identical timestamps keep arrival order, stably", () => {
  const same = tsKey("2026-07-30T04:08:02.000Z");
  const batch = [
    { key: same, arrival: 5, who: "fifth" },
    { key: same, arrival: 1, who: "first" },
    { key: same, arrival: 3, who: "third" },
  ];
  assert.deepEqual(orderBatch(batch).map((x) => x.who), ["first", "third", "fifth"]);
});

test("compareLines is a consistent ordering", () => {
  const x = { key: "a", arrival: 1 };
  const y = { key: "b", arrival: 0 };
  assert.ok(compareLines(x, y) < 0);
  assert.ok(compareLines(y, x) > 0);
  assert.equal(compareLines(x, x), 0);
});

test("clockSpread reports host disagreement, not our own offset", () => {
  // Both hosts 30s 'behind' us in the same way: our clock, not theirs. No spread.
  assert.equal(clockSpread([30_000, 30_000]), 0);
  // One host 3s off the other: that's what breaks interleaving.
  assert.equal(clockSpread([200, 3200]), 3000);
  // Nothing to compare yet.
  assert.equal(clockSpread([500]), null);
  assert.equal(clockSpread([null, 500]), null);
  assert.equal(clockSpread([]), null);
});

// ── the progressive merge ───────────────────────────────────────────────────
// The watermark is what lets an interleaved pane show lines while its slowest member
// is still sending, instead of after. Getting it wrong is not a visible bug: it
// releases a line early, a slightly older one arrives next, and the pane reads as a
// plausible-but-false sequence — the same failure this whole module exists to avoid.

const K = (s) => tsKey(`2026-07-30T04:08:${s}Z`);
const line = (s, arrival) => ({ key: K(s), arrival, who: `${s}@${arrival}` });

test("the watermark is the least-caught-up member", () => {
  // A raced ahead; B is the one holding the merge back, so B's position is the line
  // below which order is settled.
  assert.equal(mergeWatermark([{ lastKey: K("09.000") }, { lastKey: K("03.000") }]), K("03.000"));
});

test("a member that has said nothing blocks every release", () => {
  // Its first line could be older than everything buffered, so nothing is safe yet.
  assert.equal(mergeWatermark([{ lastKey: K("09.000") }, { lastKey: null }]), null);
});

test("finished and abandoned members stop holding the merge back", () => {
  const done = { lastKey: null, done: true };
  const quiet = { lastKey: null, stalled: true };
  assert.equal(mergeWatermark([{ lastKey: K("05.000") }, done]), K("05.000"));
  assert.equal(mergeWatermark([{ lastKey: K("05.000") }, quiet]), K("05.000"));
  // Nobody left to wait for: everything buffered can go out.
  assert.equal(mergeWatermark([done, quiet]), KEY_MAX);
  assert.ok(K("99.999999999") < KEY_MAX, "the sentinel must outrank any real key");
});

test("the split releases what is settled and holds the rest in order", () => {
  const pending = [line("05.000", 2), line("01.000", 0), line("07.000", 3), line("03.000", 1)];
  const { ready, held } = splitAtWatermark(pending, K("03.000"));
  assert.deepEqual(ready.map((x) => x.who), ["01.000@0", "03.000@1"]);
  assert.deepEqual(held.map((x) => x.who), ["05.000@2", "07.000@3"], "the remainder stays sorted");
});

test("a null watermark holds everything", () => {
  const pending = [line("01.000", 0)];
  const { ready, held } = splitAtWatermark(pending, null);
  assert.equal(ready.length, 0);
  assert.equal(held.length, 1);
});

test("lines exactly at the watermark are released", () => {
  // Otherwise two members sitting on the same coarse stamp deadlock each other.
  const { ready } = splitAtWatermark([line("03.000", 0)], K("03.000"));
  assert.equal(ready.length, 1);
});

test("a progressive merge produces the same order as sorting at the end", () => {
  /* The property that matters, exercised as a whole run: two members deliver
   * interleaved lines in bursts, the watermark releases what it can after each
   * burst, and the concatenation of everything released must equal the sort of all
   * the lines together. If it doesn't, the pane showed a line too early. */
  const bursts = [
    { a: ["01.000", "02.000"], b: [] },
    { a: [], b: ["01.500", "02.500"] },
    { a: ["04.000"], b: ["03.000"] },
    { a: ["06.000"], b: ["05.000", "07.000"] },
  ];
  const state = { a: { lastKey: null }, b: { lastKey: null } };
  let pending = [];
  let arrival = 0;
  const emitted = [];
  const all = [];

  for (const burst of bursts) {
    for (const who of ["a", "b"]) {
      for (const s of burst[who]) {
        const item = { key: K(s), arrival: arrival++, who: s };
        state[who].lastKey = item.key;
        pending.push(item);
        all.push(item);
      }
    }
    const { ready, held } = splitAtWatermark(pending, mergeWatermark([state.a, state.b]));
    pending = held;
    emitted.push(...ready);
  }
  // Both finish: the tail is released.
  const { ready } = splitAtWatermark(pending, mergeWatermark([{ done: true }, { done: true }]));
  emitted.push(...ready);

  assert.deepEqual(emitted.map((x) => x.who), orderBatch(all).map((x) => x.who));
  assert.ok(emitted.length === all.length, "every line came out exactly once");
});

// ── what a combined pane calls its members ──────────────────────────────────
const M = (hostLabel, container) => ({ hostLabel, hostId: hostLabel, container });

test("one service across hosts is labelled by host", () => {
  assert.deepEqual(
    memberLabels([M("web-01", "api"), M("web-02", "api"), M("web-03", "api")]),
    ["web-01", "web-02", "web-03"],
  );
});

/* The case the host label gets wrong: three identical labels tag every line with a
 * word that separates nothing. */
test("several containers on one host are labelled by container", () => {
  assert.deepEqual(
    memberLabels([M("web-01", "api"), M("web-01", "worker"), M("web-01", "cache")]),
    ["api", "worker", "cache"],
  );
});

test("a mix falls back to both, but only then", () => {
  assert.deepEqual(
    memberLabels([M("web-01", "api"), M("web-01", "worker"), M("web-02", "api")]),
    ["web-01/api", "web-01/worker", "web-02/api"],
  );
});

test("two hosts running two containers each still resolves", () => {
  assert.deepEqual(
    memberLabels([M("a", "web"), M("a", "db"), M("b", "web"), M("b", "db")]),
    ["a/web", "a/db", "b/web", "b/db"],
  );
});

test("a single member is its host, and an empty pane has no labels", () => {
  assert.deepEqual(memberLabels([M("web-01", "api")]), ["web-01"]);
  assert.deepEqual(memberLabels([]), []);
});

/* A host added by URL before its own name is known has no label; the id stands in
 * rather than leaving a blank gutter. */
test("a member with no host label falls back to its id", () => {
  assert.deepEqual(
    memberLabels([{ hostId: "box-two-lan-8080", container: "api" }, M("web-01", "api")]),
    ["box-two-lan-8080", "web-01"],
  );
});
