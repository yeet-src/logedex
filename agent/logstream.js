// One container's logs, streamed out of a yeet isolate as JSON lines.
//
//   yeet run agent/logstream.js -- --container <name> [--tail 200 | --tail 0]
//                                  [--since <unix-sec>] [--until <unix-sec>]
//                                  [--find "<query>"]
//
// The system graph exposes `docker_logs` as a GraphQL *subscription*, so this is
// the whole data layer: subscribe, and print each line to the console. The
// console IS the wire — server/isolate.js runs this as a child process and parses
// these lines off its stdout (server/logs.js owns the lifecycle). Nothing here
// touches eBPF; container logs are host state, and host state is what the graph
// is for.
//
// Protocol, one JSON object per line:
//   {"t":"hello","container":…,"follow":…}           once, after subscribing
//   {"t":"log","stream":"stdout","ts":…,"message":…} per log line
//   {"t":"complete","lines":N}                       a closed window finished
//   {"t":"error","error":…}                          subscription failed
//
// `ts` is the RFC-3339 stamp docker prefixes when `timestamps: true`, split off
// here so the message is the line the container actually wrote. It's null when
// docker didn't give us one (a partial line, or a driver that omits them).
//
// TIME RANGE. `since`/`until` are docker's own filters, passed straight through.
// Whether we follow is derived rather than a separate flag, because there is only
// one sensible answer: an open-ended range (`until` unset) means "catch me up and
// keep going", and a closed one is a fixed window that must not wait for lines
// that by definition can't arrive.
// SEARCH. `--find` filters here, at the source, so a query over an hour of logs on
// a remote host sends back the handful of matching lines instead of the hour. The
// matcher is shared with the browser (one query must mean one thing) and is
// substring-only — see shared/search.js for why a regex from a browser must never
// be compiled into this isolate.
import { subscribe } from "yeet:graph";
import { matches, parseQuery } from "../shared/search.js";

const container = String(yeet.args.container ?? yeet.args._?.[0] ?? "");
/* Lines, not a string: `0` is a real value here (no bound) and has to survive the
 * round trip from an argv that only carries text. An unusable value falls back to
 * the default rather than to 0 — "I couldn't read your bound" must not resolve to
 * "so I'll send everything". */
const tailArg = Number(yeet.args.tail ?? 200);
const tail = Number.isFinite(tailArg) && tailArg >= 0 ? Math.floor(tailArg) : 200;
const since = Number(yeet.args.since) || 0;
const until = Number(yeet.args.until) || 0;
const follow = !until;
const query = parseQuery(yeet.args.find ?? "");
/* Stop after this many matching lines. `--since 1 --head 1` is how the server finds
 * a container's OLDEST log line: docker replays a log from its beginning, so the
 * first line out is the oldest one, and quitting immediately makes the answer cost
 * one line instead of the whole history. */
const head = Number(yeet.args.head) || 0;

/* Report and leave. `yeet.exit()` tears the isolate down immediately, and a
 * console line written in the same turn can lose the race with that teardown —
 * the reader then sees the isolate vanish with no reason attached. A timer defers
 * the exit past the flush; the server treats an isolate that exits before it ever
 * reported a line as a startup failure anyway, so this only ever adds detail. */
function die(error) {
  console.log(JSON.stringify({ t: "error", error: reason(error) }));
  setTimeout(() => yeet.exit(), 50);
}

/* Graph errors arrive as Rust debug output wrapping the message that actually
 * matters — `…[ServerError { message: "No such container: x", locations: …`.
 * This string is what the UI puts in front of an operator, so lift the inner
 * message out when it's there and keep the whole thing when it isn't. */
function reason(error) {
  const text = String(error?.message ?? error);
  const inner = /message:\s*"((?:[^"\\]|\\.)*)"/.exec(text);
  if (!inner) return text;
  try { return JSON.parse(`"${inner[1]}"`); } catch { return inner[1]; }
}

if (!container) {
  die("no --container given");
  await new Promise(() => {}); // hold the isolate open until die's timer fires
}

/* `follow` is what makes this a live stream rather than a one-shot dump; `tail`
 * backfills what the container wrote before we attached. Both output streams are
 * requested and labelled per line, so the viewer can tell stderr from stdout.
 *
 * `tail` and `since` are applied TOGETHER, and that is a deliberate reversal.
 *
 * They used to be exclusive — two answers to "where do I start", so `since` won and
 * `tail` was dropped — on the grounds that docker applies tail last, and handing back
 * the final 200 lines of a 5,000-line window reads as a broken time filter. That
 * reasoning holds for a tail the CALLER didn't choose. It doesn't hold when the tail
 * is the caller's own buffer size, because then the lines it excludes are exactly the
 * lines that would have been dropped on arrival: a 15-minute window on a busy
 * container measured 76,843 lines delivered to fill a viewer holding 2,000, all of it
 * read out of docker, serialised, streamed and parsed to be thrown away.
 *
 * Both bounds together mean: the newest `tail` lines that fall inside the window.
 * `--tail 0` asks for no bound at all — the oldest-line probe in server/logs.js needs
 * it, since it reads from the START of the log and a tail would hand it the end.
 *
 * EXCEPT with `until`, where docker will not combine them at all. Measured, on docker
 * itself rather than through the graph:
 *
 *   docker logs --since S --until U web-01              → 284 lines
 *   docker logs --since S --until U --tail 2000 web-01  →   0 lines
 *
 * The tail is taken from the end of the whole log, which for a closed window lies
 * entirely after `until`, and the intersection is empty. So a closed window sends no
 * tail: it is bounded at both ends by the operator's own choice, and there is no way
 * to ask docker to bound it further. A wide one on a busy container is still every
 * line of it — the width cap in shared/limits.js is all that stands behind that. */
