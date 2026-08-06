// Live container-log streams for THIS host.
//
// `docker_logs` is a GraphQL subscription, so each attached container needs an
// isolate holding that subscription open (agent/logstream.js) with its console
// piped back here. This module owns those isolates:
//
//   - one isolate per container *and time window*, however many viewers are
//     watching it. Two browsers on the same container and window share the stream
//     instead of doubling the work — and see identical lines, which matters when
//     the whole point is comparing streams side by side. The window is part of the
//     key because it changes what the subscription asks docker for: viewers on
//     different ranges genuinely cannot share one.
//   - a bounded tail per stream, so a viewer that attaches late (or reloads)
//     gets immediate context instead of a blank pane until the next line.
//   - a linger before teardown, so a reload doesn't tear down and re-spawn an
//     isolate for the sake of a two-second gap.
//
// A stream ends when its isolate exits — because the container stopped, or because
// a closed time window finished. Both are reported as terminal `status` events and
// neither is retried: "this container stopped" and "that window is fully delivered"
// are both information the operator wants, not faults to paper over. Re-attaching
// spawns a fresh isolate.

import { clampLimit, clampWindow, DEFAULT_MAX_LINES, DEFAULT_MAX_WINDOW_SEC } from "../shared/limits.js";
import { execYeet, socketArgs, startIsolate } from "./isolate.js";

const DEFAULT_TAIL = 500;
const LINGER_MS = 30_000;

/* Isolate names are tagged with our pid: `logedex-<pid>-<container>`.
 *
 * Two reasons. It says which server owns an isolate when you're looking at
 * `yeet ps`, and it makes the boot sweep safe — a stale isolate can be identified
 * as stale (its pid is gone) rather than guessed at. A sweep that just killed every
 * `logstream-*` would take out the other instance's streams on any box running two,
 * which is exactly what a dev setup looks like. */
const NAME_PREFIX = "logedex";
const isolateName = (container) => `${NAME_PREFIX}-${process.pid}-${container}`.slice(0, 64);
const OWNED_RE = new RegExp(`^(\\d+)\\b.*\\b${NAME_PREFIX}-(\\d+)-`);

/* The daemon paints its own errors, and those go into a JSON field and a browser
 * — neither of which wants escape codes. NO_COLOR doesn't cover every path. */
const stripAnsi = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, "").replace(/^[│|]\s*/, "").trim();

/**
 * @param {object} cfg
 * @param {string} cfg.yeetBin
 * @param {string} cfg.script       path to agent/logstream.js
 * @param {string} [cfg.socket]
 * @param {string} [cfg.userSocket]
 * @param {number} [cfg.tail]       events kept per container for backfill
 * @param {number} [cfg.maxWindowSec] widest history one stream may ask for; 0 = no cap
 * @param {number} [cfg.maxLines]   most lines one stream may ask the source to replay
 */
