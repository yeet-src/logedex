import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createAuth, ownerKind, parseLoginUrl, parseOwnerId, stripAnsi } from "./auth.js";

const URL_ = "https://yeet.cx/login/device?code=ABCD-1234";

// ── scraping another program's output ───────────────────────────────────────
/* The URL is read out of `yeet login`'s human-readable banner, which is the kind of
 * coupling that breaks quietly — hence testing it on its own, with the decorations a
 * real terminal banner carries. */
test("finds the URL in a plain line", () => {
  assert.equal(parseLoginUrl(`Please login at: ${URL_}`), URL_);
});

test("finds it through ANSI decoration", () => {
  assert.equal(parseLoginUrl(`\x1b[1mPlease login at:\x1b[0m \x1b[4m${URL_}\x1b[0m`), URL_);
  assert.equal(parseLoginUrl(`\x1b]0;yeet\x07Please login at: ${URL_}`), URL_, "and through an OSC title");
});

test("finds it among other output", () => {
  const banner = `yeet 0.19.2\n\n  Please login at: ${URL_}\n\nwaiting…\n`;
  assert.equal(parseLoginUrl(banner), URL_);
});

test("trims punctuation a sentence would leave attached", () => {
  assert.equal(parseLoginUrl(`Please login at: <${URL_}>`), URL_);
  assert.equal(parseLoginUrl(`Please login at: "${URL_}".`), URL_);
});

test("returns null rather than a wrong answer", () => {
  for (const t of ["", null, undefined, "logging in…", "Please login at:", "error: not reachable"]) {
    assert.equal(parseLoginUrl(t), null, `should find nothing in ${JSON.stringify(t)}`);
  }
});

/* The owner id, same scrape-someone-else's-output problem. Every wrong answer here is
 * a plausible-looking string, so the failure mode is silent: whatever comes out gets
 * shown, or reported, as who you are. */
const WHOAMI = (owner) =>
  `\nCurrently logged in as:\n\nOwner ID: ${owner}\nHost ID: HOST-01KZ4753TGBGR2RBYQ7DGHBEC2\n\n`;

test("reads the owner id, both kinds of owner", () => {
  // An org-owned host is the common case; USER- is a personal one. Those are the two
  // kinds there are, and the id is one or the other.
  assert.equal(parseOwnerId(WHOAMI("ORG-01KK0CB0BZQ34FBTXCHSNK63NP")), "ORG-01KK0CB0BZQ34FBTXCHSNK63NP");
  assert.equal(parseOwnerId(WHOAMI("USER-01ABCDEFGHJKMNPQRS")), "USER-01ABCDEFGHJKMNPQRS");
});

test("the owner, not the banner around it", () => {
  assert.equal(parseOwnerId(WHOAMI("ORG-01KK0CB0BZQ34FBTXCHSNK63NP")).startsWith("Currently"), false);
  assert.equal(parseOwnerId("\x1b[1mOwner ID:\x1b[0m \x1b[4mORG-01KK0CB0BZQ34FBTXCHSNK63NP\x1b[0m"),
    "ORG-01KK0CB0BZQ34FBTXCHSNK63NP", "and through ANSI decoration");
});

test("never returns the host id as the owner", () => {
  // If the owner label is ever reworded, what's left must not resolve to the host —
  // and HOST- can't, because only USER-/ORG- are looked for at all.
  const reworded = "\nCurrently logged in as:\n\nHost ID: HOST-01KZ4753TGBGR2RBYQ7DGHBEC2\n";
  assert.equal(parseOwnerId(reworded), null);
});

test("only USER-/ORG- is an owner id, whatever the label says", () => {
  /* The labelled field is where the id lives, but being in that position is not what
   * makes a string an id. Anything else on that line is another of yeet's ids, or a
   * value it has started printing there, and reporting it as the owner would be wrong
   * in a way nothing downstream could notice. */
  for (const wrong of [
    "HOST-01KZ4753TGBGR2RBYQ7DGHBEC2",
    "ACCT-01KK0CB0BZQ34FBTXCHSNK63NP",
    "jacob@yeet.cx",
    "unknown",
    "-",
  ]) {
    assert.equal(parseOwnerId(`Owner ID: ${wrong}\n`), null, `${wrong} is not an owner id`);
  }
  // And the id is still found by shape when the label is the thing that changed.
  assert.equal(parseOwnerId("Signed in to: ORG-01KK0CB0BZQ34FBTXCHSNK63NP\n"),
    "ORG-01KK0CB0BZQ34FBTXCHSNK63NP");
});

