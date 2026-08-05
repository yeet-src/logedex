# Working on Logédex

Logédex is a web dashboard that reads container logs from a fleet of Linux hosts and
shows them side by side in one browser tab. It is a Node HTTP server plus a plain-DOM
frontend, with its data layer running inside the yeet daemon's V8 isolate. No framework,
no bundler, no runtime npm dependencies.

This file is the contract for changing it. Read it before touching anything.
`README.md` is the user-facing document; don't duplicate its prose here.

## Boot it before you change it

You need Linux and Docker. Three commands, in this order:

```sh
make demo    # three containers that log like real services
make up      # build + run detached  → http://localhost:8080
make logs    # follow the container
```

`make demo` first is not optional advice. An empty dashboard and a broken dashboard look
identical, so verifying your own work needs something writing lines. Those three
containers do that (varied lines, a flood of `/health` to filter out, occasional real
Python tracebacks). `make demo-stop` removes them.

Then verify, because "the container is up" and "it works" are different claims:

```sh
curl -s localhost:8080/healthz                    # {"ok":true,"hosts":1,...}
curl -s localhost:8080/api/containers             # web-01, api-02, worker-03 listed?
docker ps --filter name=logedex --format '{{.Status}}'   # want (healthy), not (health: starting)
```

The healthcheck has a 45s start period, so expect `(health: starting)` for the first
minute; that alone is not a fault. If `/api/containers`
comes back with an empty list or an error per host, stop and read
[Diagnosing](#diagnosing) rather than editing anything.

> **This has to be real Linux with a real Docker socket.** On Docker Desktop, OrbStack, or
> any other VM-backed Docker, you'll list the *VM's* containers rather than the host's,
> which looks like it works and answers the wrong question. Check `uname -s` before you
> start, and say so instead of proceeding.

`make edit` is `make up` plus a printout of where the running app's source landed on the
host. That directory is where you work. See [The two loops](#the-two-loops).

| target | what it does |
| --- | --- |
| `make up` | build + run detached, `--restart unless-stopped` |
| `make edit` | the same, then prints the host path of the running source |
| `make run` | build + run in the foreground (Ctrl-C stops it) |
| `make dev` | run the server from this checkout with `node --watch`, no container |
| `make down` · `make logs` | stop and remove · follow logs |
| `make demo` · `make demo-stop` | the three logging containers |
| `make up EDIT_RESET=1` | discard edits to the mounted source, re-seed from the image |

## Tests

```sh
cd server && npm test      # all eight files, including ../shared/*.test.js
cd shared && node --test    # just the two shared ones, if that's all you touched
```

Node's built-in runner, nothing to install. `server`'s `npm test` globs
`*.test.js public/*.test.js ../shared/*.test.js`, so it is the one command that covers
everything: `server/{assets,auth,alerts}`, `server/public/{ansi,entries,order}`, and
`shared/{search,limits}`. The pure logic (query parsing, the window cap, ANSI parsing,
multi-line grouping, merge ordering) is covered; the HTTP routes and the streaming
lifecycle are not.

> **Two `alerts.test.js` cases fail on fast hardware, and it is not your edit.** The ReDoS
> canary (`server/redos.js`) refuses a pattern that burns its 250ms budget against 24-char
> adversarial probes. On a quick machine `(a+)+$` finishes inside that budget (~153ms on an
> M-series Mac), so it is accepted and the two "should be refused" assertions fail. The
> guard's verdict is host-speed dependent. Confirm against a clean checkout before assuming
> you broke it.

## Layout

Two roles in one process. Every instance answers for its own box (the **agent** role) and
also fans out to a list of other boxes by calling the same endpoints on them (the **hub**
role). A remote host is not a different kind of thing to talk to.

```
agent/logstream.js       runs INSIDE the yeet daemon's isolate — the data layer
agent/alert.js           the same, for a rule that runs with no tab open
agent/caps.js            asks the daemon what this box can do (is Slack paired?)

shared/search.js         query parsing + matching — runs in all three runtimes
shared/limits.js         the window-width cap
shared/alertrule.js      an alert rule's shape, limits, and adversarial regex probes

server/index.js          HTTP routes for both roles
server/logs.js           local log streams: fan-out, tail buffer, lifecycle
server/isolate.js        spawns an agent isolate, parses its JSON lines off stdout
server/graph.js          one-shot graph reads (the container list)
server/remote.js         calling another host's agent API (list + SSE relay)
server/hosts.js          the host list, persisted to /data/hosts.json
server/auth.js           the yeet login gate
server/alerts.js         alert rules: watches, matching, delivery
server/redos.js          worker-thread canary that vets an alert's regex before saving
server/assets.js         static file serving

server/public/app.js     the dashboard — plain DOM ES modules, no framework, no build
server/public/order.js   line ordering, merge defaults, stream labels
server/public/entries.js grouping lines back into multi-line entries
server/public/ansi.js    escape sequences → text plus styled runs
server/public/edit.js    the live-edit panel and the agent briefing it prints
server/public/theme.js   yeet mode / pokédex mode
server/public/sprites/   creature icons for the light theme, swappable
```

Data path for one attached pane:

```
browser ──SSE──► server/index.js ──► server/logs.js ──► server/isolate.js
                                                            │
                                                    spawns `yeet run`
                                                            ▼
                                              agent/logstream.js (isolate)
                                                            │
                                              docker_logs subscription
                                                            ▼
                                                    yeetd ──► docker
```

For a remote host, `server/remote.js` replaces everything from `logs.js` down with an
HTTP call to that box's `/api/local/logs`.

## agent/ is a different runtime: read this before editing it

Files under `agent/` do **not** run in Node. They run inside the yeet daemon's V8 isolate,
which is not Node, not Deno, and not a browser. Editing them like Node code is the single
most common way to break this repo.

Absent from that runtime:

- `fetch`, `WebSocket`, `XMLHttpRequest`
- `fs`, `path`, `os`, `net`, `http`, `child_process`, `process` (no `process.env`)
- `require` / CommonJS — ES modules only
- `Buffer`, `TextEncoder`, `TextDecoder`, `URL`, `crypto`, `AbortController`
- `Intl` (no ICU) — **`localeCompare` throws**, as does `toLocaleString`. Sort with plain
  `<` / `>` comparisons and format numbers by hand.
- `performance`, `setImmediate`

Present: `yeet.graph` (GraphQL query + subscribe), `yeet.args` (minimist-parsed),
`yeet.exit()`, `console.*`, timers, and the standard ECMAScript built-ins.

Two more things specific to `agent/logstream.js`:

- **`console.log` is the wire.** `server/isolate.js` runs this script as a child process
  and parses one JSON object per line off its stdout. A stray `console.log` of a debug
  string is a protocol violation that shows up as a mangled pane, not as an error. Log
  diagnostics to `console.error`.
- **Never compile a browser-supplied regex in here.** The filter matcher is substring-only
  on purpose. A backtracking pattern running once per log line inside this isolate can
  wedge the daemon for every script on the host. `shared/search.js` explains it at length.
  Alerts do take a regex, and they get vetted by `server/redos.js` in a killable worker
  thread first.

`shared/*.js` is imported by the isolate, the Node server, *and* the browser. Anything you
add there has to run in all three, which in practice means no dependencies and none of the
globals listed above.

## The two loops

The running container serves its own source out of a bind mount, so you edit the app
while it runs. `make edit` prints the host path (default
`~/.local/state/logedex/src`). That directory *is* what's executing. `/app` inside the
image is a pristine reference and is never touched.

| you saved | what happens |
| --- | --- |
| `server/**.js`, `shared/**.js`, `agent/**.js` | server restarts itself in ~1s; open panes reconnect on their own |
| `server/public/**` (js, css, html) | nothing restarts; the dashboard offers a reload in the corner |
| `Dockerfile`, `Makefile`, `docker/entrypoint.sh` | **not in the mount** — these need `make up` again |

Guessing wrong between rows one and two wastes the most time of anything in this repo.

Edits in that directory survive container restarts *and* image upgrades: it is seeded once
and then left alone. On start, the entrypoint compares a content fingerprint of the image's
source against what the mount was seeded from and warns when they've diverged, but it will
not overwrite your work. `make up EDIT_RESET=1` is how you deliberately throw the edits
away.

Files under `agent/` are read from disk per attached stream, so an edit there is picked up
by the next attach. A server restart re-attaches everything, which is why `agent/` is in
the watch set even though the Node process never imports it.

## Diagnosing

**Three runtimes load code from this tree, and each fails somewhere different.** Look in
the right place before concluding anything:

| broke | where it shows |
| --- | --- |
| the server (`server/*.js`) | crash in `<source-dir>/.logedex/server.log`, port stops answering |
| the browser (`server/public/*`) | browser console; the server stays up and healthy |
| the isolate (`agent/*.js`) | one stream dies or shows an error; the server never notices |

`shared/` spans all three, which is the trap. `shared/limits.js` is imported by the server
(`index.js`, `logs.js`); `shared/search.js` is imported by the browser **and** by
`agent/logstream.js` in the isolate. So breaking `search.js` leaves the server answering
normally, `/healthz` green and the container `healthy`, while the page or a stream quietly
stops working. **If the server is up but the dashboard is wrong, the browser console is
where to look, not the server log.**

**A broken edit takes the server down and leaves it down.** `node --watch` waits for the
fix rather than exiting, so the container stays `Up` while nothing answers on the port.
The traceback is at `<source-dir>/.logedex/server.log`, truncated per container start.
Read that file first for any "the dashboard stopped answering" symptom. The image's
`HEALTHCHECK` will mark the container `unhealthy`, so `docker ps` also tells you. Save a
fix and it starts again on its own; nothing needs restarting by hand.

**No containers listed on the local host.** The Docker socket isn't mounted, or isn't at
`/var/run/docker.sock`. The entrypoint warns at startup but does not fail, because a
server that comes up and shows the error per host beats a container that won't start.

**A remote host shows an error.** Reachability is not handled for you: no discovery, no
tunnel. Under `--network host` (the default) the container uses the host's own
`resolv.conf`, so LAN and tailnet names resolve. On a bridge they won't; add the host by
IP or pass `make up NET= DNS=100.100.100.100`.

**Empty panes but the container is running.** Check the yeetd version on that box.
`docker_logs` needs v0.19+, and history backfill on a fresh attach needs v0.20+.

**`GET /healthz`** reports liveness, host count and attached stream count. Cheapest check.

## Conventions

- **No runtime dependencies, and keep it that way.** `server/package.json` has no
  `dependencies` block. The frontend is ES modules loaded directly by the browser: no
  bundler, no build step, no CDN. Adding a framework would be a much larger change than it
  looks, because `agent/` and `shared/` can't use one.
- **Comments explain *why*, at length.** This codebase leans hard on long explanatory
  comments above non-obvious decisions, especially where a reasonable-looking change would
  break something (see `shared/search.js`, `shared/limits.js`, `server/redos.js`,
  `docker/entrypoint.sh`). Match that. If you remove a guard, remove the comment that
  explains it in the same edit, and if you add one, say why.
- **One meaning per query.** `shared/search.js` runs in three places specifically so a
  query means the same thing in all of them. Don't add matching logic in a caller.
- **Limits live in `shared/`.** The window cap is enforced by the server and offered by the
  browser from the same constant. Same for alert-rule bounds.
- **No em-dashes inside sentences** in user-facing strings or docs. Structural use after a
  bold label is fine.

## Feature clips for the README

The README has one commented-out `<img>` per feature, expecting
`assets/features/<name>.gif`. Record the clip, drop the file in, uncomment the tag. Names
in use: `hosts`, `sidebar`, `panes`, `timerange`, `scrubber`, `merge`, `filters`, `alerts`,
`themes`, `live-edit`.

Keep each clip small (a few hundred KB to a couple of MB) and scoped to one interaction.
`assets/logedex.gif` is the hero clip and is currently 43 MB, which is worth fixing before
adding ten more.
