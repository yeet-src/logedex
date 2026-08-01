// Alerting, tested without a daemon, a container or a Slack workspace.
//
// Three things here are worth pinning down, and they're the three that fail silently:
//
//   · WHAT GETS REFUSED. A pattern that backtracks catastrophically must never reach the matcher,
//     and the check for it must not itself hang — the first version of that check did exactly that
//     (see server/redos.js), which is why there's a test that asserts it returns at all.
//   · WHEN AN ALERT IS *NOT* SENT. The cooldown, and lines that predate the rule. Both failures are
//     invisible in the good case and look like spam in the bad one.
//   · THAT A RULE SURVIVES A RESTART. The whole feature is worth nothing if it doesn't.
//
// The seams: `exec` stands in for running `yeet`, and `localLogs`/`remoteLogs` stand in for the log
// streams. Both are injected the same way auth.js injects `spawn`.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAlerts } from "./alerts.js";
import { checkPattern } from "./redos.js";
import { COOLDOWN_DEFAULT_SEC, normalizeRule, shouldFire } from "../shared/alertrule.js";

const HOSTS = { local: { id: "local", label: "this box", url: null }, web1: { id: "web1", label: "web-01", url: "http://web-01:8080" } };

/** A rig with fake streams and a fake `yeet`. `feed` pushes a log line at a watch; `sent` is every
 *  payload that reached the delivery isolate. */
async function rig({ file = null, rules = [], contextWaitMs } = {}) {
  const sent = [];
  const emitters = new Map();      // `hostId|container` → onEvent
  const detached = [];

  const exec = async (_bin, args) => {
    const i = args.indexOf("--payload");
    if (i >= 0) {
      sent.push(JSON.parse(decodeURIComponent(args[i + 1])));
      return { exitCode: 0, stdout: `${JSON.stringify({ t: "sent", result: { ok: true } })}\n`, stderr: "" };
    }
    // Anything else is the caps probe.
    return { exitCode: 0, stdout: `${JSON.stringify({ t: "caps", providers: ["slack"] })}\n`, stderr: "" };
  };

  const track = (key, onEvent) => {
    emitters.set(key, onEvent);
    return () => { emitters.delete(key); detached.push(key); };
  };

  const alerts = createAlerts({
    yeetBin: "yeet", alertScript: "/agent/alert.js", capsScript: "/agent/caps.js",
    file, exec, contextWaitMs,
    host: (id) => HOSTS[id] ?? null,
    localLogs: (req, onEvent) => track(`local|${req.container}`, onEvent),
    remoteLogs: (host, container, _win, onEvent) => track(`${host.id}|${container}`, onEvent),
  });

  for (const r of rules) {
    const out = await alerts.save(r);
    assert.ok(!out.error, `rule "${r.name}" should save: ${out.error}`);
  }

  /* A log line, stamped NOW by default. The default matters: the freshness check discards anything
   * older than the watch, so a test that used a fixed past timestamp would silently assert nothing. */
  const feed = (key, message, ts = new Date().toISOString()) => {
    const onEvent = emitters.get(key);
    assert.ok(onEvent, `nothing is watching ${key} — watches: ${[...emitters.keys()].join(", ") || "none"}`);
    onEvent({ t: "log", stream: "stdout", ts, message });
  };
  const status = (key, state, error = null) => emitters.get(key)?.({ t: "status", state, error });
  /** Delivery is fire-and-forget inside `consider`, so tests need one turn for it to land. */
  const settle = () => new Promise((r) => setImmediate(r));

  return { alerts, sent, feed, status, settle, emitters, detached };
}

/* The base fixture opts OUT of context. A rule with context waits for the lines after the match
 * before sending (up to `contextWaitMs`), which is correct and is tested on its own below — but every
 * test about matching, cooldowns or delivery would otherwise be a test about that timer too. The
 * default value itself is asserted separately. */