export function createLogs(cfg) {
  const tailSize = Math.max(0, cfg.tail ?? DEFAULT_TAIL);
  const maxWindowSec = cfg.maxWindowSec ?? DEFAULT_MAX_WINDOW_SEC;
  const maxLines = cfg.maxLines ?? DEFAULT_MAX_LINES;
  /** @type {Map<string, {container:string, ring:object[], subs:Set<Function>, handle:any,
   *                      state:string, error:string|null, idleTimer:any, seq:number,
   *                      lastLog:string|null}>} */
  const streams = new Map();

  function fanout(s, evt) {
    // Only log lines are buffered. A status isn't replayed from the ring because
    // `attach` sends the *current* state explicitly — replaying the historical
    // ones as well is how a new viewer ends up being told "starting" twice.
    if (tailSize && evt.t === "log") {
      s.ring.push(evt);
      if (s.ring.length > tailSize) s.ring.splice(0, s.ring.length - tailSize);
    }
    for (const fn of s.subs) {
      try { fn(evt); } catch { /* a dead subscriber is dropped by its own close */ }
    }
  }

  function setState(s, state, error = null, extra = null) {
    s.state = state;
    s.error = error;
    // Merged, not replaced: a stream's `capped` note is set once at attach and has
    // to survive every later status, or a window that finishes loading would stop
    // admitting it was trimmed at the moment the viewer reads the result.
    if (extra) s.extra = { ...s.extra, ...extra };
    fanout(s, { t: "status", state, error, container: s.container, ...(s.extra ?? {}) });
  }

  function spawn(s) {
    try {
      s.handle = startIsolate({
        yeetBin: cfg.yeetBin,
        script: cfg.script,
        name: isolateName(s.container),
        socket: cfg.socket,
        userSocket: cfg.userSocket,
        scriptArgs: [
          "--container", s.container,
          // The viewer's buffer size when it sent one, this host's own tail when it
          // didn't. A plain live tail (no window) keeps the smaller number: there is
          // no history being replayed, so it only sizes the catch-up a late viewer
          // gets, and the ring below can't hand out more than it holds anyway.
          "--tail", String(s.limit || Math.min(tailSize || 200, 500)),
          ...(s.since ? ["--since", String(s.since)] : []),
          ...(s.until ? ["--until", String(s.until)] : []),
          ...(s.find ? ["--find", s.find] : []),
        ],
        onLine: (msg) => {
          if (msg.t === "log") fanout(s, { ...msg, seq: ++s.seq });
          else if (msg.t === "hello") setState(s, s.until ? "loading" : "streaming");
          // A closed window delivered everything it has. Distinct from "ended":
          // nothing broke and nothing stopped, there is simply no more to send.
          else if (msg.t === "complete") setState(s, "complete", null, { lines: msg.lines, seen: msg.seen });
          else if (msg.t === "error") setState(s, "error", String(msg.error ?? "stream failed"));
        },
        onLog: (line) => {
          // Keep the most recent one: if the isolate dies without reporting a
          // reason of its own, this is the only explanation we'll have to show.
          s.lastLog = stripAnsi(line);
          console.error(`[logs ${s.container}] ${line}`);
        },
        onClose: () => {
          // The isolate exited: the subscription is gone. Exiting before it ever
          // got streaming means it failed to start (no such container, docker
          // unreachable) — and since a crash can outrun the isolate's own error
          // line, fall back to its last console output for the reason. Once it
          // *was* streaming, an exit is the ordinary end of a stopped container.
          if (s.state === "error" || s.state === "complete") { /* already terminal */ }
          else if (s.state === "streaming") setState(s, "ended");
          else if (s.state === "loading") setState(s, "complete");
          else setState(s, "error", s.lastLog || "the log stream exited before it started");
          s.handle = null;
          // Drop it so the next attach starts a fresh isolate rather than
          // subscribing to a corpse. Live viewers keep their tail and the
          // terminal status — they just won't get new lines.
          if (streams.get(s.key) === s) streams.delete(s.key);
        },
      });
    } catch (err) {
      setState(s, "error", err.message);
      if (streams.get(s.key) === s) streams.delete(s.key);
    }
  }

  /**
   * Watch one container's logs over a time window. `onEvent` is called with the
   * buffered tail first, then live events. The returned function detaches.
   *
   * @param {{container:string, since?:number, until?:number, find?:string, limit?:number}} req
   *   `since`/`until` are unix seconds; omit both for a plain live tail. An open
   *   range (no `until`) backfills from `since` and keeps following. `find` is a
   *   search query applied at the source, so non-matching lines never travel, and
   *   `limit` is how many lines the caller can hold — the newest that many inside
   *   the window, so the rest never travel either (see shared/limits.js).
   *
   *   A window wider than `maxWindowSec` is trimmed here rather than refused — see
   *   shared/limits.js. This is the enforcement point, not the browser's copy of the
   *   rule: the isolate this spawns replays history out of the local docker daemon,
   *   so a two-month `since` from anything at all (a stale tab, another dashboard
   *   relaying, curl) is this host's problem to bound. Viewers are told, through
   *   `capped` on the status event, so a trimmed window never passes for the whole
   *   one they asked for.
   * @param {(evt:object)=>void} onEvent
   */
  function attach(req, onEvent) {
    const name = String(req.container);
    const win = clampWindow({ since: req.since, until: req.until }, maxWindowSec);
    const since = win.since ?? 0;
    const until = win.until ?? 0;
    const find = String(req.find ?? "");
    /* How many lines the viewer can hold, bounding the backfill at the source.
     *
     * Only for an OPEN window. Without `since` there is no history to bound, and with
     * `until` docker refuses to apply a tail and a window at once — it returns nothing
     * at all, so asking for one would turn every closed window into an empty pane. The
     * isolate enforces that too; this keeps the stream key and `yeet ps` honest about
     * what was actually asked for.
     *
     * Clamped, not trusted: this arrives from a browser (or from anything else that
     * can reach the endpoint), and it decides how much this host reads out of docker. */
    const limit = since && !until ? clampLimit(req.limit, maxLines) : 0;
    // The query and the line bound join the window in the stream's identity: two
    // viewers searching for different things, or able to hold different amounts, are
    // asking the source for different lines and cannot share one subscription —
    // exactly as with two different time windows.
    const key = `${name}|${since}|${until}|${find}|${limit}`;
    let s = streams.get(key);
    if (!s) {
      s = {
        key, container: name, since, until, find, limit,
        ring: [], subs: new Set(), handle: null,
        state: "starting", error: null, idleTimer: null, seq: 0, lastLog: null,
        extra: win.capped
          ? { capped: { requested: win.requested, since: win.since, maxSec: maxWindowSec } }
          : null,
      };
      streams.set(key, s);
      spawn(s); // the isolate starts now; its events arrive on the event loop
    }
    if (s.idleTimer) { clearTimeout(s.idleTimer); s.idleTimer = null; }
    s.subs.add(onEvent);

    // Replay first so a new viewer is never staring at an empty pane, then the
    // current state — a viewer attaching to an already-streaming container needs
    // to be told it's live, since the "streaming" status came and went.
    for (const evt of s.ring) { try { onEvent(evt); } catch { /* ignore */ } }
    try {
      onEvent({ t: "status", state: s.state, error: s.error, container: name, ...(s.extra ?? {}) });
    } catch { /* ignore */ }

    return function detach() {
      s.subs.delete(onEvent);
      if (s.subs.size > 0 || s.idleTimer) return;
      // Nobody's watching: stop the isolate, but not instantly. A reload drops
      // and re-adds a subscriber within a second, and re-spawning for that is
      // pure churn (and loses the tail).
      s.idleTimer = setTimeout(() => {
        s.idleTimer = null;
        if (s.subs.size > 0) return;
        if (streams.get(s.key) === s) streams.delete(s.key);
        s.handle?.stop().catch(() => {});
        s.handle = null;
      }, LINGER_MS);
    };
  }

  /** What's attached right now — for /healthz and the UI's own bookkeeping. */
  function stats() {
    return [...streams.values()].map((s) => ({
      container: s.container, since: s.since || null, until: s.until || null,
      find: s.find || null, limit: s.limit || null,
      // The `since` above is the effective one; this says it isn't the one asked for.
      cappedFrom: s.extra?.capped?.requested ?? null,
      state: s.state, viewers: s.subs.size, buffered: s.ring.length,
    }));
  }

  /** Tear every stream down (shutdown). */
  async function stopAll() {
    const handles = [...streams.values()].map((s) => s.handle).filter(Boolean);
    streams.clear();
    await Promise.allSettled(handles.map((h) => h.stop()));
  }

  /**
   * Kill log-stream isolates left over from a previous run of this server.
   *
   * Ordinary shutdown cleans up after itself — both SIGTERM and SIGKILL leave
   * nothing behind. But an isolate lives in the daemon, not in this process, so a
   * hard enough death (OOM kill, the container being killed, a lost signal) can
   * still strand one holding a docker log stream open forever. Nothing else will
   * ever reap it, so sweep at boot.
   *
   * Only isolates tagged with a pid that no longer exists are touched, which is
   * what makes this safe to run when a second instance is up on the same box.
   */
  async function sweepOrphans() {
    const res = await execYeet(cfg.yeetBin, [...socketArgs(cfg), "ps"]);
    if (res.exitCode !== 0) return 0;
    let killed = 0;
    for (const raw of res.stdout.split("\n")) {
      const m = OWNED_RE.exec(stripAnsi(raw));
      if (!m) continue;
      const [, isolateId, owner] = m;
      const pid = Number(owner);
      if (pid === process.pid) continue;
      // `kill(pid, 0)` is the standard liveness probe: no signal is delivered, it
      // just throws ESRCH when nothing owns that pid.
      try { process.kill(pid, 0); continue; } catch { /* owner is gone */ }
      await execYeet(cfg.yeetBin, [...socketArgs(cfg), "kill", isolateId]);
      console.log(`[logs] reaped orphaned isolate ${isolateId} from dead pid ${pid}`);
      killed++;
    }
    return killed;
  }

  /* The timestamp of a container's OLDEST retained log line.
   *
   * This is the left edge of the time slider, and it has to be measured rather than
   * assumed: a container's creation time is the obvious guess and it's wrong as soon
   * as the log has rotated, which would leave a dead zone at the end of the slider
   * that silently returns nothing.
   *
   * Measuring it is cheap because docker replays a log from its beginning: ask for
   * `since: 1` and the first line out IS the oldest, so `--head 1` gets the answer
   * for the cost of one line and an isolate that lives ~30ms.
   *
   * Cached, because the answer barely moves — it only changes when the log rotates —
   * and the browser asks for it every time a pane opens. */
  const oldestCache = new Map();   // container → {ts, at}
  const OLDEST_TTL_MS = 60_000;

  async function oldest(container) {
    const name = String(container);
    const hit = oldestCache.get(name);
    if (hit && Date.now() - hit.at < OLDEST_TTL_MS) return hit.ts;

    const ts = await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        handle?.stop().catch(() => {});
        resolve(value);
      };
      let handle = null;
      try {
        handle = startIsolate({
          yeetBin: cfg.yeetBin,
          script: cfg.script,
          name: isolateName(`oldest-${name}`),
          socket: cfg.socket,
          userSocket: cfg.userSocket,
          // `--tail 0` is load-bearing: this reads from the START of the log, and a
          // tail is applied last and would hand back the END of it instead — turning
          // "the oldest line" into "the 200th-newest", and the slider's left edge
          // into a few minutes ago on a container with days of history.
          scriptArgs: ["--container", name, "--since", "1", "--head", "1", "--tail", "0"],
          onLine: (msg) => {
            if (msg.t === "log") finish(msg.ts ?? null);
            // A container that has logged nothing completes with no lines — a real
            // answer ("no history"), not a failure.
            else if (msg.t === "complete") finish(null);
            else if (msg.t === "error") finish(null);
          },
          onLog: () => {},
          onClose: () => finish(null),
        });
      } catch { finish(null); }
      // Never let a wedged probe hold up the UI that asked for it.
      setTimeout(() => finish(null), 8000);
    });

    oldestCache.set(name, { ts, at: Date.now() });
    return ts;
  }

  return { attach, stats, stopAll, sweepOrphans, oldest };
}
