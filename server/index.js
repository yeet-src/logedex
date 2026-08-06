// Logédex server.
//
// Every instance plays two roles at once, which is what keeps the design small:
//
//   the AGENT role — answers for the box it runs on, reading the local yeet
//   daemon's system graph:
//     GET /api/local/containers        this host's containers
//     GET /api/local/logs?container=…  SSE, one container's live log lines
//
//   the HUB role — fans those same two calls out across the host list and serves
//   the browser UI:
//     GET    /                         the dashboard
//     GET    /api/hosts                the host list
//     POST   /api/hosts {url,label}    add a host
//     DELETE /api/hosts?id=…           remove one
//     GET    /api/containers           every host's containers, in one response
//     GET    /api/logs?host=…&container=…   SSE, routed to that host
//     GET    /healthz                  liveness
//
// So a remote host is not a different kind of thing to talk to: the hub calls the
// exact endpoints it answers itself, and the box you point your browser at is
// simply the one wearing the hub hat. Nothing registers, nothing is discovered —
// you type a URL, and it has to be reachable from here.
//
// Zero runtime npm deps: node's built-in http, fetch and WebSocket are all of it.

import http from "node:http";
import os from "node:os";
import { readdir, readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, extname, join, resolve, sep } from "node:path";
import { createGraph } from "./graph.js";
import { createHosts, LOCAL_ID } from "./hosts.js";
import { createLogs } from "./logs.js";
import { createAuth } from "./auth.js";
import { createAlerts } from "./alerts.js";
import { remoteContainers, remoteLabel, remoteLogs, remoteOldest } from "./remote.js";
import { clampLimit, DEFAULT_MAX_LINES, DEFAULT_MAX_WINDOW_SEC } from "../shared/limits.js";
import { assetFrom, MIME, PUBLIC, SHARED, SPRITE_DIR, SPRITE_EXT, spriteFrom } from "./assets.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * This machine's name, for labelling itself in the host list.
 *
 * Short form, not the FQDN: `web-01` is what an operator calls the box, and the
 * host column is a fixed width that a fully-qualified name would fill with domain.
 *
 * Returns "" — letting the caller fall back to "this host" — when the name is
 * docker's default, which is the container's own id. Inside a container with no
 * `--hostname` and no `LOCAL_LABEL`, `os.hostname()` is a 12-hex-digit string that
 * changes every time the container is recreated, so it's worse than useless as a
 * label: it names the container, not the host, and names it differently tomorrow.
 * `make up` passes the real hostname through, so this is the fallback for a
 * hand-rolled `docker run`.
 */
function defaultLocalLabel() {
  let name = "";
  try { name = os.hostname() || ""; } catch { return ""; }
  name = name.split(".")[0];
  if (/^[0-9a-f]{12}$/i.test(name)) return "";
  return name;
}

/* What this dashboard is called in analytics. Not the container name, the host label or
 * anything an operator can set — it names the PRODUCT, so it is a constant here and the one
 * line that differs when this wiring is copied to the next one. See `posthogKey` below. */
const APP = "logedex";

