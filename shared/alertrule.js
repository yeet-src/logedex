// What makes an alert rule valid, and what a match costs. Shared by the browser (so the form
// can say what's wrong while you type) and the server (which is where it's actually enforced).
//
// Same arrangement as shared/limits.js: the browser's copy is a courtesy, the server's copy is
// the rule. Anything reaching /api/alerts is re-validated there, because a rule can arrive from
// a stale tab, another instance relaying, or curl.
//
// ── WHY A REGEX IS ALLOWED HERE AT ALL ────────────────────────────────────────
//
// shared/search.js refuses regex outright, and that refusal still stands where it was made:
// a *search* pattern is compiled inside a yeet isolate, once per log line, on someone's
// production host, and a catastrophically backtracking pattern there can wedge the daemon for
// every script on the box. That is a blast radius no feature justifies.
//
// An alert pattern never enters an isolate. It is compiled and run in the node server, and the
// isolate only ever receives finished alert text (see agent/alert.js). So the worst case moves
// from "the host's daemon stalls" to "this dashboard's event loop stalls" — same class of bug,
// a fraction of the consequence, and on a process whose own README says it is not a security
// boundary. That is the trade, stated plainly rather than left for someone to discover.
//
// It is still worth not walking into, so a pattern is bounded twice:
//
//   1. A CANARY before a rule is ever saved — server/redos.js. It runs the pattern against inputs
//      designed to trigger exponential backtracking, INSIDE A WORKER THREAD IT CAN KILL. That
//      detail is the whole trick and it was learned the hard way: a canary that simply times the
//      pattern on the calling thread *is* the attack it's checking for. `(a+)+$` against forty
//      `a`s and a `!` is 2^40 steps, so the check hangs the server it was added to protect.
//      A worker can be terminated mid-regex; a main thread cannot be interrupted at all.
//   2. A LENGTH CAP at match time (`MATCH_MAX`). Backtracking blows up in the length of the
//      input, so a pattern that behaved on short probes can still be fed a 2MB log line by a
//      container logging a whole JSON document. Truncating keeps the canary's verdict meaningful.
//
// This file holds only the checks that are cheap and safe on any thread — length, flags, and
// whether the thing compiles at all — so the browser can use them for immediate feedback while
// you type. The canary is node-only and lives with the server, which is the enforcement point.
//
// RESIDUAL RISK, stated rather than implied: matching itself runs on the server's event loop. A
// pattern that is fast on the probes and slow on one particular real 10,000-character line would
// stall this dashboard until that line finished. The fix, if that ever matters, is to move
// matching into the same kind of worker the canary uses — every line then costs a postMessage,
// which is why it isn't there already.

/** Longest pattern we'll take. Long patterns aren't inherently slow, but they're the shape
 *  every ReDoS example takes, and nothing legitimate here needs more. */
export const PATTERN_MAX = 200;

/** Flags an operator may set. `i` and `m` and `s` are meaning; `g` and `y` are STATE — they
 *  move `lastIndex` between calls, so a shared regex would match every other line and look
 *  like a bug in the alerting rather than in the flags. `u`/`v` change escape semantics for no
 *  gain on log text. */
export const FLAGS_ALLOWED = "ims";

/** Truncation before matching. Ten thousand characters is far past any line a human reads and
 *  well inside where backtracking stays cheap. */
export const MATCH_MAX = 10_000;

/** The default gap between two alerts from one rule. Five minutes, because the failure this
 *  prevents is the loud one: a container in a crash loop matches on every restart, and a rule
 *  with no cooldown turns that into a thousand Slack messages and a muted channel. */
export const COOLDOWN_DEFAULT_SEC = 300;
export const COOLDOWN_MAX_SEC = 86_400;

/** How many log lines either side of the matching one to include in the alert.
 *
 * Three by default, because the matching line is very often not the useful one: a container writes
 * `ERROR: request failed` and then the traceback that says why, or writes the request id on the line
 * before. An alert carrying one line out of that makes you go and look, which is most of the work
 * the alert was supposed to save.
 *
 * The cap is low on purpose. This lands in a Slack message, where twenty lines of log is already a
 * wall, and the after-context costs a real delay — the alert cannot be sent until those lines have
 * arrived or the wait times out (see server/alerts.js). Zero is a valid answer and means "just the
 * line", with no delay at all. */