const RULE = {
  name: "api errors", pattern: "ERROR|FATAL", channel: "#alerts",
  targets: [{ hostId: "local", container: "api" }], contextLines: 0,
};

// ── what gets refused ───────────────────────────────────────────────────────
/* The regression this exists for: the canary used to run the pattern on the calling thread, so
 * checking `(a+)+$` hung the server for 2^24 steps instead of refusing it. The assertion that
 * matters is not just "refused" but "answered at all, quickly". */
test("a catastrophically backtracking pattern is refused, and the check returns", async () => {
  const started = Date.now();
  const out = await checkPattern("(a+)+$", "");
  const took = Date.now() - started;
  assert.ok(out.error, "should be refused");
  assert.match(out.error, /backtracks too heavily/);
  assert.ok(took < 3000, `the check itself must not hang — took ${took}ms`);
});

test("an ordinary pattern passes the canary", async () => {
  for (const p of ["ERROR|FATAL", "^\\s*panic:", "timeout after \\d+ms", "OOMKilled"]) {
    const out = await checkPattern(p, "i");
    assert.ok(out.ok, `${p} should pass: ${out.error}`);
  }
});

test("a pattern that isn't a regex at all is refused by the cheap check", () => {
  const out = normalizeRule({ ...RULE, pattern: "(unclosed" });
  assert.match(out.error, /not a valid regex/);
});

test("stateful flags are refused, because a shared regex would skip every other line", () => {
  for (const flags of ["g", "gi", "y"]) {
    assert.match(normalizeRule({ ...RULE, flags }).error, /is not allowed/);
  }
  assert.ok(normalizeRule({ ...RULE, flags: "ims" }).rule, "i, m and s are fine");
});

test("a rule has to say what it watches", () => {
  assert.match(normalizeRule({ ...RULE, targets: [] }).error, /at least one container/);
  assert.match(normalizeRule({ ...RULE, targets: [{ hostId: "local" }] }).error, /hostId and a container/);
  assert.match(normalizeRule({ ...RULE, targets: [{ hostId: "local", container: "../etc" }] }).error,
    /not a valid container name/);
});

test("a rule naming a host that isn't in the list is refused", async () => {
  const { alerts } = await rig();
  const out = await alerts.save({ ...RULE, targets: [{ hostId: "nope", container: "api" }] });
  assert.equal(out.error, "no such host: nope");
});

/* A merged pane can be assembled in any order, and the same set must be the same rule — otherwise
 * "add an alert to this pane" produces a second, duplicate rule depending on click order. */
test("targets are de-duplicated and ordered, so one set is one rule", () => {
  const { rule } = normalizeRule({
    ...RULE,
    targets: [
      { hostId: "web1", container: "api" },
      { hostId: "local", container: "api" },
      { hostId: "web1", container: "api" },
    ],
  });
  assert.deepEqual(rule.targets, [
    { hostId: "local", container: "api" },
    { hostId: "web1", container: "api" },
  ]);
});

test("cooldown defaults, and is bounded", () => {
  assert.equal(normalizeRule(RULE).rule.cooldownSec, COOLDOWN_DEFAULT_SEC);
  assert.equal(normalizeRule({ ...RULE, cooldownSec: 0 }).rule.cooldownSec, 0);
  assert.match(normalizeRule({ ...RULE, cooldownSec: -1 }).error, /whole number/);
  assert.match(normalizeRule({ ...RULE, cooldownSec: 1.5 }).error, /whole number/);
  assert.match(normalizeRule({ ...RULE, cooldownSec: 999_999 }).error, /at most/);
});