const config = {
  port: Number(process.env.PORT || 8080),
  host: process.env.HOST || "0.0.0.0",
  yeetBin: process.env.YEET_BIN || "yeet",
  agentDir: process.env.AGENT_DIR || join(__dirname, "..", "agent"),
  socket: process.env.YEET_SOCKET || "/run/yeet/yeetd.sock",
  userSocket: process.env.YEET_USER_SOCKET || "/run/yeet/yeetd.user.sock",
  // What to call the box we're running on, in the UI's host column. Defaults to
  // this machine's name, which is the answer to "which box is this" that an
  // operator already has in their head.
  localLabel: process.env.LOCAL_LABEL || defaultLocalLabel(),
  // Where the host list is kept so it survives the container being recreated.
  // HOSTS_FILE="" turns persistence off (the list then lives and dies with us).
  hostsFile: process.env.HOSTS_FILE === "" ? null : (process.env.HOSTS_FILE || join(__dirname, "hosts.json")),
  /* Alert rules, kept beside the host list and for the same reason — an alert you have to
   * remember to re-arm after a restart isn't one. ALERTS_FILE="" turns persistence off, which is
   * for tests: rules then live and die with the process. */
  alertsFile: process.env.ALERTS_FILE === "" ? null : (process.env.ALERTS_FILE || join(__dirname, "alerts.json")),
  // Comma/space-separated URLs to add at boot, for a declarative deployment.
  seed: (process.env.HOSTS || "").split(/[,\s]+/).filter(Boolean),
  // Log lines kept per attached container, for backfilling a late viewer.
  tail: Math.max(0, Number(process.env.TAIL || 500)),
  /* The widest history one stream may ask this host to replay (seconds).
   *
   * A cap rather than a preference: `since` two months back makes the local docker
   * daemon walk two months of log, and the box running the containers is the one
   * that pays. See shared/limits.js. MAX_WINDOW=0 turns it off, for an operator who
   * knows their retention is small and wants the whole thing.
   *
   * `Number("")` is 0, so an empty MAX_WINDOW would read as "uncapped" by accident —
   * hence the explicit check that something was actually set. */
  maxWindowSec: Number.isFinite(Number(process.env.MAX_WINDOW)) && process.env.MAX_WINDOW
    ? Math.max(0, Number(process.env.MAX_WINDOW))
    : DEFAULT_MAX_WINDOW_SEC,
  /* The other half of that bound: the most lines one stream may ask this host to
   * replay out of docker, whatever window it named. The width cap says how far back
   * a question may reach; this says how much answer it may pull, which on a busy
   * container is the number that actually matters. A viewer asks for its own buffer
   * size and gets the newest that many inside its window; anything larger, or
   * missing, lands here. See shared/limits.js. */
  maxLines: Number.isFinite(Number(process.env.MAX_LINES)) && process.env.MAX_LINES
    ? Math.max(1, Number(process.env.MAX_LINES))
    : DEFAULT_MAX_LINES,
  /* The dashboard is gated on this yeet instance being logged in. Only the box you
   * point a browser at needs to be — the ones it fans out to are reached over their
   * own API, which this doesn't cover. REQUIRE_LOGIN=0 turns the gate off, for a
   * checkout with no yeet account attached. See auth.js for what it does and, more
   * importantly, what it does not protect. */
  requireLogin: process.env.REQUIRE_LOGIN !== "0",
  /* Live-edit mode: this process is running from an editable copy of its own source
   * under `node --watch`, so the dashboard can be rewritten without stopping the
   * container. That's how the container always runs — see the entrypoint.
   *
   * Worked out from WHERE WE ARE, not from a flag saying so. The question the page
   * actually needs answered is "is the code I'm serving editable", and the honest test
   * is whether this file was loaded out of the editable tree. A flag can be passed to a
   * server running from somewhere else entirely — `make dev` out of a git checkout is
   * exactly that — and would then advertise a directory nobody is serving from.
   *
   * The server's part in this is only to TELL you about it — where the source is and
   * how reloading behaves — because the editing happens through the mount, with your
   * own tools. There is deliberately no endpoint here that writes a file: that would be
   * a remote code execution API on a container holding the Docker socket, reachable by
   * anyone who can reach the port. Keeping the authority to change this code on the
   * filesystem side is the whole reason it's safe to have the dashboard talk about it. */
  editDir: (() => {
    const dir = process.env.EDIT_DIR || "/edit";
    return resolve(join(__dirname, "..")) === resolve(dir) ? dir : null;
  })(),
  // What that directory is called on the HOST — the only path an agent can act on.
  // Inside here it's /edit, which is useless to them.
  editSrcHost: process.env.EDIT_SRC_HOST || null,

  /* Product analytics for the dashboard, through the yeet PostHog proxy rather than
   * us.posthog.com. `POSTHOG_KEY=""` turns it off outright; POSTHOG_KEY=… points it at
   * another project.
   *
   * Nothing about the logs is sent either way, and that is a much sharper constraint
   * here than the usual one — every event this app raises is a count or a kind, never a
   * container, a host, an image, a filter term or a line. The three PostHog features
   * that would read the screen on their own (autocapture, session recording, exception
   * autocapture) are all off. See public/analytics.js, which is where a change to any of
   * that would have to be argued for.
   *
   * Several of these dashboards report into the SAME PostHog project, so every event says
   * which product it came from — `app` below, stamped on the way out by analytics.js. It is
   * not cosmetic: `dashboard_opened`, `login_started` and `alert_rule_created` all exist in
   * more than one of them with different properties, so without it those are one series
   * that means nothing. */
  posthogKey: process.env.POSTHOG_KEY === "" ? null
    : (process.env.POSTHOG_KEY || "phc_nZgQxuBUL76Lhk5diKf3aBN3NtMUzJsigw4TbDRoUopa"),
  posthogHost: (process.env.POSTHOG_HOST || "https://ph.yeet.cx").replace(/\/+$/, ""),
  posthogDebug: /^(1|true|yes)$/i.test(process.env.POSTHOG_DEBUG || ""),
};