export const CONTEXT_DEFAULT = 3;
export const CONTEXT_MAX = 20;

const NAME_MAX = 80;
/* A rule's targets are (host, container) PAIRS, not a host plus a list of containers, and that is
 * a correctness point rather than a shape preference. The main reason a pane gets merged in this
 * app is "the same service running on the other boxes" — see mergeCandidates in order.js, which
 * ranks candidates by matching image across hosts. So the most ordinary alert anyone will write is
 * `api` on web-01 AND web-02, which a single hostId cannot say at all. Pairs also cover the other
 * two cases (one container; several containers on one box) without a special case. */
const TARGETS_MAX = 20;
/* Docker's own name charset, matching the check in server/index.js — a rule naming a container
 * that could not exist is a typo worth catching at the form. */
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;
/* Slack takes `#channel`, a bare `channel`, a `Cxxxx` id, or `@user`. Rather than model Slack's
 * rules, refuse only what can't be a destination: nothing, whitespace, or something absurd. */
const CHANNEL_RE = /^[^\s]{1,80}$/;

/* Inputs built to make a backtracking pattern show itself, used by the canary in server/redos.js.
 *
 * A run of one character with nothing to anchor on is the classic trigger for `(a+)+`, `(a|a)*`,
 * `(\s*)*`; the trailing near-miss is what turns a slow match into an exhaustive one, because the
 * engine has to prove every partition fails before it can give up.
 *
 * They are SHORT on purpose — 24 characters, not the 40 this started with. The canary runs in a
 * killable worker, so length is no longer a safety question, but it is still a latency one: at 24
 * characters a doubly-exponential pattern is caught in milliseconds, while at 40 the worker just
 * burns its whole timeout before being terminated. Shorter probes make the common case fast and
 * the bad case still obvious. */
export const CANARY_INPUTS = [
  "a".repeat(24),
  `${"a".repeat(24)}!`,
  `${" ".repeat(24)}x`,
  `${"ab".repeat(12)}!`,
  `${"0".repeat(24)}-`,
];

/**
 * Compile a pattern, or explain why not.
 *
 * Cheap checks only — length, flags, and whether it compiles. Safe to call anywhere, including on
 * a keystroke in the browser. It does NOT run the pattern: that's the canary's job, on a thread
 * that can be killed. A pattern this accepts may still be refused when saved.
 *
 * @param {string} pattern
 * @param {string} [flags]
 * @returns {{re: RegExp} | {error: string}}
 */
export function compileGuarded(pattern, flags = "i") {
  const src = String(pattern ?? "");
  if (!src) return { error: "pattern is required" };
  if (src.length > PATTERN_MAX) return { error: `pattern must be under ${PATTERN_MAX} characters` };

  const f = String(flags ?? "");
  for (const ch of f) {
    if (!FLAGS_ALLOWED.includes(ch)) {
      return { error: `flag "${ch}" is not allowed — only ${[...FLAGS_ALLOWED].join(", ")}` };
    }
  }
  if (new Set(f).size !== f.length) return { error: "duplicate flag" };

  let re;
  try { re = new RegExp(src, f); }
  catch (err) { return { error: `not a valid regex: ${err.message}` }; }
  return { re };
}

/** Truncate a line to the bound the canary's verdict assumes. */
export function forMatching(text) {
  const s = String(text ?? "");
  return s.length > MATCH_MAX ? s.slice(0, MATCH_MAX) : s;
}

/**
 * Validate and normalise a rule as submitted. Returns the stored shape, or an error.
 *
 * Host existence is NOT checked here — this file has no host list. The server checks it.
 *
 * @param {object} input
 * @param {object} [prev]  the rule being edited, whose id and counters are kept
 * @returns {{rule: object} | {error: string}}
 */