// ── matching ────────────────────────────────────────────────────────────────
test("a matching line sends one alert, carrying the line and where it came from", async () => {
  const { sent, feed, settle } = await rig({ rules: [RULE] });
  feed("local|api", "2026-08-03 db connect ERROR timeout");
  await settle();

  assert.equal(sent.length, 1);
  const p = sent[0];
  assert.equal(p.method, "slack");
  assert.equal(p.channel, "#alerts");
  assert.match(p.text, /api errors/);
  assert.match(p.text, /this box\/api/, "the fallback text has to stand alone in a notification");
  assert.match(p.text, /ERROR timeout/);
  assert.match(p.blocks[0].text.text, /api errors/, "the header names the rule");
  assert.ok(JSON.stringify(p.blocks).includes("ERROR|FATAL"), "the pattern belongs in the message");
});

/* Slack answers `invalid_blocks` and drops the WHOLE message if any block is over its limit, so an
 * absurd host label or a container logging a JSON document must cost the end of a string and not
 * the alert. */
test("every block stays inside Slack's limits, however long the line", async () => {
  const HOSTS_BIG = { big: { id: "big", label: "x".repeat(4000), url: null } };
  const sent = [];
  let emit;
  const alerts = createAlerts({
    yeetBin: "yeet", alertScript: "/a.js", capsScript: "/c.js", file: null,
    exec: async (_b, args) => {
      const i = args.indexOf("--payload");
      if (i >= 0) sent.push(JSON.parse(decodeURIComponent(args[i + 1])));
      return { exitCode: 0, stdout: `${JSON.stringify({ t: i >= 0 ? "sent" : "caps", providers: ["slack"] })}\n`, stderr: "" };
    },
    host: (id) => HOSTS_BIG[id] ?? null,
    localLogs: (_req, onEvent) => { emit = onEvent; return () => {}; },
    remoteLogs: () => () => {},
  });
  await alerts.save({ ...RULE, name: "n".repeat(80), targets: [{ hostId: "big", container: "api" }] });
  emit({ t: "log", ts: new Date().toISOString(), message: `ERROR ${"y".repeat(50_000)}` });
  await new Promise((r) => setImmediate(r));

  assert.equal(sent.length, 1);
  const p = sent[0];
  assert.ok(p.text.length <= 3000, `fallback text ${p.text.length}`);
  for (const b of p.blocks) {
    if (b.type === "header") assert.ok(b.text.text.length <= 150, `header ${b.text.text.length}`);
    if (b.text) assert.ok(b.text.text.length <= 3000, `section ${b.text.text.length}`);
    for (const f of b.fields ?? []) assert.ok(f.text.length <= 2000, `field ${f.text.length}`);
  }
});

test("a non-matching line sends nothing", async () => {
  const { sent, feed, settle } = await rig({ rules: [RULE] });
  feed("local|api", "GET /health 200");
  await settle();
  assert.equal(sent.length, 0);
});

test("one rule over several containers watches each of them", async () => {
  const { emitters, sent, feed, settle } = await rig({
    rules: [{
      ...RULE,
      targets: [{ hostId: "local", container: "api" }, { hostId: "web1", container: "api" }],
    }],
  });
  assert.deepEqual([...emitters.keys()].sort(), ["local|api", "web1|api"]);

  feed("web1|api", "FATAL out of memory");
  await settle();
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /web-01\/api/, "the alert names the host whose line matched");
});

test("two rules on one container share a single stream", async () => {
  const { emitters, sent, feed, settle } = await rig({
    rules: [RULE, { ...RULE, name: "panics", pattern: "panic:" }],
  });
  assert.equal(emitters.size, 1, "one watch, not one per rule");
  feed("local|api", "ERROR and panic: both");
  await settle();
  assert.equal(sent.length, 2, "both rules match the line, so both fire");
});

// ── ANSI ────────────────────────────────────────────────────────────────────
/* Plenty of things colour their output whether or not anyone is watching, and docker passes the
 * bytes through — so a "red ERROR" line literally begins with an escape. Two consequences, both
 * tested: an anchored pattern must still match, and Slack must not receive escape bytes. */