const auth = createAuth({
  yeetBin: config.yeetBin,
  socket: config.socket,
  userSocket: config.userSocket,
  required: config.requireLogin,
});
const graph = createGraph(config);
const hosts = createHosts({
  file: config.hostsFile,
  localLabel: config.localLabel || undefined,
  seed: config.seed,
  defaultPort: config.port,
});
const logs = createLogs({
  yeetBin: config.yeetBin,
  script: join(config.agentDir, "logstream.js"),
  socket: config.socket,
  userSocket: config.userSocket,
  tail: config.tail,
  maxWindowSec: config.maxWindowSec,
  maxLines: config.maxLines,
});
/* Alerting. It reaches logs and remotes through the same two functions the HTTP handlers use, so
 * a rule on a local container shares the very stream a viewer would open — attaching as a
 * permanent viewer is all "always on" means here. See server/alerts.js. */
const alerts = createAlerts({
  yeetBin: config.yeetBin,
  alertScript: join(config.agentDir, "alert.js"),
  capsScript: join(config.agentDir, "caps.js"),
  file: config.alertsFile,
  socket: config.socket,
  userSocket: config.userSocket,
  host: (id) => hosts.get(id),
  localLogs: (req, onEvent) => logs.attach(req, onEvent),
  remoteLogs,
});

// ── helpers ────────────────────────────────────────────────────────────────
/* What docker accepts as a name or id. Checked before the value reaches a
 * command line or a query, so an operator's typo is a 400 here rather than
 * something stranger further down. */
const CONTAINER_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/;

/** The time window from a request's query string: `since`/`until` in unix seconds.
 *  Both optional — omit for a live tail, `since` alone to backfill and keep
 *  following, both for a closed window. Returns an `error` string for a value
 *  that isn't a sane timestamp, since silently ignoring one would show the
 *  operator a full log and let them believe it was filtered. */
function windowFrom(params) {
  const win = {};
  for (const k of ["since", "until"]) {
    const raw = params.get(k);
    if (raw === null || raw === "") continue;
    const n = Number(raw);
    // Seconds, not milliseconds: a millisecond value would land in the year
    // 58000 and quietly return everything, so catch the mistake by magnitude.
    if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0 || n > 4e9) {
      return { error: `${k} must be a unix timestamp in seconds` };
    }
    win[k] = n;
  }
  if (win.since && win.until && win.until <= win.since) {
    return { error: "until must be after since" };
  }
  /* How many lines the caller can hold. Unlike the timestamps this is not rejected
   * when it's nonsense — it's a hint about the CALLER's capacity, not a statement
   * about what to show, so an unreadable one falls back to this host's own ceiling
   * rather than failing a request that is otherwise perfectly well formed. */
  const limit = params.get("limit");
  if (limit !== null && limit !== "") win.limit = clampLimit(limit, config.maxLines);
  return win;
}

/* A search query is a bounded, opaque string here. The server doesn't interpret it
 * — it forwards it to the host that will (see shared/search.js) — so all that's
 * needed is a length cap, since this ends up as an argv entry on the far side. */
const FIND_MAX = 500;