test("returns null rather than prose that looks like an identity", () => {
  // whoami is only read after `whoami -q` exits 0, but the daemon can go away between
  // the two calls — and an error banner's second line is a sentence, not an id.
  const died = "\nError: Daemon Unavailable\n\nConnection Error: Connection refused (os error 111)\n";
  for (const t of ["", null, undefined, "Currently logged in as:\n\n", died]) {
    assert.equal(parseOwnerId(t), null, `should find no id in ${JSON.stringify(t)}`);
  }
});

test("ownerKind names the two kinds and nothing else", () => {
  assert.equal(ownerKind("ORG-01KK0CB0BZQ34FBTXCHSNK63NP"), "org");
  assert.equal(ownerKind("USER-01ABCDEFGHJKMNPQRS"), "user");
  for (const t of [null, undefined, "", "HOST-01KZ4753TGBGR2RBYQ7DGHBEC2", "ORGANISATION"]) {
    assert.equal(ownerKind(t), null, `${JSON.stringify(t)} names no kind of owner`);
  }
});

test("stripAnsi leaves ordinary text alone", () => {
  assert.equal(stripAnsi("Owner ID: USER-01ABC"), "Owner ID: USER-01ABC");
  assert.equal(stripAnsi("\x1b[32mok\x1b[0m"), "ok");
});

// ── the flow, with a fake yeet ──────────────────────────────────────────────
/** A stand-in child process. `script` decides what each yeet subcommand does. */
function fakeYeet(script) {
  const calls = [];
  const spawns = [];      // the same calls with the environment each was given
  const spawn = (_bin, args, opts) => {
    const sub = args.find((a) => !a.startsWith("--") && !["--socket", "--user-socket"].includes(a));
    calls.push(sub);
    spawns.push({ sub, env: opts?.env ?? {} });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => { child.killed = true; };
    queueMicrotask(() => script(sub, child));
    return child;
  };
  return { spawn, calls, spawns };
}

const settle = () => new Promise((r) => setTimeout(r, 5));

test("a logged-out box starts locked", async () => {
  const { spawn } = fakeYeet((sub, child) => child.emit("close", sub === "whoami" ? 1 : 0));
  const auth = createAuth({ spawn });
  await settle();
  assert.equal(auth.isLoggedIn(), false);
  assert.equal(auth.state().required, true);
  auth.stop();
});

test("a logged-in box starts unlocked, and reports who", async () => {
  const { spawn } = fakeYeet((sub, child) => {
    if (sub === "whoami") {
      child.stdout.emit("data", "Currently logged in as:\n\nOwner ID: USER-01ABC\nHost ID: HOST-02XYZ\n");
      child.emit("close", 0);
    } else child.emit("close", 0);
  });
  const auth = createAuth({ spawn });
  await settle();
  assert.equal(auth.isLoggedIn(), true);
  assert.equal(auth.state().identity, "USER-01ABC", "the owner, not the first line of the banner");
  auth.stop();
});

test("startLogin resolves with the URL as soon as it's printed", async () => {
  const { spawn } = fakeYeet((sub, child) => {
    if (sub === "whoami") return child.emit("close", 1);
    // Split across chunks, as a real pipe would deliver it.
    child.stdout.emit("data", "Please login ");
    child.stdout.emit("data", `at: ${URL_}\n`);
    // and then it blocks, waiting for the browser — no close event
  });
  const auth = createAuth({ spawn });
  await settle();
  assert.deepEqual(await auth.startLogin(), { url: URL_ });
  assert.equal(auth.state().loginPending, true);
  auth.stop();
});

/* Two tabs, or a reload mid-flow, must not each spawn their own `yeet login` — the
 * second would race the first for the same device code. */
test("concurrent callers join the one login already running", async () => {
  const { spawn, calls } = fakeYeet((sub, child) => {
    if (sub === "whoami") return child.emit("close", 1);
    child.stdout.emit("data", `Please login at: ${URL_}\n`);
  });
  const auth = createAuth({ spawn });
  await settle();
  const [a, b, c] = await Promise.all([auth.startLogin(), auth.startLogin(), auth.startLogin()]);
  assert.deepEqual([a, b, c], [{ url: URL_ }, { url: URL_ }, { url: URL_ }]);
  assert.equal(calls.filter((s) => s === "login").length, 1);
  auth.stop();
});

test("an already-logged-in box short-circuits startLogin", async () => {
  const { spawn, calls } = fakeYeet((sub, child) => child.emit("close", 0));
  const auth = createAuth({ spawn });
  await settle();
  assert.deepEqual(await auth.startLogin(), { loggedIn: true });
  assert.equal(calls.includes("login"), false, "no login is spawned");
  auth.stop();
});

test("a login that exits without a URL reports an error", async () => {
  const { spawn } = fakeYeet((sub, child) => {
    if (sub === "whoami") return child.emit("close", 1);
    child.stderr.emit("data", "could not reach the control plane\n");
    child.emit("close", 1);
  });
  const auth = createAuth({ spawn });
  await settle();
  const r = await auth.startLogin();
  assert.ok(r.error, "an error, not a url");
  assert.equal(r.url, undefined);
  auth.stop();
});