test("escapes are stripped before matching, so an anchored pattern still works", async () => {
  const { sent, feed, settle } = await rig({ rules: [{ ...RULE, pattern: "^ERROR" }] });
  feed("local|api", "[31mERROR[0m db timeout");
  await settle();
  assert.equal(sent.length, 1, "^ERROR has to match a line that starts with a colour escape");
});

/* An 8-bit CSI (0x9b) is one byte meaning ESC+[. Nothing about the residue it leaves looks like an
 * unhandled escape form — it looks like the stripping half-worked — which is how `33mWARN` reached a
 * real Slack alert. */
test("an 8-bit CSI is stripped too, parameters and all", async () => {
  const CSI8 = String.fromCharCode(0x9b);
  const { sent, feed, settle } = await rig({ rules: [RULE] });
  feed("local|api", `${CSI8}33mERROR${CSI8}0m api-02 dropping stale message, age 1971ms`);
  await settle();
  const json = JSON.stringify(sent[0]);
  assert.ok(!json.includes("33m"), `no parameter residue:\n${json}`);
  assert.match(json, /ERROR api-02 dropping stale message/);
});

/* A MALFORMED sequence leaves its introducer behind — the parser only removes well-formed ones. The
 * browser tolerates that (an invisible character costs nothing); Slack renders it as garbage. */
test("control bytes from malformed sequences don't reach Slack", async () => {
  const ESC = String.fromCharCode(0x1b);
  const CSI8 = String.fromCharCode(0x9b);
  const { sent, feed, settle } = await rig({ rules: [RULE] });
  feed("local|api", `ERROR ${ESC}33 and ${CSI8}44 unterminated and a trailing ${ESC}`);
  await settle();
  const text = sent[0].blocks.find((b) => b.text?.text?.includes("ERROR")).text.text;
  assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text), `control byte survived: ${JSON.stringify(text)}`);
});

test("the alert carries no escape bytes", async () => {
  const { sent, feed, settle } = await rig({ rules: [RULE] });
  feed("local|api", "[1;31mERROR[0m [2mdetail[0m");
  await settle();
  const json = JSON.stringify(sent[0]);
  assert.ok(!json.includes("\\u001b"), "no raw escapes should reach Slack");
  assert.match(json, /ERROR detail/, "and the text itself survives");
});

// ── context around the match ────────────────────────────────────────────────
test("context lines either side are included, with the match marked", async () => {
  const { sent, feed, settle } = await rig({ rules: [{ ...RULE, contextLines: 2 }], contextWaitMs: 20 });
  feed("local|api", "one before that");
  feed("local|api", "the line just before");
  feed("local|api", "ERROR the match");
  feed("local|api", "the line just after");
  feed("local|api", "one after that");
  await settle();

  assert.equal(sent.length, 1);
  const block = sent[0].blocks.find((b) => b.text?.text?.includes("ERROR the match"));
  const excerpt = block.text.text;
  for (const want of ["one before that", "the line just before", "the line just after", "one after that"]) {
    assert.ok(excerpt.includes(want), `excerpt should carry "${want}":\n${excerpt}`);
  }
  assert.match(excerpt, /▶ ERROR the match/, "the matching line is marked");
  // Order has to be before → match → after, or the excerpt reads as a different incident.
  assert.ok(excerpt.indexOf("the line just before") < excerpt.indexOf("▶ ERROR"), "before comes first");
  assert.ok(excerpt.indexOf("▶ ERROR") < excerpt.indexOf("the line just after"), "after comes last");
});

/* The matching line must never end up in its own before-context — an off-by-one here reads as the
 * error happening twice. */
test("the matching line appears once", async () => {
  const { sent, feed, settle } = await rig({ rules: [{ ...RULE, contextLines: 3 }], contextWaitMs: 20 });
  feed("local|api", "ERROR only once");
  await new Promise((r) => setTimeout(r, 40));
  await settle();
  const excerpt = sent[0].blocks.find((b) => b.text?.text?.includes("ERROR only once")).text.text;
  assert.equal(excerpt.split("ERROR only once").length - 1, 1);
});