function findFrom(params) {
  const raw = params.get("find");
  if (raw === null) return { find: "" };
  const find = String(raw);
  if (find.length > FIND_MAX) return { error: `find must be under ${FIND_MAX} characters` };
  return { find };
}



function json(res, code, obj) {
  const body = Buffer.from(`${JSON.stringify(obj)}\n`, "utf8");
  res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store", "content-length": body.length });
  res.end(body);
}

/** Serve a file from public/, or an absolute path for a shared module. */
async function serveStatic(res, file, type, abs = null) {
  try {
    const body = await readFile(abs ?? join(PUBLIC, file));
    res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
}


/** Read a JSON request body, capped so a client can't OOM us. */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = "";
    req.on("data", (d) => { b += d; if (b.length > 64_000) req.destroy(); });
    req.on("end", () => resolve(b));
    req.on("error", reject);
  });
}

/** Open an SSE response and return a `send(obj)` plus the heartbeat's cleanup.
 *  The heartbeat is what keeps a silent stream (an idle container) from being
 *  culled by a proxy in between. */
function openSse(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 2000\n\n");
  const heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch { /* ignore */ } }, 20_000);
  return {
    send(obj) {
      try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch { /* dropped on close */ }
    },
    close() { clearInterval(heartbeat); },
  };
}

// ── the agent role: this host only ─────────────────────────────────────────
async function handleLocalContainers(res) {
  // `label` is this box saying what it calls itself, so a hub adding it by URL can
  // name the row `web-02` instead of `box-two.lan:8080`. The box is the authority on
  // its own name; the hub only ever knew an address.
  try {
    json(res, 200, { ok: true, label: config.localLabel, containers: await graph.containers() });
  } catch (err) {
    // 200 with ok:false, not a 5xx: "docker isn't reachable from this host" is a
    // fact about the host, and the hub needs to show it next to the host's name
    // rather than treat the whole response as a transport failure.
    json(res, 200, { ok: false, label: config.localLabel, error: err.message, containers: [] });
  }
}

function handleLocalLogs(req, res, params) {
  const container = params.get("container") || "";
  if (!CONTAINER_RE.test(container)) {
    return json(res, 400, { ok: false, error: "container must be a docker name or id" });
  }
  const win = windowFrom(params);
  if (win.error) return json(res, 400, { ok: false, error: win.error });
  const q = findFrom(params);
  if (q.error) return json(res, 400, { ok: false, error: q.error });

  const sse = openSse(req, res);
  const detach = logs.attach({ container, ...win, find: q.find }, sse.send);
  req.on("close", () => { sse.close(); detach(); });
}

/** GET /api/local/oldest?container=… — when this container's log history starts, as
 *  a unix second. `null` means it has none (nothing logged, or nothing retained). */
async function handleLocalOldest(res, params) {
  const container = params.get("container") || "";
  if (!CONTAINER_RE.test(container)) {
    return json(res, 400, { ok: false, error: "container must be a docker name or id" });
  }
  try {
    const ts = await logs.oldest(container);
    json(res, 200, { ok: true, container, oldest: ts ? Math.floor(Date.parse(ts) / 1000) : null, ts: ts ?? null });
  } catch (err) {
    json(res, 200, { ok: false, error: err.message, oldest: null, ts: null });
  }
}

// ── the hub role: the whole host list ──────────────────────────────────────
/** Every host's containers in one response. Hosts are queried in parallel and a
 *  failure is per-host data (`error`), so a box that's down costs its own row and
 *  nothing else. */
async function handleContainers(res) {
  const results = await Promise.all(hosts.list().map(async (host) => {
    const row = { host: { id: host.id, label: host.label, url: host.url }, containers: [], error: null };
    try {
      row.containers = host.url === null ? await graph.containers() : await remoteContainers(host);
    } catch (err) {
      row.error = err.message;
    }
    return row;
  }));
  // The hub's window cap rides along: the browser polls this every few seconds
  // anyway, and it needs the real configured value rather than the shared default
  // so the range it offers matches the range it will actually be served.
  json(res, 200, { ok: true, hosts: results, maxWindowSec: config.maxWindowSec, maxLines: config.maxLines });
}

