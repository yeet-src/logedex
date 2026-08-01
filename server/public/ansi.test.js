import test from "node:test";
import assert from "node:assert/strict";
import { parseAnsi } from "./ansi.js";

const E = "\x1b";

test("a line with no escapes is returned untouched, with no runs", () => {
  const { text, runs } = parseAnsi("INFO web-01 GET /health 200");
  assert.equal(text, "INFO web-01 GET /health 200");
  assert.deepEqual(runs, []);
});

test("a coloured word becomes text plus one run", () => {
  const { text, runs } = parseAnsi(`${E}[32mINFO${E}[0m ready`);
  assert.equal(text, "INFO ready", "the escapes are gone from the visible text");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0], { start: 0, end: 4, cls: ["a-green"], style: {} });
});

/* Offsets index the VISIBLE text, which is the whole point: the caller matches and
 * highlights against that string and never has to know escapes were involved. */
test("run offsets ignore the escapes entirely", () => {
  const { text, runs } = parseAnsi(`ok ${E}[31mfail${E}[0m ok`);
  assert.equal(text, "ok fail ok");
  assert.equal(text.slice(runs[0].start, runs[0].end), "fail");
});

test("attributes stack and unset independently", () => {
  const { runs } = parseAnsi(`${E}[1m${E}[4mboth${E}[24mbold${E}[0mplain`);
  assert.deepEqual(runs[0].cls, ["a-bold", "a-underline"]);
  assert.deepEqual(runs[1].cls, ["a-bold"]);
  assert.equal(runs.length, 2, "the unstyled tail is not a run");
});

test("bright colours are distinct from their base", () => {
  assert.deepEqual(parseAnsi(`${E}[31ma`).runs[0].cls, ["a-red"]);
  assert.deepEqual(parseAnsi(`${E}[91ma`).runs[0].cls, ["a-bred"]);
  assert.deepEqual(parseAnsi(`${E}[41ma`).runs[0].cls, ["a-bg-red"]);
});

test("a bare reset is the same as an explicit one", () => {
  const { runs } = parseAnsi(`${E}[32mon${E}[mafter`);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].end, 2);
});

test("an unterminated colour runs to the end of the line", () => {
  const { text, runs } = parseAnsi(`${E}[33mwarning: no reset`);
  assert.equal(text, "warning: no reset");
  assert.deepEqual(runs, [{ start: 0, end: text.length, cls: ["a-yellow"], style: {} }]);
});

/* The parameters of an extended colour must be eaten by it. Read as codes of their
 * own, `38;2;0;0;255` would be "reset, reset, blue" — the wrong colour, from the
 * wrong part of the sequence. */
test("truecolor consumes its own arguments", () => {
  const { text, runs } = parseAnsi(`${E}[38;2;255;128;0morange${E}[0m`);
  assert.equal(text, "orange");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].style, { color: "rgb(255 128 0)" });
  assert.deepEqual(runs[0].cls, []);
});

test("256-colour maps the cube and the grey ramp", () => {
  assert.deepEqual(parseAnsi(`${E}[38;5;196mx`).runs[0].style, { color: "rgb(255 0 0)" });
  assert.deepEqual(parseAnsi(`${E}[38;5;240mx`).runs[0].style, { color: "rgb(88 88 88)" });
  // The first sixteen are the basic set, so they take a class and stay on-palette.
  assert.deepEqual(parseAnsi(`${E}[38;5;2mx`).runs[0].cls, ["a-green"]);
  assert.deepEqual(parseAnsi(`${E}[38;5;10mx`).runs[0].cls, ["a-bgreen"]);
});

/* Progress bars and spinners emit these constantly. A log pane has no cursor to
 * move, and showing the sequences as text is the failure this whole module avoids. */
/* An 8-bit CSI: the single byte 0x9b means exactly what ESC+[ means. Worth its own test because the
 * failure is deceptive — delete the byte and leave the parameters, and the line reads as though the
 * container logged "33mWARN" rather than as an escape form nobody handled. The fast path is half of
 * it: a line with an 8-bit CSI contains no ESC at all, so a bail-out that only looks for ESC returns
 * the line untouched however capable the parser below is. */
test("an 8-bit CSI is recognised like ESC+[", () => {
  const CSI = String.fromCharCode(0x9b);
  const { text, runs } = parseAnsi(`${CSI}33mWARN${CSI}0m tail`);
  assert.equal(text, "WARN tail");
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].cls, ["a-yellow"]);
});

test("non-colour escape sequences are dropped, not shown", () => {
  const { text, runs } = parseAnsi(`${E}[2K${E}[1Gdownloading${E}[?25l`);
  assert.equal(text, "downloading");
  assert.deepEqual(runs, []);
});

test("a colour spanning a reset-to-another-colour splits into two runs", () => {
  const { text, runs } = parseAnsi(`${E}[31mred${E}[32mgreen${E}[0m`);
  assert.equal(text, "redgreen");
  assert.deepEqual(runs.map((r) => [r.start, r.end, r.cls[0]]),
    [[0, 3, "a-red"], [3, 8, "a-green"]]);
});

test("empty and odd input doesn't throw", () => {
  for (const v of ["", null, undefined, E, `${E}[`, `${E}[38;5;`, `${E}[38;2;1m`]) {
    assert.doesNotThrow(() => parseAnsi(v));
  }
  assert.equal(parseAnsi(null).text, "");
});

test("styling a whole line still leaves the text intact", () => {
  const raw = `${E}[1;31mTraceback (most recent call last):${E}[0m`;
  const { text, runs } = parseAnsi(raw);
  assert.equal(text, "Traceback (most recent call last):");
  assert.deepEqual(runs[0].cls, ["a-red", "a-bold"]);
});