/* A container that logs an error and dies never produces the after-context. The alert has to go
 * anyway, which is what the wait timeout is for. */
test("the alert is sent with what it has when the after-context never arrives", async () => {
  const { sent, feed, settle } = await rig({ rules: [{ ...RULE, contextLines: 5 }], contextWaitMs: 20 });
  feed("local|api", "before the end");
  feed("local|api", "FATAL and then silence");
  await settle();
  assert.equal(sent.length, 0, "still waiting for the lines after it");

  await new Promise((r) => setTimeout(r, 40));
  assert.equal(sent.length, 1, "the wait ran out, so it sent what it had");
  const excerpt = sent[0].blocks.find((b) => b.text?.text?.includes("FATAL")).text.text;
  assert.ok(excerpt.includes("before the end"));
});

test("contextLines 0 sends immediately, with just the line", async () => {
  const { sent, feed, settle } = await rig({ rules: [{ ...RULE, contextLines: 0 }] });
  feed("local|api", "a line before");
  feed("local|api", "ERROR alone");
  await settle();
  assert.equal(sent.length, 1, "no waiting at all");
  const excerpt = sent[0].blocks.find((b) => b.text?.text?.includes("ERROR alone")).text.text;
  assert.ok(!excerpt.includes("a line before"));
});

/* Tearing a watch down must not swallow an alert that was waiting for context. */
test("a pending alert is flushed when the watch closes", async () => {
  const { alerts, sent, feed, settle } = await rig({ rules: [{ ...RULE, contextLines: 5 }], contextWaitMs: 10_000 });
  feed("local|api", "ERROR right before shutdown");
  await settle();
  assert.equal(sent.length, 0);

  alerts.stopAll();
  await settle();
  assert.equal(sent.length, 1, "shutting down is not a reason to lose an alert");
});

test("context is bounded", () => {
  assert.match(normalizeRule({ ...RULE, contextLines: 21 }).error, /at most 20/);
  assert.match(normalizeRule({ ...RULE, contextLines: -1 }).error, /whole number/);
  assert.equal(normalizeRule({ ...RULE, contextLines: undefined }).rule.contextLines, 3, "a sane default");
});

// ── when an alert is NOT sent ───────────────────────────────────────────────
test("the cooldown suppresses the flood and reports how much it swallowed", async () => {
  const { alerts, sent, feed, settle } = await rig({ rules: [{ ...RULE, cooldownSec: 3600 }] });
  for (let i = 0; i < 5; i++) feed("local|api", `ERROR attempt ${i}`);
  await settle();

  assert.equal(sent.length, 1, "a crash loop is one alert, not five");
  assert.equal(alerts.list()[0].suppressed, 4);
  assert.match(JSON.stringify(sent[0].blocks), /ERROR attempt 0/, "the FIRST match is the one sent");
});

test("with no cooldown every match sends, and the suppressed count is carried into the next alert", async () => {
  const { sent, feed, settle } = await rig({ rules: [{ ...RULE, cooldownSec: 0 }] });
  feed("local|api", "ERROR one");
  feed("local|api", "ERROR two");
  await settle();
  assert.equal(sent.length, 2);
  assert.ok(!sent[1].text.includes("suppressed"), "nothing was suppressed, so nothing is claimed");
});

/* The cooldown has to survive a restart. If it didn't, a container crash-looping the server would
 * produce a fresh alert on every boot — the exact storm the cooldown exists to stop. */