const opts = [
  `follow: ${follow}`,
  "stdout: true",
  "stderr: true",
  "timestamps: true",
  ...(since ? [`since: ${since}`] : []),
  ...(tail > 0 && !until ? [`tail: ${JSON.stringify(String(tail))}`] : []),
  ...(until ? [`until: ${until}`] : []),
].join(", ");

const QUERY = `subscription {
  docker_logs(
    container_name: ${JSON.stringify(container)}
    opts: { ${opts} }
  ) {
    __typename
    ... on stdout { message }
    ... on stderr { message }
    ... on console { message }
  }
}`;

// A docker timestamp prefix: RFC 3339 with nanoseconds, then one space.
const STAMPED = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s(.*)$/s;

let lines = 0;    // lines sent
let seen = 0;     // lines considered, so a search can report how much it sifted
let done = false; // head limit reached; exit is pending on a flush timer

function emit(stream, raw) {
  // The exit after `--head` is deferred by a timer to let the last line flush, and
  // the subscription can fire again inside that gap — so nothing more may be
  // written, or a reader would see lines arrive after the stream said it finished.
  if (done) return;
  // Docker delivers whole lines but keeps the trailing newline; a chunk can also
  // carry several. Split so one console line is one log line — the reader is
  // line-oriented and would otherwise see embedded newlines inside a JSON string.
  for (const line of String(raw).replace(/\n$/, "").split("\n")) {
    const m = STAMPED.exec(line);
    const message = m ? m[2] : line;
    seen++;
    // Matched against the message, not the raw line: the timestamp prefix is
    // docker's, and letting a query hit it would mean `-2026` silently discarding
    // everything, and `error` behaving differently depending on whether stamps
    // happened to be enabled.
    if (!matches(message, query)) continue;
    lines++;
    console.log(JSON.stringify({
      t: "log",
      stream,
      ts: m ? m[1] : null,
      message,
    }));
    if (head && lines >= head) {
      // Asked for the first N and got them — nothing left to wait for, whether or
      // not this was a closed window.
      done = true;
      console.log(JSON.stringify({ t: "complete", lines, seen }));
      setTimeout(() => yeet.exit(), 50);   // same flush-before-exit race as die()
      return;
    }
  }
}

/* Deciding a closed window is finished.
 *
 * `subscribe` gives us data and errors, and nothing else — there is no completion
 * callback, and a docker_logs stream that has delivered its last line just goes
 * quiet. For a *following* stream that's correct and indefinite. For a closed
 * window it means the only evidence of "done" is the absence of further lines, so
 * we settle it on a timer: quiet for long enough, and the window is complete.
 *
 * Two deadlines, because silence before the first line and silence after it are not
 * the same event.
 *
 * BEFORE the first line, docker has not started replaying yet. It is scanning a log
 * from the beginning to find where the window starts, and how long that takes is a
 * function of how much history sits in front of it — measured at 3.2s on a container
 * with two days of logs, and it grows from there. A single 2s idle timer covered this
 * whole period, so every closed window on a container of any age completed with
 * `lines: 0` before docker had emitted anything: an empty pane that claimed the range
 * was empty. FIRST_LINE_MS is the budget for that scan.
 *
 * AFTER the first line, docker is streaming and quiet genuinely means finished, so
 * IDLE_MS stays short — it's the gap between consecutive lines of a replay running at
 * thousands of lines a second.
 *
 * Both are heuristics, and both fail in the harmless direction: too generous means a
 * finished window is declared finished late, never that a full one is declared empty.
 * A following stream never runs any of this, so an idle container is never mistaken
 * for a finished one. */
const IDLE_MS = 2000;
const FIRST_LINE_MS = 20000;
let idle = null;

function armCompletion() {
  if (follow) return;
  clearTimeout(idle);
  // `seen`, not `lines`: a search that has matched nothing has still proved the
  // stream is delivering, and is in the fast regime like any other.
  idle = setTimeout(() => {
    // `seen` matters when a search is on: "3 lines" over a closed window is very
    // different news depending on whether 3 or 30000 were examined to find them.
    console.log(JSON.stringify({ t: "complete", lines, seen }));
    setTimeout(() => yeet.exit(), 50); // same flush-before-exit race as die()
  }, seen ? IDLE_MS : FIRST_LINE_MS);
}


try {
  await subscribe(
    QUERY,
    (msg) => {
      const out = msg?.data?.docker_logs;
      if (!out) return;
      // The union arm is the stream: __typename is "stdout" | "stderr" | "console".
      emit(out.__typename ?? "stdout", out.message ?? "");
      armCompletion(); // each line pushes the "window finished" verdict back
    },
    // Runtime errors arrive here rather than as a rejection — and "no such
    // container" is one of them, because the subscription is established before
    // docker is asked. Report and leave; re-attaching is the right recovery for a
    // container that has since been restarted, and that's the viewer's call.
    (err) => die(err?.message ?? err),
  );
  console.log(JSON.stringify({ t: "hello", container, follow }));
  // Start the clock now, not on the first line: an empty window (nothing was
  // logged in that range) is a legitimate answer and has to complete too.
  armCompletion();
} catch (err) {
  // Setup-time failure: docker unreachable, bad query, isolate gone.
  die(err?.message ?? err);
}

await new Promise(() => {}); // keep the isolate alive; the subscription owns it