/** SSE for one (host, container). Local hosts read the daemon directly; remote
 *  ones are relayed from that host's own /api/local/logs. The browser can't tell
 *  the difference, which is the point — it just picks a pane. */
function handleLogs(req, res, params) {
  const host = hosts.get(params.get("host") || LOCAL_ID);
  const container = params.get("container") || "";
  if (!host) return json(res, 404, { ok: false, error: "no such host" });
  if (!CONTAINER_RE.test(container)) {
    return json(res, 400, { ok: false, error: "container must be a docker name or id" });
  }
  const win = windowFrom(params);
  if (win.error) return json(res, 400, { ok: false, error: win.error });
  const q = findFrom(params);
  if (q.error) return json(res, 400, { ok: false, error: q.error });

  const sse = openSse(req, res);
  const send = (evt) => sse.send({ ...evt, host: host.id });
  const detach = host.url === null
    ? logs.attach({ container, ...win, find: q.find }, send)
    : remoteLogs(host, container, { ...win, find: q.find }, send);
  req.on("close", () => { sse.close(); detach(); });
}

/** GET /api/oldest?host=…&container=… — the same question, routed. This is what the
 *  time slider's left edge is built from: the earliest log the view can actually
 *  reach, per stream, so the slider spans real history rather than a guess. */
async function handleOldest(res, params) {
  const host = hosts.get(params.get("host") || LOCAL_ID);
  const container = params.get("container") || "";
  if (!host) return json(res, 404, { ok: false, error: "no such host" });
  if (!CONTAINER_RE.test(container)) {
    return json(res, 400, { ok: false, error: "container must be a docker name or id" });
  }
  try {
    const ts = host.url === null
      ? await logs.oldest(container)
      : await remoteOldest(host, container);
    json(res, 200, { ok: true, host: host.id, container, oldest: ts ? Math.floor(Date.parse(ts) / 1000) : null });
  } catch (err) {
    // A host that can't answer costs the slider one stream's history, not the view.
    json(res, 200, { ok: false, host: host.id, container, oldest: null, error: err.message });
  }
}

async function handleHosts(req, res, params) {
  if (req.method === "GET") return json(res, 200, { ok: true, hosts: hosts.list() });

  if (req.method === "POST") {
    let body;
    try { body = JSON.parse((await readBody(req)) || "{}"); }
    catch { return json(res, 400, { ok: false, error: "invalid JSON body" }); }
    // With no label given, ask the box what it calls itself before falling back to
    // its address — `web-02` beats `box-two.lan:8080` in a column 18 characters wide.
    let label = String(body.label ?? "").trim();
    if (!label) {
      const probe = hosts.probeUrl(body.url);
      if (probe) label = (await remoteLabel({ url: probe })) ?? "";
    }
    const r = await hosts.add({ url: body.url, label });
    if (r.error) return json(res, 400, { ok: false, error: r.error });
    console.log(`[hub] host ${r.existing ? "already present" : "added"}: ${r.host.id} → ${r.host.url}`);
    return json(res, 200, { ok: true, host: r.host, existing: r.existing, hosts: hosts.list() });
  }

  if (req.method === "DELETE") {
    const r = await hosts.remove(params.get("id") || "");
    if (r.error) return json(res, r.error === "no such host" ? 404 : 400, { ok: false, error: r.error });
    return json(res, 200, { ok: true, hosts: hosts.list() });
  }

  return json(res, 405, { ok: false, error: "GET, POST or DELETE only" });
}

/* Alert rules: list, create/replace, delete, and fire one on demand.
 *
 * The capability answer rides along on the GET rather than sitting on its own route, because the
 * UI needs both together — a rule list is not something you can act on without knowing whether
 * Slack is connected, and two round trips to decide what to render is two chances to render the
 * wrong thing. `?caps=recheck` forces a fresh probe, which is what the operator wants after
 * coming back from yeet.cx/settings.
 *
 * `POST` with an `id` replaces that rule; without one it creates. `POST ?test=<id>` delivers that
 * rule's alert immediately — it changes nothing, but it is a POST because it sends a message to a
 * Slack channel, and that is not a GET.
 */