export function normalizeRule(input, prev = null) {
  const name = String(input?.name ?? "").trim();
  if (!name) return { error: "name is required" };
  if (name.length > NAME_MAX) return { error: `name must be under ${NAME_MAX} characters` };

  const flags = String(input?.flags ?? "i");
  const compiled = compileGuarded(input?.pattern, flags);
  if ("error" in compiled) return { error: compiled.error };

  const channel = String(input?.channel ?? "").trim();
  if (!channel) return { error: "channel is required" };
  if (!CHANNEL_RE.test(channel)) return { error: "channel cannot contain spaces" };

  const raw = Array.isArray(input?.targets) ? input.targets : [];
  /* De-duplicated and sorted, so "the same set" is one rule however the pane was assembled — a
   * merged pane built api+worker and one built worker+api describe the same thing. */
  const seen = new Map();
  for (const t of raw) {
    const hostId = String(t?.hostId ?? "").trim();
    const container = String(t?.container ?? "").trim();
    if (!hostId || !container) return { error: "each target needs a hostId and a container" };
    if (!CONTAINER_RE.test(container)) return { error: `not a valid container name: ${container}` };
    seen.set(`${hostId}|${container}`, { hostId, container });
  }
  const targets = [...seen.values()].sort((a, b) =>
    a.hostId.localeCompare(b.hostId) || a.container.localeCompare(b.container));
  if (targets.length === 0) return { error: "at least one container is required" };
  if (targets.length > TARGETS_MAX) return { error: `at most ${TARGETS_MAX} containers` };

  let cooldownSec = input?.cooldownSec === undefined || input?.cooldownSec === null || input?.cooldownSec === ""
    ? COOLDOWN_DEFAULT_SEC
    : Number(input.cooldownSec);
  if (!Number.isFinite(cooldownSec) || !Number.isInteger(cooldownSec) || cooldownSec < 0) {
    return { error: "cooldown must be a whole number of seconds" };
  }
  if (cooldownSec > COOLDOWN_MAX_SEC) return { error: `cooldown must be at most ${COOLDOWN_MAX_SEC} seconds` };

  let contextLines = input?.contextLines === undefined || input?.contextLines === null || input?.contextLines === ""
    ? CONTEXT_DEFAULT
    : Number(input.contextLines);
  if (!Number.isFinite(contextLines) || !Number.isInteger(contextLines) || contextLines < 0) {
    return { error: "context must be a whole number of lines" };
  }
  if (contextLines > CONTEXT_MAX) return { error: `context must be at most ${CONTEXT_MAX} lines` };

  return {
    rule: {
      id: prev?.id ?? input?.id ?? null,        // the store mints one when null
      name,
      pattern: String(input.pattern),
      flags,
      channel,
      targets,
      cooldownSec,
      contextLines,
      enabled: input?.enabled === undefined ? true : !!input.enabled,
      createdAt: prev?.createdAt ?? Math.floor(Date.now() / 1000),
      /* Carried across an edit on purpose. Editing a rule's text is not a reason to forget that
       * it fired ninety seconds ago — otherwise "fix the wording" is a way to defeat the
       * cooldown, and a noisy rule gets edited exactly when it's being noisy. */
      lastFiredAt: prev?.lastFiredAt ?? 0,
      firedCount: prev?.firedCount ?? 0,
      /* Why the boot canary switched this rule off, if it did. Carried from the INPUT rather than
       * from `prev`, which is the distinction that makes it work: reading the file back preserves
       * the reason (the file is the input), while an operator editing the rule in the UI submits
       * without it and gets a clean slate. The server deletes it on any save that passes. */
      ...(input?.disabledReason ? { disabledReason: String(input.disabledReason) } : {}),
    },
  };
}

/**
 * Should this match fire, given when the rule last fired?
 *
 * Leading edge: the first match after a quiet period goes out immediately, and the cooldown
 * suppresses what follows. The opposite (wait, then send) would make every alert arrive minutes
 * late for the sake of batching, which is the wrong trade when the alert is the point.
 *
 * @param {{cooldownSec:number, lastFiredAt:number}} rule
 * @param {number} nowSec
 */
export function shouldFire(rule, nowSec) {
  if (!rule.cooldownSec) return true;
  if (!rule.lastFiredAt) return true;
  return nowSec - rule.lastFiredAt >= rule.cooldownSec;
}

/** The watch key for one container on one host — the unit a stream is opened for, shared by
 *  every rule pointing at it. */
export const watchKey = (hostId, container) => `${hostId}|${container}`;