test("lastFiredAt persists, so a restart doesn't reopen the cooldown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logedex-alerts-"));
  const file = join(dir, "alerts.json");

  const first = await rig({ file, rules: [{ ...RULE, cooldownSec: 3600 }] });
  first.feed("local|api", "ERROR once");
  await first.settle();
  assert.equal(first.sent.length, 1);
  // The matching path's write is fire-and-forget by design, so wait for it explicitly.
  await first.alerts.flush();
  first.alerts.stopAll();

  const saved = JSON.parse(await readFile(file, "utf8"));
  assert.ok(saved.alerts[0].lastFiredAt > 0, "the file remembers when it fired");

  const second = await rig({ file });
  await second.alerts.load();
  second.alerts.start();
  second.feed("local|api", "ERROR again, right after a restart");
  await second.settle();
  assert.equal(second.sent.length, 0, "still inside the cooldown it was in before the restart");
});

/* Both stream sources replay a buffered tail to a new subscriber. Without a cutoff, arming a rule
 * would immediately alert on lines that predate it — and every reconnect would re-alert on the
 * same tail. */
test("lines that predate the rule are ignored", async () => {
  const { sent, feed, settle } = await rig({ rules: [RULE] });
  const old = new Date(Date.now() - 60_000).toISOString();
  feed("local|api", "ERROR from ten minutes before you wrote this rule", old);
  await settle();
  assert.equal(sent.length, 0);

  feed("local|api", "ERROR happening now");
  await settle();
  assert.equal(sent.length, 1);
});

test("a replayed line is ignored the second time it arrives", async () => {
  const { sent, feed, settle } = await rig({ rules: [RULE] });
  const t1 = new Date().toISOString();
  const t2 = new Date(Date.now() + 1000).toISOString();
  feed("local|api", "ERROR first", t2);
  await settle();
  assert.equal(sent.length, 1);
  // The tail comes back after a reconnect: an older stamp than one already processed.
  feed("local|api", "ERROR first", t1);
  await settle();
  assert.equal(sent.length, 1, "the same line replayed must not alert twice");
});

test("a disabled rule watches nothing and sends nothing", async () => {
  const { emitters, alerts } = await rig({ rules: [{ ...RULE, enabled: false }] });
  assert.equal(emitters.size, 0);
  assert.deepEqual(alerts.list()[0].watching, []);
});

// ── the watch ───────────────────────────────────────────────────────────────
test("deleting a rule closes the stream it was the only reason for", async () => {
  const { alerts, emitters } = await rig({ rules: [RULE] });
  assert.equal(emitters.size, 1);
  const id = alerts.list()[0].id;
  assert.deepEqual(await alerts.remove(id), { ok: true });
  assert.equal(emitters.size, 0);
});

test("narrowing a rule's targets closes the stream that's no longer wanted", async () => {
  const { alerts, emitters } = await rig({
    rules: [{ ...RULE, targets: [{ hostId: "local", container: "api" }, { hostId: "local", container: "worker" }] }],
  });
  assert.equal(emitters.size, 2);
  const id = alerts.list()[0].id;
  const out = await alerts.save({ ...RULE, id, targets: [{ hostId: "local", container: "api" }] });
  assert.ok(!out.error, out.error);
  assert.deepEqual([...emitters.keys()], ["local|api"]);
});

test("a stream that ends is reported, not forgotten", async () => {
  const { alerts, status } = await rig({ rules: [RULE] });
  status("local|api", "error", "no such container");
  const [rule] = alerts.list();
  assert.equal(rule.watching[0].state, "error");
});

// ── persistence ─────────────────────────────────────────────────────────────
test("a rule round-trips through the file", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logedex-alerts-"));
  const file = join(dir, "alerts.json");
  const { alerts } = await rig({ file, rules: [{ ...RULE, cooldownSec: 42 }] });
  await alerts.flush();
  alerts.stopAll();

  const reopened = await rig({ file });
  await reopened.alerts.load();
  const [rule] = reopened.alerts.list();
  assert.equal(rule.name, "api errors");
  assert.equal(rule.pattern, "ERROR|FATAL");
  assert.equal(rule.cooldownSec, 42);
  assert.deepEqual(rule.targets, [{ hostId: "local", container: "api" }]);
});

