import test from "node:test";
import assert from "node:assert/strict";
import { clampWindow, DEFAULT_MAX_WINDOW_SEC, describeCap } from "./limits.js";

const NOW = 1_800_000_000;
const DAY = 24 * 3600;

test("a window inside the cap is passed through untouched", () => {
  const win = clampWindow({ since: NOW - 3600 }, DAY, NOW);
  assert.deepEqual(win, { since: NOW - 3600, until: null, capped: false, requested: null });
});

test("a window exactly at the cap is not trimmed", () => {
  assert.equal(clampWindow({ since: NOW - DAY }, DAY, NOW).capped, false);
});

test("an over-wide open window keeps its recent end", () => {
  const win = clampWindow({ since: NOW - 60 * DAY }, DAY, NOW);
  assert.equal(win.until, null);
  assert.equal(win.capped, true);
  assert.equal(win.requested, NOW - 60 * DAY);
  // On the grid, and never wider than the cap plus the grace band.
  assert.equal(win.since % 300, 0);
  assert.ok(win.since <= NOW - DAY && win.since >= NOW - DAY - 300);
});

/* The pile-up this is really guarding against: a client retrying an absurd window
 * must land on ONE stream, not a fresh day-long replay per attempt. */
test("requests a few seconds apart trim to the same start", () => {
  const starts = new Set();
  for (let i = 0; i < 60; i++) starts.add(clampWindow({ since: NOW - 60 * DAY }, DAY, NOW + i).since);
  assert.equal(starts.size, 1);
});

/* And a window that was already trimmed must survive being re-sent — the browser
 * clamps, then the server clamps the result. Trimming twice would report a trim on
 * a window that was already within the cap. */
test("re-clamping a clamped window is a no-op", () => {
  const first = clampWindow({ since: NOW - 60 * DAY }, DAY, NOW);
  for (const drift of [0, 1, 60, 300]) {
    const again = clampWindow({ since: first.since }, DAY, NOW + drift);
    assert.equal(again.capped, false, `re-trimmed after ${drift}s`);
    assert.equal(again.since, first.since);
  }
});

/* The cap is on width, not on age — an old but narrow window is cheap, because
 * docker only sends the slice. Trimming it would refuse a question worth asking. */
test("an old narrow window is left alone", () => {
  const since = NOW - 60 * DAY;
  const win = clampWindow({ since, until: since + 3600 }, DAY, NOW);
  assert.equal(win.since, since);
  assert.equal(win.capped, false);
});

test("a closed window is measured against its own end, not now", () => {
  const until = NOW - 30 * DAY;
  const win = clampWindow({ since: until - 10 * DAY, until }, DAY, NOW);
  assert.equal(win.until, until);
  assert.equal(win.capped, true);
  assert.ok(win.since <= until - DAY && win.since >= until - DAY - 300);
});

/* No `since` means "the tail, then follow" — bounded by line count, so there is no
 * history to replay and nothing to cap. Inventing a `since` here would turn the
 * cheapest request in the app into a one-day backfill. */
test("a live tail is never given a start", () => {
  const win = clampWindow({}, DAY, NOW);
  assert.equal(win.since, null);
  assert.equal(win.capped, false);
});

test("the cap can be turned off", () => {
  for (const off of [0, -1]) {
    const win = clampWindow({ since: NOW - 60 * DAY }, off, NOW);
    assert.equal(win.since, NOW - 60 * DAY);
    assert.equal(win.capped, false);
  }
});

test("the default cap is a day", () => {
  assert.equal(DEFAULT_MAX_WINDOW_SEC, DAY);
  assert.ok(clampWindow({ since: NOW - 60 * DAY }, undefined, NOW).since >= NOW - DAY - 300);
});

test("caps describe themselves in the coarsest unit that fits", () => {
  assert.equal(describeCap(DAY), "1d");
  assert.equal(describeCap(2 * DAY), "2d");
  assert.equal(describeCap(6 * 3600), "6h");
  assert.equal(describeCap(90 * 60), "90m");
});