/* The completion path: the child exits 0 once the browser flow finishes, and the
 * gate has to notice without anyone asking it to. */
test("completing the flow unlocks the gate", async () => {
  let loggedIn = false;
  let loginChild = null;
  const { spawn } = fakeYeet((sub, child) => {
    if (sub === "whoami") return child.emit("close", loggedIn ? 0 : 1);
    loginChild = child;
    child.stdout.emit("data", `Please login at: ${URL_}\n`);
  });
  const auth = createAuth({ spawn });
  await settle();
  await auth.startLogin();
  assert.equal(auth.isLoggedIn(), false);

  loggedIn = true;                 // the user authorises in their browser
  loginChild.emit("close", 0);
  await settle();
  assert.equal(auth.isLoggedIn(), true);
  assert.equal(auth.state().loginPending, false);
  auth.stop();
});

test("a spawn that throws is an error, not a crash", async () => {
  const auth = createAuth({ spawn: () => { throw new Error("ENOENT"); } });
  await settle();
  assert.equal(auth.isLoggedIn(), false);
  const r = await auth.startLogin();
  assert.match(r.error, /ENOENT/);
  auth.stop();
});

test("required:false is unlocked without ever running yeet", async () => {
  const { spawn, calls } = fakeYeet((sub, child) => child.emit("close", 1));
  const auth = createAuth({ spawn, required: false });
  await settle();
  assert.equal(auth.isLoggedIn(), true);
  assert.deepEqual(calls, [], "nothing spawned at all");
  assert.equal(auth.state().required, false);
  auth.stop();
});

/* The polled `whoami` is this server's own bookkeeping, not somebody using yeet. Left
 * counted, one dashboard open all day would arrive in yeet's analytics as hundreds of
 * `whoami` invocations and bury the real ones in the same account. `login` is exempt
 * on purpose — a person clicked a button, and that is a real event. */
test("the whoami poll is kept out of yeet's own analytics", async () => {
  const { spawn, spawns } = fakeYeet((sub, child) => {
    if (sub === "login") child.stdout.emit("data", `Please login at: ${URL_}\n`);
    else child.emit("close", 1);
  });
  const auth = createAuth({ spawn });
  await settle();
  await auth.startLogin();

  const whoami = spawns.filter((s) => s.sub === "whoami");
  assert.ok(whoami.length > 0, "whoami did run");
  for (const s of whoami) {
    assert.equal(s.env.YEET_NO_ANALYTICS, "1", "every whoami opts out");
    assert.equal(s.env.NO_COLOR, "1", "and still asks for parseable output");
  }
  const login = spawns.filter((s) => s.sub === "login");
  assert.equal(login.length, 1);
  assert.equal(login[0].env.YEET_NO_ANALYTICS, undefined, "a real sign-in is still counted");
  auth.stop();
});

/* The re-check cadence, which is about spawn cost rather than correctness: a signed-in box
 * has nothing to wait for, so it must not keep paying for a `whoami` every ten seconds
 * while somebody reads logs all afternoon. A locked one does, because a login completed
 * elsewhere is exactly what it's watching for. */
test("a signed-in box re-checks once a minute; a locked one keeps watching", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  // The fake yeet resolves through microtasks, so the promise chain between one check and
  // the next has to be drained by hand — the clock is frozen and settle() can't help.
  const drain = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

  let signedIn = true;
  const { spawn, calls } = fakeYeet((sub, child) => {
    if (sub === "whoami") {
      child.stdout.emit("data", "Owner ID: USER-01ABCDEFGHJKMNPQRS\n");
      child.emit("close", signedIn ? 0 : 1);
    } else child.emit("close", 0);
  });
  const auth = createAuth({ spawn });
  await drain();
  assert.equal(auth.isLoggedIn(), true);

  const so_far = () => calls.filter((s) => s === "whoami").length;
  const primed = so_far();
  assert.ok(primed >= 1, "primed on boot");

  t.mock.timers.tick(30_000);
  await drain();
  assert.equal(so_far(), primed, "half a minute in, it has not re-checked");

  t.mock.timers.tick(31_000);
  await drain();
  const afterMinute = so_far();
  assert.ok(afterMinute > primed, "and it does at the minute");

  // Now log the box out. The next answer is "locked", which puts the loop back on the
  // fast cadence — ten seconds, not another minute.
  signedIn = false;
  t.mock.timers.tick(60_000);
  await drain();
  assert.equal(auth.isLoggedIn(), false);
  const atLockout = so_far();

  t.mock.timers.tick(11_000);
  await drain();
  assert.ok(so_far() > atLockout, "locked, it goes back to checking often");
  auth.stop();
});