async function handleAlerts(req, res, params) {
  if (req.method === "GET") {
    const caps = await alerts.caps({ force: params.get("caps") === "recheck" });
    return json(res, 200, { ok: true, alerts: alerts.list(), caps, defaults: alerts.defaults });
  }

  if (req.method === "POST") {
    const testId = params.get("test");
    if (testId) {
      const r = await alerts.test(testId);
      if (r.error) return json(res, r.error === "no such rule" ? 404 : 502, { ok: false, error: r.error });
      return json(res, 200, { ok: true, result: r.result ?? null });
    }
    let body;
    try { body = JSON.parse((await readBody(req)) || "{}"); }
    catch { return json(res, 400, { ok: false, error: "invalid JSON body" }); }
    /* Refused rather than saved when Slack isn't connected: a rule that cannot deliver is not a
     * rule, it's a false sense of coverage. `null` means we couldn't ask (the daemon is down, no
     * login) and that is NOT treated as "not connected" — saving is allowed, because refusing on
     * an unknown would make the feature unusable exactly when the box is having a bad day. */
    const caps = await alerts.caps();
    if (caps.slack === false) {
      return json(res, 409, {
        ok: false, error: "Slack is not connected to this yeet account", caps,
      });
    }
    const r = await alerts.save(body);
    if (r.error) return json(res, 400, { ok: false, error: r.error, caps });
    const where = r.rule.targets.map((t) => `${t.hostId}/${t.container}`).join(" + ");
    console.log(`[alerts] saved "${r.rule.name}" — ${where} /${r.rule.pattern}/${r.rule.flags}`);
    return json(res, 200, { ok: true, alert: r.rule, alerts: alerts.list(), caps });
  }

  if (req.method === "DELETE") {
    const r = await alerts.remove(params.get("id") || "");
    if (r.error) return json(res, 404, { ok: false, error: r.error });
    return json(res, 200, { ok: true, alerts: alerts.list() });
  }

  return json(res, 405, { ok: false, error: "GET, POST or DELETE only" });
}

// ── HTTP server ────────────────────────────────────────────────────────────
/* The gate's state, polled by the page while a login is in flight. `no-store`
 * because a cached "locked" is a dashboard that never unlocks.
 *
 * It carries the analytics config too, rather than that having its own route or being
 * inlined into the HTML. This is already the page's first request and the one it waits
 * on before doing anything — and the owner id analytics identifies against is in here
 * anyway, so the two arrive together or not at all. `null` when the key is unset, which
 * is what makes analytics.js a no-op for the page's life. */
function handleAuthState(res) {
  const body = {
    ...auth.state(),
    analytics: config.posthogKey
      ? { key: config.posthogKey, host: config.posthogHost, app: APP, debug: config.posthogDebug }
      : null,
  };
  res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(`${JSON.stringify(body)}\n`);
}

/* POST /api/login/start — begin the device flow and answer with the URL to send the
 * user to. It answers as soon as the URL is KNOWN, not when the login completes:
 * `yeet login` blocks until the browser side finishes, and the page needs somewhere
 * to send them in the meantime. Completion is observed by polling the state above. */
async function handleLoginStart(res) {
  try {
    const r = await auth.startLogin();
    if (r.loggedIn) return void json(res, 200, { ok: true, loggedIn: true });
    if (r.error) return void json(res, 502, { ok: false, error: r.error });
    json(res, 200, { ok: true, url: r.url });
  } catch (err) {
    json(res, 500, { ok: false, error: String(err.message ?? err) });
  }
}

/* GET /api/edit — whether this box is running in live-edit mode, and if so the facts
 * an agent needs to find the code: the path on the HOST, what restarts itself and what
 * only needs a browser reload, and where a crash gets written.
 *
 * Facts, not prose. The wording the UI shows is built in public/edit.js, which is
 * itself one of the files this feature lets you rewrite — so the instructions can be
 * improved by the thing they describe.
 *
 * Answers when edit mode is OFF too (`enabled: false`), so the page can simply not
 * show the button rather than treating a 404 as an error. */
