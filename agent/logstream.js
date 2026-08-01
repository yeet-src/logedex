// One container's logs, streamed out of a yeet isolate as JSON lines.
//
//   yeet run agent/logstream.js -- --container <name> [--tail 200]
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
const tail = String(yeet.args.tail ?? "200");
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
 * `tail` is dropped once `since` is given: they're two different answers to "where
 * do I start", and docker applies tail LAST — so `tail: 200` over a window holding
 * 5000 lines silently hands back the final 200 of it, which reads as a broken time
 * filter rather than a line cap. */
const opts = [
  `follow: ${follow}`,
  "stdout: true",
  "stderr: true",
  "timestamps: true",
  ...(since ? [`since: ${since}`] : [`tail: ${JSON.stringify(tail)}`]),
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
 * we settle it on an idle timer: quiet for IDLE_MS, and the window is complete.
 *
 * It's a heuristic, and the failure mode is deliberately the harmless one — too
 * short and we'd declare a slow window finished early, so IDLE_MS is generous
 * relative to how fast docker replays history (thousands of lines a second). A
 * following stream never runs this, so an idle container is never mistaken for a
 * finished one. */
const IDLE_MS = 2000;
let idle = null;

function armCompletion() {
  if (follow) return;
  clearTimeout(idle);
  idle = setTimeout(() => {
    // `seen` matters when a search is on: "3 lines" over a closed window is very
    // different news depending on whether 3 or 30000 were examined to find them.
    console.log(JSON.stringify({ t: "complete", lines, seen }));
    setTimeout(() => yeet.exit(), 50); // same flush-before-exit race as die()
  }, IDLE_MS);
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
