// How much history one request is allowed to ask for.
//
// A container that has been up for two months has two months of log, and docker
// will happily replay all of it: `since` two months back means every line of it
// walks out of the daemon, through an isolate, across the SSE stream and into a
// browser that only ever displays the last 2000. The browser survives that — it
// caps its own buffer — but the host doing the replaying does not necessarily,
// and it's the host running the containers that matters.
//
// So a window has a maximum WIDTH. Not a maximum age: a one-hour window from six
// weeks ago is a perfectly cheap question, because docker only sends the hour.
// What costs is the width, and that's what's bounded here.
//
// The cap lives in shared/ because three places have to agree on it — the browser
// (so the range it offers is a range it can actually get), the server (so a
// request from anything else is still bounded), and the tests. The browser learns
// the server's configured value from /api/containers; this default is what it
// assumes until then, and what an unconfigured server enforces.

export const DEFAULT_MAX_WINDOW_SEC = 24 * 3600;

/* Two constants that exist because the cap's edge moves with the clock, and a
 * boundary that moves is a boundary two callers will land on either side of.
 *
 * GRID — a trimmed window starts on a five-minute grid rather than at "exactly now
 * minus a day". Streams are shared by identity, and their identity includes their
 * window (server/logs.js): trimming to the exact second gives every request its own
 * `since`, so ten requests for two months of logs become ten isolates each replaying
 * a full day — the precise pile-up this cap exists to prevent. On the grid they
 * collapse into one.
 *
 * GRACE — a window already at the cap is left alone even once the edge has drifted
 * past it. Without it, the browser's clamp and the server's clamp disagree by the
 * fraction of a second between them, so every capped window would be re-trimmed on
 * arrival and reported as trimmed twice over. Two grid steps, so a request survives
 * the grid rolling under it. Together they mean an accepted window can exceed the
 * cap by up to GRACE — ten minutes on a day, which is not what "bounded" was
 * protecting against. */
const GRID_SEC = 300;
const GRACE_SEC = 2 * GRID_SEC;

/**
 * Trim a time window to at most `maxSec` wide, by moving its START forward.
 *
 * The end is left alone deliberately. Every window in this UI is anchored at the
 * end — "the last hour", "up to 14:00" — and the recent end is the part someone
 * asking for two months of logs actually wants to look at. Trimming the far edge
 * of a window nobody can read costs them nothing; trimming the near edge would
 * take away the lines they opened the pane for.
 *
 * An open-ended window (no `until`) is measured against `now`, since that's where
 * it currently ends and it grows from there. A window with no `since` at all is
 * not capped: it means "the tail, then follow", which is bounded by line count
 * rather than by time and never replays a history.
 *
 * @param {{since?:number|null, until?:number|null}} win  unix seconds
 * @param {number} maxSec  0 or negative disables the cap entirely
 * @param {number} now     unix seconds
 * @returns {{since:number|null, until:number|null, capped:boolean, requested:number|null}}
 *   `requested` is the `since` that was asked for, kept only when it was trimmed —
 *   the caller needs it to say what happened rather than silently show less.
 */
export function clampWindow(win, maxSec = DEFAULT_MAX_WINDOW_SEC, now = Math.floor(Date.now() / 1000)) {
  const since = Number(win?.since) || null;
  const until = Number(win?.until) || null;
  if (!since || !(maxSec > 0)) return { since, until, capped: false, requested: null };

  const end = until ?? now;
  const earliest = end - maxSec;
  if (since >= earliest - GRACE_SEC) return { since, until, capped: false, requested: null };
  return { since: Math.floor(earliest / GRID_SEC) * GRID_SEC, until, capped: true, requested: since };
}

/** The cap in words, for a note that has to explain itself in a few characters. */
export function describeCap(maxSec) {
  if (maxSec % 3600 === 0) {
    const h = maxSec / 3600;
    return h % 24 === 0 ? `${h / 24}d` : `${h}h`;
  }
  return `${Math.round(maxSec / 60)}m`;
}