/* One bad entry in a hand-edited file must not cost the operator every other rule. */
test("an invalid rule in the file is dropped, and the rest still load", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logedex-alerts-"));
  const file = join(dir, "alerts.json");
  await writeFile(file, JSON.stringify({
    alerts: [
      { name: "", pattern: "x", channel: "#a", targets: [{ hostId: "local", container: "api" }] },
      { name: "good", pattern: "ERROR", channel: "#a", targets: [{ hostId: "local", container: "api" }] },
    ],
  }), "utf8");

  const { alerts } = await rig({ file });
  await alerts.load();
  const names = alerts.list().map((r) => r.name);
  assert.deepEqual(names, ["good"]);
});

/* A pattern typed straight into the file has never been through the canary, so the boot check is
 * the only thing standing between it and the matcher. It's disabled rather than deleted: the
 * operator's intent stays visible, with the reason attached. */
test("a dangerous pattern in the file is disabled with its reason, not dropped", async () => {
  const dir = await mkdtemp(join(tmpdir(), "logedex-alerts-"));
  const file = join(dir, "alerts.json");
  await writeFile(file, JSON.stringify({
    alerts: [{
      name: "hand written", pattern: "(a+)+$", channel: "#a",
      targets: [{ hostId: "local", container: "api" }],
    }],
  }), "utf8");

  const { alerts, emitters } = await rig({ file });
  await alerts.load();
  alerts.start();
  const [rule] = alerts.list();
  assert.equal(rule.name, "hand written", "still there");
  assert.equal(rule.enabled, false);
  assert.match(rule.disabledReason, /backtracks too heavily/);
  assert.equal(emitters.size, 0, "and nothing is watching on its behalf");
});

// ── the Slack gate ──────────────────────────────────────────────────────────
test("caps reports slack when the account has it", async () => {
  const { alerts } = await rig();
  const caps = await alerts.caps();
  assert.equal(caps.slack, true);
  assert.deepEqual(caps.providers, ["slack"]);
});

/* "Couldn't ask" is not "not connected". Conflating them puts a "connect Slack" banner in front of
 * someone whose Slack is fine and whose daemon is merely down. */
test("an unanswerable caps probe reports null, not false", async () => {
  const alerts = createAlerts({
    yeetBin: "yeet", alertScript: "/a.js", capsScript: "/c.js", file: null,
    exec: async () => ({ exitCode: 1, stdout: "", stderr: "Daemon Unavailable" }),
    host: (id) => HOSTS[id] ?? null,
    localLogs: () => () => {},
    remoteLogs: () => () => {},
  });
  const caps = await alerts.caps();
  assert.equal(caps.slack, null);
  assert.match(caps.error, /Daemon Unavailable/);
  assert.equal(caps.settingsUrl, "https://yeet.cx/settings");
});

test("an account with other integrations but not slack reports false", async () => {
  const alerts = createAlerts({
    yeetBin: "yeet", alertScript: "/a.js", capsScript: "/c.js", file: null,
    exec: async () => ({ exitCode: 0, stdout: `${JSON.stringify({ t: "caps", providers: ["linear"] })}\n`, stderr: "" }),
    host: (id) => HOSTS[id] ?? null,
    localLogs: () => () => {},
    remoteLogs: () => () => {},
  });
  assert.equal((await alerts.caps()).slack, false);
});

// ── the test-fire button ────────────────────────────────────────────────────
test("a test alert sends without touching the cooldown", async () => {
  const { alerts, sent, feed, settle } = await rig({ rules: [{ ...RULE, cooldownSec: 3600 }] });
  const id = alerts.list()[0].id;

  const res = await alerts.test(id);
  assert.ok(res.ok, res.error);
  assert.equal(sent.length, 1);
  assert.match(sent[0].text, /test alert/);

  // The real thing still fires afterwards, which is the point of not touching lastFiredAt.
  feed("local|api", "ERROR a real one");
  await settle();
  assert.equal(sent.length, 2);
});