/* A short string standing for the version of everything the BROWSER loaded: the page,
 * its modules, its stylesheet, and the two shared modules it imports from outside
 * public/. The page polls this in edit mode and offers a reload when it changes.
 *
 * Why the browser needs telling at all: these files are read from disk per request, so
 * an edit to them is live on the server the instant it's saved — and completely absent
 * from the tab you're looking at until you reload. That gap is the one confusing part
 * of editing this thing live. A backend edit announces itself (the server restarts, the
 * streams blink); a frontend edit looks like nothing happened.
 *
 * mtime and size, not a content hash: this runs on a timer, and the point is to notice
 * that something changed, which mtime already answers without reading every file. A
 * write that leaves both identical is possible in theory and would be missed; that
 * costs a reload prompt, not correctness.
 *
 * Best effort by design — a file that can't be stat'd contributes nothing rather than
 * throwing, because failing to compute a version must not take out the endpoint that
 * reports where the source is. */
async function assetVersion() {
  const files = [
    join(PUBLIC, "index.html"), join(PUBLIC, "app.js"), join(PUBLIC, "style.css"),
    join(PUBLIC, "order.js"), join(PUBLIC, "entries.js"), join(PUBLIC, "ansi.js"),
    join(PUBLIC, "edit.js"), join(PUBLIC, "theme.js"), join(PUBLIC, "sprites.js"),
    ...SHARED.values(),
  ];
  const parts = await Promise.all(files.map(async (f) => {
    try {
      const s = await stat(f);
      return `${Math.floor(s.mtimeMs)}:${s.size}`;
    } catch { return "-"; }
  }));
  return createHash("sha1").update(parts.join("|")).digest("hex").slice(0, 12);
}

/* GET /api/sprites — which creature icons exist right now.
 *
 * The browser needs the list because the mapping is by NAME: a file called `web-01.png` is
 * web-01's icon, and the page can't know that without being told what's on disk. Read per
 * request rather than cached, because the whole point of the directory is that you drop a
 * file in and reload — a cache would mean "why isn't my sprite showing" for one process
 * lifetime.
 *
 * A missing directory is an empty list, not an error: sprites are optional, and the
 * dashboard falls back to the drawn pokéball. */
async function handleSprites(res) {
  let names = [];
  try {
    const entries = await readdir(SPRITE_DIR, { withFileTypes: true });
    names = entries
      .filter((e) => e.isFile() && SPRITE_EXT.has(extname(e.name).toLowerCase()))
      .map((e) => e.name)
      .sort();
  } catch { /* no directory, no sprites */ }
  json(res, 200, { ok: true, sprites: names });
}

async function handleEdit(res) {
  if (!config.editDir) return void json(res, 200, { ok: true, enabled: false });
  json(res, 200, {
    assetVersion: await assetVersion(),
    ok: true,
    enabled: true,
    // Where to actually edit. hostPath is null when nobody passed EDIT_SRC_HOST — a
    // hand-rolled `docker run`, or no mount at all; the UI says so rather than a lie.
    hostPath: config.editSrcHost,
    containerPath: config.editDir,
    // Relative, because they're the same under either root — which is the point of
    // seeding the mount with the repo's own layout.
    backend: ["server/*.js", "shared/*.js", "agent/logstream.js"],
    frontend: ["server/public/app.js", "server/public/style.css", "server/public/index.html"],
    entry: "server/index.js",
    log: ".logedex/server.log",
    // The two reload rules, so the UI never has to hardcode them. agent/ is in the
    // first list even though this process never imports it: that script runs in the
    // daemon's isolate and is re-read per attach, and a restart is what re-attaches
    // everything — so from an editor's point of view it behaves like the rest.
    restartsOnSave: ["server/", "shared/", "agent/"],
    reloadOnly: ["server/public/"],
  });
}

