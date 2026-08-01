// The login gate, backed by the yeet CLI.
//
// The dashboard is gated on whether THIS yeet instance is logged in — `yeet whoami`
// resolving — rather than on a password of its own. That's the same door the rest of
// the tooling uses, so signing in here is signing in to yeet, and there's no second
// credential to invent, store, rotate or leak.
//
// The browser drives a device-style flow: `yeet login` prints `Please login at: <url>`
// and then blocks until the flow completes, so the server scrapes that URL, hands it
// to the page, and polls `whoami` until it resolves.
//
// HOST-LEVEL, NOT PER-VISITOR. This asks "is this box logged in", not "who are you" —
// so the first visitor to complete the flow unlocks the dashboard for everyone who can
// reach it. That is the intended shape rather than a shortcut: the gate exists to make
// using the tool mean signing in to yeet, and it is emphatically not a security
// boundary. Every `/api/*` route stays open, and the yeet daemon underneath answers
// without any of this — so if the logs themselves need protecting, that's a network
// boundary (a tailnet, a VPN, a proxy with real auth) and this changes nothing about
// whether you need one.
//
// Only the box you point a browser at needs to be logged in. The boxes it fans out to
// are reached over their own API, which this does not cover, so they can stay signed
// out and still serve the hub.

import { spawn as nodeSpawn } from "node:child_process";

/* The login banner is full of escape sequences, and the URL has to come out of it
 * clean — a scraped `\x1b[4mhttps://…\x1b[0m` is not a link anyone can open. */
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
export const stripAnsi = (s) => String(s ?? "").replace(ANSI, "");

const LOGIN_URL_RE = /Please login at:\s*(\S+)/i;

/** Pull the verification URL out of whatever `yeet login` has printed so far.
 *  Exported for its own test: this is a scrape of another program's human-readable
 *  output, which is exactly the kind of thing that breaks quietly. */
