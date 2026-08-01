import test from "node:test";
import assert from "node:assert/strict";
import { entryOf, newEntryState } from "./entries.js";

/** Group a stream of lines the way a pane does, and return the entries as arrays. */
function group(lines) {
  const state = newEntryState();
  const out = new Map();
  for (const line of lines) {
    const id = entryOf(state, line);
    if (!out.has(id)) out.set(id, []);
    out.get(id).push(line);
  }
  return [...out.values()];
}

test("ordinary lines are one entry each", () => {
  assert.deepEqual(
    group(["GET /health 200", "GET /api/orders 200", "worker done"]),
    [["GET /health 200"], ["GET /api/orders 200"], ["worker done"]],
  );
});

/* The case this exists for. Searching `TimeoutError` has to show the frames that say
 * where it came from, and searching `noisy.py` has to show what actually failed. */
test("a python traceback is one entry, terminator included", () => {
  const entries = group([
    "ERROR web-01 unhandled exception while handling req-27d2bf8b",
    "Traceback (most recent call last):",
    '  File "/noisy.py", line 134, in raise_one',
    "    fn(arg)",
    '  File "/noisy.py", line 111, in _call_upstream',
    "    raise TimeoutError(f\"upstream {host} did not respond\")",
    "TimeoutError: upstream inventory-svc.internal did not respond",
    "ERROR web-01 req-27d2bf8b failed, returning 500",
  ]);
  assert.equal(entries.length, 3, "the two ERROR lines are their own entries");
  assert.deepEqual(entries[0], ["ERROR web-01 unhandled exception while handling req-27d2bf8b"]);
  assert.equal(entries[1].length, 6, "header, four frame lines, and the exception");
  assert.equal(entries[1].at(-1), "TimeoutError: upstream inventory-svc.internal did not respond");
  assert.deepEqual(entries[2], ["ERROR web-01 req-27d2bf8b failed, returning 500"]);
});

test("the line after a traceback's terminator starts a new entry", () => {
  const entries = group([
    "Traceback (most recent call last):",
    "  File \"/app.py\", line 1, in <module>",
    "ValueError: bad",
    "INFO back to normal",
    "INFO and again",
  ]);
  assert.equal(entries.length, 3);
  assert.deepEqual(entries[1], ["INFO back to normal"]);
});

/* Java, Go and Node all indent their frames, so indentation alone carries them. */
test("indented frames continue whatever they follow", () => {
  const entries = group([
    "ERROR failed to connect",
    "\tat com.example.Client.connect(Client.java:42)",
    "\tat com.example.Main.run(Main.java:11)",
    "INFO retrying",
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].length, 3);
});

test("a leading indented line doesn't attach to nothing", () => {
  // First line of a stream, or the first line after the buffer was trimmed.
  const entries = group(["  orphaned continuation", "INFO next"]);
  assert.equal(entries.length, 2);
});

test("a traceback with no frames still keeps its exception", () => {
  const entries = group(["Traceback (most recent call last):", "RuntimeError: nope", "INFO after"]);
  assert.equal(entries.length, 2);
  assert.deepEqual(entries[0], ["Traceback (most recent call last):", "RuntimeError: nope"]);
});

test("two tracebacks in a row stay separate", () => {
  const entries = group([
    "Traceback (most recent call last):",
    "  File \"a.py\", line 1",
    "KeyError: 'x'",
    "Traceback (most recent call last):",
    "  File \"b.py\", line 2",
    "ValueError: y",
  ]);
  assert.equal(entries.length, 2);
  assert.equal(entries[0].length, 3);
  assert.equal(entries[1].length, 3);
});

test("blank and odd lines don't crash or swallow the next entry", () => {
  const entries = group(["", "INFO one", null, undefined, "INFO two"]);
  assert.equal(entries.length, 5, "each is its own entry; none is a continuation");
});

/* Grouping is per stream, so two members' states never see each other's lines even
 * though their output ends up interleaved in one pane. */
test("two streams group independently", () => {
  const a = newEntryState();
  const b = newEntryState();
  assert.equal(entryOf(a, "Traceback (most recent call last):"), 1);
  assert.equal(entryOf(b, "INFO unrelated"), 1);
  assert.equal(entryOf(a, "  File \"x.py\", line 1"), 1, "still A's traceback");
  assert.equal(entryOf(b, "INFO also unrelated"), 2);
  assert.equal(entryOf(a, "KeyError: k"), 1, "terminator still A's");
});
