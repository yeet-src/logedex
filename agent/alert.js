// Deliver one alert, out of a yeet isolate.
//
//   yeet run agent/alert.js -- --payload <percent-encoded json>
//
// `yeet.alert` is a global that only exists inside the daemon's V8 isolate — there is no
// `yeet alert` subcommand — so firing an alert means running a script, and this is that
// script. It does one thing and exits: the server (server/alerts.js) decides WHEN to alert
// and what to say, this decides nothing.
//
// WHY THE REGEX ISN'T HERE. This is the deliberate half of the design. A rule's pattern is
// matched in the node server and only the finished text crosses into an isolate, because a
// pattern typed in a browser must never be compiled in here: catastrophic backtracking in an
// isolate doesn't just fail, it can wedge the daemon for every script on the box. That rule
// is stated in shared/search.js and agent/logstream.js, and alerting does not get an
// exception to it. Nothing in this file compiles anything.
//
// Protocol, one JSON object per line, same as the other agents:
//   {"t":"sent","result":…}    the platform accepted it
//   {"t":"error","error":…}    it didn't
//
// THE PAYLOAD IS PERCENT-ENCODED, and the encoding was chosen twice — the first choice was wrong
// in a way worth recording.
//
// Why encode at all: this argument carries an operator's alert text and a whole Slack block, so it
// contains newlines, quotes, braces and possibly a literal `--`. Passing that as a bare argv string
// means every layer between here and there (node's spawn, yeet's flag parser) has to agree about
// quoting, and the failure mode is a silently truncated alert rather than an error.
//
// Why not base64, which is what this did first: decoding it needs `atob` or `Buffer`, and THE
// ISOLATE HAS NEITHER. Both are host-provided — `atob` is a web API, `Buffer` is node's — and this
// is close to bare V8 plus the `yeet` namespace. The failure was `atob is not defined`, at the
// moment a real alert fired, which is the worst time to find out.
//
// `decodeURIComponent` is different in the way that matters: it's ECMAScript itself (ECMA-262's URI
// handling functions), so it is present in any conforming engine with no host bindings at all. It
// also decodes UTF-8 for free, which a hand-rolled base64 decoder would have had to do by hand —
// and this text is not ASCII: the server writes `…` when it truncates a line.
//
// Encoded output is a single argv-safe token either way: everything but `A-Za-z0-9-_.!~*'()` comes
// out percent-escaped, so there is no space, quote or backslash left for anything downstream to
// interpret. That was the property base64 was picked for, and it survives the swap.

/* The payload shape lives HERE and nowhere else. It's Slack Block Kit under a thin envelope:
 *
 *   yeet.alert({ method: "slack", channel: "#alerts", text: "…", blocks: […] })
 *
 * `text` is the fallback and is what a notification preview shows, so it has to stand alone.
 * `blocks` is the rich version. Documented at
 * https://yeet.cx/docs/scripts/yeet-global#yeet-alert — `slack` is currently the only method.
 *
 * The server builds the whole object and this passes it through untouched, so adding a method
 * or a field is a change in server/alerts.js and not a change here. */
function decode(raw) {
  return JSON.parse(decodeURIComponent(String(raw)));
}

/* Report and leave, deferring the exit past the flush — a console line written in the same
 * turn as `yeet.exit()` can lose the race with the teardown and vanish. Same reasoning as
 * `die()` in logstream.js. */
function say(obj) {
  console.log(JSON.stringify(obj));
  setTimeout(() => yeet.exit(), 50);
}

const raw = yeet.args.payload ?? yeet.args._?.[0];
if (!raw) {
  say({ t: "error", error: "--payload is required" });
} else {
  let payload;
  try {
    payload = decode(raw);
  } catch (err) {
    say({ t: "error", error: `payload did not decode: ${err?.message ?? err}` });
    payload = null;
  }
  if (payload) {
    /* The rejection cases worth naming, because they read very differently to an operator:
     * not logged in (no access token), Slack never connected at yeet.cx/settings, or the
     * channel doesn't exist / the app isn't in it. All three arrive as a rejected promise
     * with the platform's own JSON, so it goes out verbatim rather than being flattened into
     * a generic "alert failed" — the server puts this string in front of a person. */
    yeet.alert(payload).then(
      (result) => say({ t: "sent", result: result ?? null }),
      (err) => say({ t: "error", error: detail(err) }),
    );
  }
}

/** A rejection can be an Error, a string, or the platform's JSON body. Keep whichever of
 *  those actually carries the reason, and never print "[object Object]" at an operator. */
function detail(err) {
  if (err == null) return "alert rejected with no reason";
  if (typeof err === "string") return err;
  if (err.message) return String(err.message);
  try { return JSON.stringify(err); } catch { return String(err); }
}