export function parseLoginUrl(text) {
  const m = LOGIN_URL_RE.exec(stripAnsi(text));
  if (!m) return null;
  // Trailing punctuation from a sentence, and the quotes some terminals add.
  return m[1].replace(/^["'<]+|["'>.,)]+$/g, "") || null;
}

const OWNER_ID_RE = /^\s*Owner ID:\s*(\S+)/im;

/* An owner id is `USER-<ulid>` or `ORG-<ulid>`, and this only ever returns one of those
 * two shapes.
 *
 * The owner is whoever the host is registered to: ORG- when an organisation owns it,
 * USER- for a personal one. Those are the only two kinds there are, so the prefix is
 * part of what makes a string an owner id rather than incidental decoration on it —
 * which means it's also the check that separates the id from everything else in this
 * banner. `whoami` prints prose ("Currently logged in as:"), a HOST- id on the next
 * line, and, when the daemon has gone away between the gate's `whoami -q` and this
 * call, an error and a bare connection message instead of any of it. Every one of those
 * is a plausible-looking wrong answer, and a wrong answer here is shown as who you are
 * and reported as who you are.
 *
 * So: no positional guessing, and no generic id-shaped scan either. This used to fall
 * back to `[A-Z]+-[A-Z0-9]{8,}` with the `Host ID:` line stripped out first to stop it
 * returning the host as the owner — a scan that had to be told what not to match is one
 * that will match the next id-shaped thing yeet decides to print. Anchoring on the two
 * real prefixes needs no exclusions: HOST- fails it by construction.
 *
 * Two patterns, then, differing only in how much they demand beyond the prefix, because
 * the two uses below know different amounts. On the labelled field the prefix is the whole
 * question — the label has already said this is the owner, so all that's left is whether
 * the value is an owner id or some other thing that has been put there. A bare scan has no
 * label vouching for it, so it also wants the id to be id-LENGTH: without that floor,
 * `ORG-A` in a sentence is a match, and prose is exactly what the fallback is reading. A
 * real id is a 26-character ULID, so eight is well clear of both. */
const OWNER_ID_SHAPE = /^(?:USER|ORG)-[0-9A-Z]+$/;
const OWNER_ID_SCAN = /\b(?:USER|ORG)-[0-9A-Z]{8,}\b/;

/** The owner id out of `yeet whoami`'s banner, or null. Exported for its own test, same
 *  reasoning as parseLoginUrl — this is a scrape of another program's human-readable
 *  output, which is the kind of coupling that breaks quietly. */
export function parseOwnerId(text) {
  const clean = stripAnsi(text);
  // The labelled field, but only if what's on it is actually an owner id. A label that
  // has been reworded to carry something else must not smuggle that something else out
  // of here just for being in the right place.
  const labelled = OWNER_ID_RE.exec(clean)?.[1];
  if (labelled && OWNER_ID_SHAPE.test(labelled)) return labelled;
  // And if the label itself is ever reworded, the id is still recognisable on its own.
  return OWNER_ID_SCAN.exec(clean)?.[0] ?? null;
}

/** Which kind of owner an id names, or null if it isn't one. The prefix is the whole
 *  answer — see the note above — and it's worth having separately because "personal box"
 *  and "org's box" are different situations to be looking at a fleet from. */
export function ownerKind(id) {
  const m = /^(USER|ORG)-/.exec(String(id ?? ""));
  return m ? m[1].toLowerCase() : null;
}

/* How often the background re-check runs, at the two cadences it has — because the two
 * states are waiting for opposite things.
 *
 * LOCKED, it is waiting for news, and the news can arrive from outside this process: a
 * login completed in another tab, or `yeet login` run by hand in a terminal, unlocks the
 * dashboard without anybody clicking anything here. Ten seconds is how long that takes to
 * notice, and a locked dashboard is worth checking on often.
 *
 * SIGNED IN, there is nothing to wait for. The state only changes when a token expires or
 * someone runs `yeet logout`, which is rare and not urgent — the gate goes up on the next
 * check either way. So the fast cadence bought nothing and cost a `yeet whoami -q` spawn
 * every ten seconds for as long as the dashboard was left open, which on a box whose whole
 * job is to sit there with panes attached is all day.
 *
 * The gate's own responsiveness doesn't come from this loop at all: the browser polls
 * `/api/auth` every two seconds while a login is actually in flight, and stops the moment
 * it clears. This is the out-of-band case only. */
const REFRESH_MS = 10_000;              // locked: watching for a login we didn't start
const REFRESH_SIGNED_IN_MS = 60_000;    // in: watching for a logout that probably isn't coming
const URL_TIMEOUT_MS = 20_000;  // how long to wait for `yeet login` to print anything

/**
 * @param {object} cfg
 * @param {string} cfg.yeetBin
 * @param {string} [cfg.socket]
 * @param {string} [cfg.userSocket]
 * @param {boolean} [cfg.required]  false disables the gate entirely
 * @param {Function} [cfg.spawn]    injectable, so the flow can be tested without yeet
 */
export function createAuth({ yeetBin = "yeet", socket, userSocket, required = true, spawn = nodeSpawn } = {}) {
  const globalArgs = [];
  if (socket) globalArgs.push("--socket", socket);
  if (userSocket) globalArgs.push("--user-socket", userSocket);
  const run = (args, stdio, env) => spawn(yeetBin, [...globalArgs, ...args], {
    stdio, env: { ...process.env, NO_COLOR: "1", ...env },
  });

  /* `whoami` is on a timer, and a timer is a very different thing to yeet's own analytics
   * than a person typing a command. Every check this server makes would arrive there as a
   * usage event, so one dashboard left open all day looks like someone running `whoami`
   * hundreds of times — which isn't wrong so much as meaningless, and it drowns the real
   * invocations in the same account.
   *
   * Only on the polled calls. `yeet login` below runs once, because a person clicked a
   * button, and that IS a real event: suppressing it would be hiding a genuine sign-in
   * rather than declining to manufacture traffic. */
  const NO_ANALYTICS = { YEET_NO_ANALYTICS: "1" };

  let loggedIn = false;
  let identity = null;
  let loginProc = null;      // the in-flight `yeet login`, if any
  let loginUrl = null;       // its scraped URL, once printed
  let loginError = null;
  let urlPromise = null;     // shared by concurrent callers, so one flow runs at a time
  let timer = null;

  /** `yeet whoami -q` exits 0 when logged in. Nothing is parsed — an exit code can't
   *  be broken by a change to the banner's wording. */
  const whoamiQuiet = () => new Promise((resolve) => {
    let c;
    try { c = run(["whoami", "-q"], "ignore", NO_ANALYTICS); } catch { return resolve(false); }
    c.on("error", () => resolve(false));
    c.on("close", (code) => resolve(code === 0));
  });

  /** The `Owner ID: …` line, for showing who the box is signed in as. Best effort:
   *  a missing name costs a label, never the gate — so no id beats a wrong id. */
  const whoamiName = () => new Promise((resolve) => {
    let out = "";
    let c;
    try { c = run(["whoami"], ["ignore", "pipe", "ignore"], NO_ANALYTICS); } catch { return resolve(null); }
    c.stdout.on("data", (d) => (out += d));
    c.on("error", () => resolve(null));
    c.on("close", () => resolve(parseOwnerId(out)));
  });

  async function refresh() {
    if (!required) { loggedIn = true; return false; }
    const was = loggedIn;
    loggedIn = await whoamiQuiet();
    if (loggedIn && !identity) identity = await whoamiName();
    if (!loggedIn) identity = null;
    return loggedIn !== was;
  }

  /* The re-check loop. A self-rescheduling timeout rather than an interval, because the
   * cadence depends on the answer the last check gave — see the note by the two constants.
   *
   * Rearmed AFTER the check resolves, so the gap is between checks rather than between
   * starts: a `whoami` against a daemon that has gone away can sit there for a while, and
   * an interval would stack a second spawn on top of the first. */
  function scheduleRefresh() {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      await refresh();
      scheduleRefresh();
    }, loggedIn ? REFRESH_SIGNED_IN_MS : REFRESH_MS);
    timer.unref?.();
  }

  /**
   * Begin a login, or join the one already running. Resolves once the URL is known —
   * NOT once the login completes, because the caller is a browser waiting to be told
   * where to send the user. Completion is observed by polling `state()`.
   */
  function startLogin() {
    if (loggedIn) return Promise.resolve({ loggedIn: true });
    if (urlPromise) return urlPromise;

    loginError = null;
    loginUrl = null;
    let child;
    try {
      child = run(["login"], ["ignore", "pipe", "pipe"]);
    } catch (err) {
      loginError = `could not run ${yeetBin}: ${err.message}`;
      return Promise.resolve({ error: loginError });
    }
    loginProc = child;

    urlPromise = new Promise((resolve) => {
      let buf = "";
      let settled = false;
      const done = (v) => { if (!settled) { settled = true; resolve(v); } };

      // The URL can arrive on either stream, and possibly split across chunks — hence
      // scanning the accumulated buffer rather than each chunk on its own.
      const scan = (d) => {
        buf += d.toString();
        const url = parseLoginUrl(buf);
        if (url) { loginUrl = url; done({ url }); }
      };
      child.stdout?.on("data", scan);
      child.stderr?.on("data", scan);

      const t = setTimeout(() => done({ error: "timed out waiting for the login URL" }), URL_TIMEOUT_MS);

      child.on("error", (err) => { loginError = String(err.message ?? err); done({ error: loginError }); });
      child.on("close", (code) => {
        clearTimeout(t);
        loginProc = null;
        loginUrl = null;
        urlPromise = null;              // a later attempt starts fresh
        // Completed — whoami will now resolve, and the loop drops to the signed-in
        // cadence rather than running out the fast gap it is currently waiting on.
        if (code === 0) refresh().then(scheduleRefresh);
        else if (!loggedIn) loginError = "login did not complete";
        done({ error: loginError || "login exited before printing a URL" });
      });
    });
    return urlPromise;
  }

  const state = () => ({
    required, loggedIn, identity,
    // Derived, not parsed a second time: whatever `identity` is, this says which of the
    // two kinds of owner it names — and it is null exactly when `identity` is null.
    identityKind: ownerKind(identity),
    loginUrl, loginPending: Boolean(loginProc), error: loginError,
  });

  if (required) {
    // Primed and polled in the background so request handlers never wait on a spawn,
    // and so a login completed in another tab (or by `yeet login` in a terminal) unlocks
    // this one without anybody clicking anything. The loop is armed from the FIRST
    // answer, so a box that is already signed in never runs the fast cadence at all.
    refresh().then(scheduleRefresh);
  } else {
    loggedIn = true;
  }

  return {
    isLoggedIn: () => loggedIn,
    refresh,
    startLogin,
    state,
    stop() {
      clearTimeout(timer);
      try { loginProc?.kill("SIGTERM"); } catch { /* already gone */ }
    },
  };
}