const server = http.createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  const params = new URL(req.url || "/", "http://x").searchParams;

  switch (url) {
    case "/api/local/containers":
      return void handleLocalContainers(res);
    case "/api/local/logs":
      return void handleLocalLogs(req, res, params);
    case "/api/local/oldest":
      return void handleLocalOldest(res, params);
    case "/api/hosts":
      return void handleHosts(req, res, params);
    case "/api/containers":
      return void handleContainers(res);
    case "/api/logs":
      return void handleLogs(req, res, params);
    case "/api/oldest":
      return void handleOldest(res, params);
    case "/api/alerts":
      return void handleAlerts(req, res, params);
    case "/healthz":
      return void json(res, 200, {
        ok: true, hosts: hosts.list().length, maxWindowSec: config.maxWindowSec, streams: logs.stats(),
        // Watches, not viewers: a healthz that only counts panes would report zero on a box whose
        // whole job is alerting.
        alerts: alerts.stats(),
      });
    /* The gate lives in the page, not in front of it: the dashboard is served either
     * way and covers itself with a sign-in card until `yeet whoami` resolves. Every
     * /api/* route above stays open on purpose — see the note atop auth.js for why
     * that's a choice rather than a gap, and what not to rely on this for. */
    case "/api/auth":
      return void handleAuthState(res);
    case "/api/login/start":
      return void handleLoginStart(res);
    case "/api/edit":
      return void handleEdit(res);
    case "/api/sprites":
      return void handleSprites(res);
    case "/":
    case "/index.html":
      return void serveStatic(res, "index.html", MIME[".html"]);
    default: {
      const sprite = spriteFrom(url);
      if (sprite) return void serveStatic(res, null, sprite.type, sprite.abs);
      const asset = assetFrom(url);
      if (asset) return void serveStatic(res, asset.file, asset.type, asset.abs);
      res.writeHead(404, { "content-type": "text/plain" });
      return void res.end("not found");
    }
  }
});

// ── boot ───────────────────────────────────────────────────────────────────
// A log viewer's job is to keep serving. Handlers are async, so a rejection in
// one (a browser vanishing mid-stream, a write to a closed socket) would
// otherwise take the process down and drop every other host's stream with it.
process.on("unhandledRejection", (err) => {
  console.error(`[logedex] unhandled rejection: ${err?.stack || err}`);
});
process.on("uncaughtException", (err) => {
  console.error(`[logedex] uncaught exception: ${err?.stack || err}`);
});

async function main() {
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`[logedex] port ${config.port} is already in use — set PORT to a free port.`);
    } else {
      console.error(`[logedex] server error: ${err.message}`);
    }
    process.exit(1);
  });

  await hosts.load();
  // Anything a previous, hard-killed run left holding a log stream open. Best
  // effort — a daemon that won't answer `ps` is not a reason to refuse to serve.
  try { await logs.sweepOrphans(); } catch (err) {
    console.error(`[logedex] orphan sweep skipped: ${err.message}`);
  }
  /* Rules load and their watches open BEFORE the port does. Between listening and watching there
   * is a window where the dashboard is up and alerting silently isn't, and that window is exactly
   * when a restart-triggering incident is still going on. Hosts are already loaded above, which
   * they must be — a rule names a host id and the watch has to resolve it. */
  await alerts.load();
  alerts.start();
  server.listen(config.port, config.host, () => {
    console.log(`[logedex] serving on http://${config.host}:${config.port}`);
    console.log(config.requireLogin
      ? "[logedex]   dashboard requires a yeet login (the API does not — see server/auth.js)"
      : "[logedex]   REQUIRE_LOGIN=0, dashboard is open");
    if (config.editDir) {
      console.log(`[logedex]   LIVE EDIT on — running from ${config.editDir}${config.editSrcHost ? ` (${config.editSrcHost} on the host)` : ""}`);
      console.log("[logedex]   saves under server/, shared/ or agent/ restart this process; public/ only needs a reload");
    }
    for (const h of hosts.list()) console.log(`[logedex]   host ${h.id} — ${h.url ?? "local daemon"}`);
  });

  const shutdown = async () => {
    console.log("[logedex] shutting down…");
    try { auth.stop(); } catch { /* ignore */ }
    /* Watches go first, and before `logs.stopAll()`. A watch is a subscriber on a local stream, so
     * detaching them lets those streams shut down through their own path instead of being torn out
     * from under a live subscriber. */
    try { alerts.stopAll(); } catch { /* ignore */ }
    try { await logs.stopAll(); } catch { /* ignore */ }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
