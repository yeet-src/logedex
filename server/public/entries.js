// Deciding where one log ENTRY ends and the next begins.
//
// Docker has no concept of a multi-line log event. A seven-line Python traceback is
// seven `docker_logs` messages with seven timestamps, and everything downstream —
// this dashboard included — sees seven unrelated lines. That's fine until you filter:
// searching `TimeoutError` would show you the last line of a traceback and hide the
// six that say where it came from, which is worse than not filtering at all.
//
// So lines are grouped back into entries, and the filter runs on the entry. The rule
// has to be a heuristic — the information genuinely isn't in the stream — and it's
// built to fail in the safe direction: a continuation mistaken for a new entry costs
// you a line of context, while a new entry mistaken for a continuation would silently
// smuggle unrelated lines past an exclusion.
//
// INDENTATION is the rule, because every language that prints a stack trace indents
// its frames — Python (`  File "x", line 1`), Java (`\tat com.foo.Bar`), Go, Node,
// Ruby. A line that starts with whitespace continues the line above it.
//
// Python needs one addition, and it's the reason this file isn't a one-liner: the
// LAST line of a traceback is not indented.
//
//     Traceback (most recent call last):
//       File "/app.py", line 12, in handler
//         fn(arg)
//     TimeoutError: upstream did not respond          ← flush left, still the entry
//
// Indentation alone would split the exception off from its own stack trace, which is
// exactly the case someone searching for `TimeoutError` is trying to see. So a
// `Traceback (most recent call last):` line opens a block that stays open through the
// indented frames and swallows the first non-indented line after them — the
// terminator — and then closes.

/** A line that starts with a space or a tab continues the one above it. */
const INDENTED = /^[ \t]/;

/** The header docker will have stamped and split like any other line. */
const TRACEBACK_START = /^Traceback \(most recent call last\):\s*$/;

/**
 * A fresh grouping state. One per stream, NOT one per pane: a combined pane
 * interleaves several hosts, so consecutive lines on screen routinely come from
 * different containers and "the line above" is meaningless there. Each member's own
 * lines arrive in order, which is what makes this decidable at all — so grouping is
 * decided on arrival, per member, and the entry id it produces survives the merge.
 */
export function newEntryState() {
  return { seq: 0, openTraceback: false, started: false };
}

/**
 * Fold one line into the state and return the entry it belongs to.
 *
 * @param {object} state  from `newEntryState`, mutated in place
 * @param {string} message  the line, without docker's timestamp prefix
 * @returns {number} the entry's sequence number for this stream — equal to the
 *   previous call's when this line continues that entry, one greater when it starts
 *   a new one.
 */
export function entryOf(state, message) {
  const text = String(message ?? "");

  if (state.openTraceback) {
    if (INDENTED.test(text)) return state.seq;   // a frame
    /* The first flush-left line after the frames is the exception itself. It ends the
     * block and belongs to it — unless the traceback had no frames at all and this is
     * the very next line, which is still the terminator, so the same branch is right
     * either way. */
    state.openTraceback = false;
    return state.seq;
  }

  // A continuation of an ordinary multi-line message — a pretty-printed payload, a
  // wrapped SQL statement, a Java stack trace.
  if (state.started && INDENTED.test(text)) return state.seq;

  state.seq++;
  state.started = true;
  // `Traceback (…):` is itself a new entry — the ERROR line above it is a separate
  // log call, and joining them would be guessing.
  if (TRACEBACK_START.test(text)) state.openTraceback = true;
  return state.seq;
}