/* Once we know Slack is gone, a matching line must not spend an isolate to fail. The gate on saving
 * only covers the moment the rule was written — a workspace can be disconnected afterwards. */
test("a known-missing Slack skips delivery and says why", async () => {
  const runs = [];
  let emit;
  const alerts = createAlerts({
    yeetBin: "yeet", alertScript: "/a.js", capsScript: "/c.js", file: null,
    exec: async (_b, args) => {
      runs.push(args.includes("--payload") ? "deliver" : "caps");
      return { exitCode: 0, stdout: `${JSON.stringify({ t: "caps", providers: ["linear"] })}\n`, stderr: "" };
    },
    host: (id) => HOSTS[id] ?? null,
    localLogs: (req, onEvent) => { emit = onEvent; return () => {}; },
    remoteLogs: () => () => {},
  });
  await alerts.save(RULE);
  assert.equal((await alerts.caps()).slack, false, "the cache now knows");

  emit({ t: "log", ts: new Date().toISOString(), message: "ERROR here" });
  await new Promise((r) => setImmediate(r));

  assert.ok(!runs.includes("deliver"), "no isolate spawned for a delivery that cannot work");
  assert.match(alerts.list()[0].lastError, /yeet\.cx\/settings/);
});

/* `yeet.exit()` takes no status, so the isolate exits 0 whether it delivered or crashed on load.
 * Claiming failure is as wrong as claiming success. */
test("an isolate that reports nothing is 'unknown', not 'failed'", async () => {
  const alerts = createAlerts({
    yeetBin: "yeet", alertScript: "/a.js", capsScript: "/c.js", file: null,
    exec: async (_b, args) => (args.includes("--payload")
      ? { exitCode: 0, stdout: "", stderr: "" }
      : { exitCode: 0, stdout: `${JSON.stringify({ t: "caps", providers: ["slack"] })}\n`, stderr: "" }),
    host: (id) => HOSTS[id] ?? null,
    localLogs: () => () => {},
    remoteLogs: () => () => {},
  });
  const saved = await alerts.save(RULE);
  const res = await alerts.test(saved.rule.id);
  assert.match(res.error, /unknown/);
  assert.ok(!/failed/.test(res.error), `must not claim failure: ${res.error}`);
});

test("a delivery failure is reported on the rule rather than thrown away", async () => {
  const sentErr = { exitCode: 0, stdout: `${JSON.stringify({ t: "error", error: "channel_not_found" })}\n`, stderr: "" };
  const alerts = createAlerts({
    yeetBin: "yeet", alertScript: "/a.js", capsScript: "/c.js", file: null,
    exec: async (_b, args) => (args.includes("--payload") ? sentErr
      : { exitCode: 0, stdout: `${JSON.stringify({ t: "caps", providers: ["slack"] })}\n`, stderr: "" }),
    host: (id) => HOSTS[id] ?? null,
    localLogs: () => () => {},
    remoteLogs: () => () => {},
  });
  const saved = await alerts.save(RULE);
  const res = await alerts.test(saved.rule.id);
  assert.equal(res.error, "channel_not_found");
  assert.equal(alerts.list()[0].lastError, "channel_not_found");
});

// ── the cooldown decision, on its own ───────────────────────────────────────
test("shouldFire is leading-edge", () => {
  assert.equal(shouldFire({ cooldownSec: 60, lastFiredAt: 0 }, 1000), true, "never fired: fire now");
  assert.equal(shouldFire({ cooldownSec: 60, lastFiredAt: 1000 }, 1030), false);
  assert.equal(shouldFire({ cooldownSec: 60, lastFiredAt: 1000 }, 1060), true, "exactly at the edge");
  assert.equal(shouldFire({ cooldownSec: 0, lastFiredAt: 1000 }, 1000), true, "no cooldown, no wait");
});
