# Logédex

> **Container logs from every host you run, side by side in one browser tab.** Enter a host's URL, get its containers, attach the ones you care about (from any host), and read the streams next to each other.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux">
  <img src="https://img.shields.io/badge/built%20with-yeet%20system%20graph-8A2BE2" alt="yeet system graph">
  <img src="https://img.shields.io/badge/license-GPL--2.0-3DA639" alt="GPL-2.0">
  <img src="https://img.shields.io/badge/deps-zero%20runtime%20npm-4fc1ff" alt="no runtime dependencies">
  <a href="https://discord.gg/JxVseaAVAU"><img src="https://img.shields.io/badge/chat-Discord-5865F2" alt="Discord"></a>
</p>

<p align="center">
  <img src="assets/logedex.gif" alt="Logédex: container logs from several hosts, side by side in one browser tab" width="820">
</p>

**Logédex puts `docker logs` from your whole fleet in one tab.** Attach any container on
any box; each pane is a live subscription. One time range moves every pane at once, so
lining up 04:08:54–04:08:59 across six containers on four hosts is a drag of one slider.
Combine several streams into a single pane and read them interleaved by timestamp, so the
same service on three boxes reads as one story.

Built on the [yeet](https://yeet.cx/docs/?utm_source=github&utm_medium=readme&utm_campaign=logedex) **system graph**, which already models the Docker
API: no agent protocol, no log shipper, no index, no eBPF.

> [!TIP]
> **Every instance is both halves.** The box you point a browser at fans out to the
> others by calling the exact endpoints it answers for itself. Nothing registers and
> nothing is discovered. You type a URL.

## Have an agent set it up

Paste this into a coding agent on the Linux box you want logs from. It clones the repo,
brings the dashboard up with something logging into it, and tells you whether it worked.

```text
Clone https://github.com/yeet-src/logedex and get it running on this machine,
then tell me whether it actually works.

Read AGENTS.md before you run anything; it has the boot order and the traps.
Run `make demo` before `make up` — an empty dashboard looks identical to a
broken one, so there needs to be something writing log lines first.

Verify with `curl localhost:8080/api/containers` and tell me whether web-01,
api-02 and worker-03 are listed. "The container is up" is not the same as
"it works".

This needs real Linux and a real Docker socket. If this machine is Docker
Desktop or OrbStack, stop and say so: you'd be listing the VM's containers
instead of this host's.
```

Prefer to drive it yourself? [Manual install](#manual-install) is two commands.

## Manual install

For one host you have a shell on. Nothing to configure.

```sh
git clone https://github.com/yeet-src/logedex.git && cd logedex
make demo                            # three containers that log like real services
make up                              # build + run detached  → http://localhost:8080
```

Open `http://localhost:8080` and attach a demo container from the sidebar.

Run `make demo` before you judge the thing. An empty grid and a broken grid look
identical, so give it something writing lines first. `make demo-stop` clears those
containers out.

`make up` covers what would otherwise be flags. It builds the image, creates the state
directory owned by you instead of root, passes this machine's `hostname -s` in as the
box's label (inside a container `hostname` is the container id, which names the wrong
thing), and reaches for `sudo docker` if you're not in the `docker` group. Rename the box
later with `make up LOCAL_LABEL=web-01`.

### The plain `docker run`

If you'd rather not use the Makefile:

```sh
mkdir -p "$HOME/.local/state/logedex" "$HOME/.local/state/logedex/src"

docker run -d --name logedex \
  --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.local/state/logedex:/data" \
  -v "$HOME/.local/state/logedex/src:/edit" \
  -e EDIT_SRC_HOST="$HOME/.local/state/logedex/src" \
  -e LOCAL_LABEL="$(hostname -s)" \
  logedex
```

A few notes on that command:

- **Create the directories first.** The server runs as root inside the container, so
  anything it writes into a mount it created lands root-owned and you can't edit it.
  A directory that already exists arrives owned by you. (Or pass
  `-e STATE_UID="$(id -u)" -e STATE_GID="$(id -g)"` and it works that out instead.)
- **`--network host` and `LOCAL_LABEL`** are what make a multi-host list work. Both are
  explained under [Running a fleet](#running-a-fleet); on one box you can leave them alone.
- **`/data`** is where the host list and alert rules are persisted. Mount something there
  or they go away with the container.
- **`/edit`** is the app's own source, which the container serves out of. See
  [Live editing](#live-editing).

**The Docker socket is the only grant it needs** — no `--privileged`, no BPF
capabilities, no host PID namespace. That socket is also the whole security story: the
Docker API has no read-only mode, so grant it as you'd grant docker access, and don't
put the port on the public internet without something in front of it.

Other targets: `make down`, `make logs`, `make dev` (run from a checkout with
`node --watch`, no container), `make demo` / `make demo-stop`.

### Pull instead of build

`make push` publishes a multi-arch image to `ghcr.io/yeet-src/logedex`, which skips the
clone and the build entirely:

```sh
docker run -d --name logedex --network host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v "$HOME/.local/state/logedex:/data" \
  -e LOCAL_LABEL="$(hostname -s)" \
  ghcr.io/yeet-src/logedex:latest
```

> [!NOTE]
> An anonymous pull of that image currently returns `401`, so it is either unpublished
> or still private. A package GHCR creates is private until someone changes it at
> `github.com/orgs/yeet-src/packages`. Until that's done, clone and `make up`.

## Running a fleet

One instance per box. Run the manual install on **every host you want logs from**, then pick
one as the box you point a browser at. That instance fans out to the others by calling the
same endpoints it answers for itself, so there's nothing extra to install on the ones it
reaches.

Add the others in the top bar (`box-two.lan:8080`, `https://logs.example.com`, …), or
declare them up front:

```sh
make up HOSTS="box-two.lan:8080 box-three.lan:8080" LOCAL_LABEL=web-01
```

None of this is handled for you:

- **Reachability is yours.** No discovery, no registration, no tunnel. You type a URL and
  that box has to answer on it from where the viewing instance sits.
- **Names resolve because of `--network host`.** The default shares the host's network
  namespace, so the container reads the host's own `resolv.conf` and loopback resolvers
  (systemd-resolved, Tailscale MagicDNS) still answer. On a bridge they won't: add hosts by
  IP, or pass `make up NET= DNS=100.100.100.100`.
- **`LOCAL_LABEL` is what a row is called.** Set it per box and the sidebar reads `web-01`
  instead of a hostname you have to decode. `make up` defaults it to the machine's
  hostname.

Only the viewing box needs to be signed in to yeet; see [Login](#login). Hosts in one list
don't have to agree on a yeetd version, since each answers for itself.

Walking a stack of boxes through the same two commands is the part to hand to an agent.

## Live editing

Every run mounts the app's own source out to the host and serves from there, so you can
rewrite any part of it while it keeps serving. No rebuild, no restart, no `docker exec`.
It's built for pointing an AI agent at the dashboard.

```sh
make edit           # the same as `make up`, then prints where the source landed
```

The source lands at `~/.local/state/logedex/src` by default. Save a `.js` file under
`server/`, `shared/` or `agent/` and the server restarts itself in about a second, with
open panes reconnecting on their own; save something under `server/public/` and the
dashboard offers you a reload in the corner. If an edit doesn't parse, the server stays
down until you fix it and the crash is in `.logedex/server.log`.

Your edits survive restarts and image upgrades. The mount is the source of truth once
seeded, and the startup log tells you when the image has diverged from it. To go back:

```sh
make up EDIT_RESET=1        # discard the edits, re-seed from the image
```

The `Dockerfile`, entrypoint and `Makefile` are deliberately not in there, since changing
them needs a rebuild anyway.

[`AGENTS.md`](AGENTS.md) carries what reading the source won't tell you: boot order, the
test command, and the isolate's missing globals (no `fetch`, no `fs`, no `Intl`) that make
`agent/` unlike everything around it. [`CLAUDE.md`](CLAUDE.md) points at the same file, so
either name works.

<!-- <img src="assets/features/live-edit.gif" alt="Editing a file on the host and seeing the dashboard change" width="820"> -->

> **What you're granting.** That directory is code this container executes, and the
> container holds the Docker socket, so anything that can write to it has root on the box.
> Nothing is writable over HTTP (there is deliberately no endpoint that changes a file),
> and `/app` inside the image is never touched. If you don't want it, don't mount `/edit`:
> the app still runs, with the source reachable only via `docker exec`.

## Features

<!-- Feature clips go in assets/features/<name>.gif. See AGENTS.md for the naming
     convention and the capture checklist. Uncomment each <img> as its clip lands. -->

### A host list you type into

A LAN name or a public URL, kept in a JSON file across restarts. Each box is asked what
it calls itself, so a row reads `web-02` rather than `box-two.lan:8080`. Reachability is
your problem: no discovery, no tunnel, no registration.

<!-- <img src="assets/features/hosts.gif" alt="Adding a host by URL and seeing its containers appear" width="820"> -->

### Containers per host, running or stopped

Hosts collapse to a line with a count, one box narrows every host at once (type,
`↑`/`↓`, `Enter` to attach), and the sidebar folds to a rail (`«`, or ctrl+B) when the
logs want the width.

<!-- <img src="assets/features/sidebar.gif" alt="Filtering the container list across every host and attaching one" width="820"> -->

### Log panes, side by side

Each is a live subscription. stderr reads brighter than stdout, ANSI colour from the
container is preserved, timestamps are docker's, and a stopped container replays what it
wrote then says `ended`. Drag the seam between panes to resize (arrow keys work too);
double-click to even them out.

<!-- <img src="assets/features/panes.gif" alt="Four panes from three hosts, resized by dragging the seam" width="820"> -->

### One time range across every pane

`live`, a lookback (`15m`/`1h`/`6h`), or a custom window. Every open pane jumps
together. This is the feature the whole layout exists for: lining up one five-second
window across six containers is a single drag rather than six.

<!-- <img src="assets/features/timerange.gif" alt="Every pane jumping to the same window at once" width="820"> -->

### A scrubber spanning the history you actually have

Its left edge is the oldest line the open panes can reach, **measured rather than
guessed** (`/api/oldest` asks each host). Drag the handles to pick a window; the right
handle at the end means keep following.

<!-- <img src="assets/features/scrubber.gif" alt="Dragging the scrubber handles to pick a window" width="820"> -->

### Combined panes

The merge glyph in a pane's header pulls other hosts' logs into it, ordered by timestamp
and colour-coded per stream. It suggests the same service elsewhere in the fleet, so the
usual case is one click, and hitting it again adds a third host to the two already there.

If two hosts' clocks disagree by more than two seconds, the pane says so
(`⚠ clocks differ ~Ns`) rather than ordering lines confidently and wrongly. Interleaving
by timestamp is only as good as the clocks behind it, and silently getting that wrong is
worse than not offering the feature.

<!-- <img src="assets/features/merge.gif" alt="Merging the same service from three hosts into one interleaved pane" width="820"> -->

### Two filter boxes

One keeps the lines that match, one hides the lines that do, so `/health` flooding a pane
is one word away from gone. Terms are space-separated and AND-ed, `"quoted phrases"`
work, `-health` excludes, matching is case-insensitive, and both boxes apply to every
pane as you type, with nothing re-fetched. A multi-line entry like a traceback is filtered
as one thing.

**No regex, by design.** A pattern typed in a browser would be compiled and run inside
the yeet isolate, once per log line, on a production host. A catastrophically
backtracking pattern there doesn't just fail slowly, it can wedge the daemon for every
script on that box. Substring terms cost the same on every input, so the worst a query
can do is match nothing.

<!-- <img src="assets/features/filters.gif" alt="Typing in the keep and hide boxes, with every pane narrowing live" width="820"> -->

### Alerts to Slack

The bell in a pane's header takes a regex and a Slack channel. The rule runs whether or
not a tab is open, sends the lines around the match, and is rate limited (five minutes by
default). Slack has to be paired with your yeet account first at
[yeet.cx/settings](https://yeet.cx/settings?utm_source=github&utm_medium=readme&utm_campaign=logedex).

Alerts *do* take a regex where filters don't, because a rule is saved once by hand rather
than typed per keystroke. Before a pattern is ever stored it's run in a **worker thread**
against inputs built to trigger the common backtracking shapes, and terminated if it
doesn't come back inside the budget. You cannot time a regex on the thread you care about
(there's no step limit and no interrupt in JS regex), so the canary runs somewhere
killable. Costs about 30ms per save.

<!-- <img src="assets/features/alerts.gif" alt="Creating an alert rule and receiving it in Slack" width="820"> -->

### Two themes

The top-bar button switches between **yeet mode** (dark, the default) and **pokédex mode**
(light, with creature icons). Remembered per browser. The sprites that ship are
placeholders, so drop your own into `server/public/sprites/` and reload.

<!-- <img src="assets/features/themes.gif" alt="Switching between yeet mode and pokedex mode" width="820"> -->

## Login

The dashboard is gated on **this box being signed in to yeet** — the same door the rest
of the tooling uses, so there's no second credential. Open it on a box that isn't signed
in and it offers a **sign in with yeet** button that drives the ordinary device flow.
For a deployment, skip the click:

```sh
make up YEET_AUTH_KEY=...       # or REQUIRE_LOGIN=0 to drop the gate entirely
```

Only the box you point a browser at needs to be signed in; the ones it fans out to can
stay signed out. The gate covers the UI and nothing else. `/api/*` stays open, because
the yeet daemon underneath answers without any of this. **If the logs themselves need
protecting, that's a network boundary**: a tailnet, a VPN, or a reverse proxy with real
auth.

## Environment

| var           | default              | meaning                                                             |
| ------------- | -------------------- | ------------------------------------------------------------------- |
| `PORT`        | `8080`               | port the dashboard and the agent API are served on                  |
| `HOSTS`       | —                    | space/comma-separated host URLs to add at startup                   |
| `LOCAL_LABEL` | this machine's hostname | what to call this box in the UI                                  |
| `HOSTS_FILE`  | `/data/hosts.json`   | where the host list is persisted (`""` disables persistence)        |
| `ALERTS_FILE` | `/data/alerts.json`  | where alert rules are persisted (`""` disables persistence)         |
| `TAIL`        | `500`                | log lines buffered per container, to backfill a new viewer          |
| `MAX_WINDOW`  | `86400`              | widest history one request may replay, in seconds (`0` = no cap)    |
| `REQUIRE_LOGIN` | `1`                | dashboard asks for a yeet login; `0` turns the gate off              |
| `YEET_AUTH_KEY` | —                  | register the host non-interactively, so the gate is already satisfied |
| `EDIT_DIR`    | `/edit`              | where the app runs from *inside* the container                       |
| `EDIT_SRC`    | `$STATE/src`         | `make` only: where that directory is on the **host**                 |
| `EDIT_SRC_HOST` | —                  | the host path, purely so the UI can name it                          |
| `EDIT_RESET`  | `0`                  | `1` discards what's in there and re-seeds from the image on start    |
| `DNS`         | —                    | `make up` only: a resolver for the container                         |
| `NET`         | `host`               | `make up` only: `host` shares the host's netns; `NET=` uses a bridge |
| `YEET_BIN`    | `yeet`               | path to the `yeet` binary                                           |
| `AGENT_DIR`   | `../agent`           | where `logstream.js`, `alert.js` and `caps.js` live                 |
| `POSTHOG_KEY` | a Logédex project key | product analytics for the dashboard; `""` turns it off entirely |
| `POSTHOG_HOST` | `https://ph.yeet.cx` | the PostHog proxy the browser loads from and reports to             |
| `POSTHOG_DEBUG` | `0`                | `1` logs every event to the browser console                         |

## Requirements

Linux, Docker, and yeetd on each host (the image installs its own). The graph's
`docker_logs` subscription needs yeetd **v0.19 or newer**; on v0.20+ a freshly attached
pane also backfills history from docker itself. Hosts in one list don't have to agree on
a version, since each answers for itself.

Not macOS/Windows Docker Desktop as a *target*: that's a VM, so you'd be listing the VM's
containers. It's fine as the browser you view from.

## FAQs

**Do I need a log shipper, an agent, or an index?**
No. Each box runs one container that reads its own Docker socket through the yeet system
graph. Nothing is ingested, nothing is stored centrally, and there's no pipeline to fall
behind. The trade is that no index means no search over history: a pane holds the last
2000 lines of the window you picked, not everything your driver kept.

**Does this need privileged access or eBPF?**
No. The Docker socket and a port, that's the whole grant. No `--privileged`, no BPF
capabilities, no host PID namespace, no BTF mount. Note that the socket is itself
root-equivalent on the host, so "unprivileged container" is not the same as "harmless".

**Why can't I find a line I know exists?**
Almost always the 2000-line pane cap or the time range. A pane holds the last 2000 lines
of the window you selected, and the filters run over those lines rather than over your
logs. Narrow the range and the same query reaches further back.

**Is it safe to put this on the internet?**
Not as-is. The login gate covers the UI only, `/api/*` answers without it, and the
container holds a root-equivalent socket. Put it on a tailnet or behind a reverse proxy
with real auth. The port being reachable is the thing to control.

**How is this different from Loki, ELK, or `docker logs` in six terminals?**
Loki and ELK index; they answer "how many errors last Tuesday" and Logédex cannot. Six
terminals show you the same streams but leave you to line up timestamps by eye, which is
the part that actually costs time. Logédex sits in the middle: no pipeline to run, one
time range across every pane, and streams from different hosts interleaved into one
reading order.

## How it works

Every instance plays two roles, which is why it stays small:

```
browser ──► HUB role                     AGENT role ──► yeetd ──► docker
            /api/containers  ─┬─ local ──────┘         (system graph)
            /api/logs         │
                              └─ remote ──► http://box-two:8080/api/local/…
                                                 (same endpoints, other box)
```

The **agent role** answers for one box: `/api/local/containers` is a
`docker { list_containers }` graph query, and `/api/local/logs` is an SSE stream fed by a
`docker_logs` subscription running in the yeet daemon's isolate (`agent/logstream.js`).
The **hub role** calls those endpoints (in-process for the local host, over HTTP for
everyone else) and serves the UI. A remote host isn't a different kind of thing to talk
to, so there's one protocol, not two.

```
agent/logstream.js       the isolate: docker_logs subscription → JSON lines

shared/search.js         query parsing + matching — used by all three runtimes
shared/limits.js         the window cap — browser offers it, server enforces it
shared/alertrule.js      the shape and limits of an alert rule

server/index.js          HTTP routes for both roles
server/graph.js          one-shot graph reads (the container list)
server/isolate.js        run an agent isolate, parse its JSON lines
server/logs.js           local log streams: fan-out, tail buffer, lifecycle
server/hosts.js          the host list, persisted
server/remote.js         calling another host's agent API (list + SSE relay)
server/auth.js           the yeet login gate
server/alerts.js         alert rules: watches, matching, delivery
server/redos.js          the worker-thread canary that vets an alert's regex

server/public/           the dashboard (plain DOM, no framework, no CDN)
server/public/order.js   line ordering, merge defaults, stream labels
server/public/entries.js grouping lines back into multi-line entries
server/public/ansi.js    escape sequences → text plus styled runs
server/public/edit.js    the live-edit panel, and the agent briefing it prints
```

Run the tests with `cd server && npm test`. Node's built-in runner, nothing to install.

### HTTP surface

| route | what it does |
| ----- | ------------ |
| `GET /` | the dashboard |
| `GET /api/containers` | every host's containers, in one response |
| `GET /api/logs?host=…&container=…[&since=…][&until=…][&find=…]` | SSE, routed to that host |
| `GET /api/oldest?host=…&container=…` | oldest reachable line, for the scrubber's left edge |
| `GET /api/hosts` · `POST` · `DELETE ?id=…` | the host list |
| `GET /api/alerts[?caps=recheck]` | alert rules, plus whether Slack is connected |
| `POST /api/alerts` · `DELETE ?id=…` | create or replace a rule · delete one |
| `POST /api/alerts?test=<id>` | deliver that rule's alert now, ignoring its cooldown |
| `GET /api/local/containers` | this host's containers (the agent role) |
| `GET /api/local/logs?container=…[&since=…][&until=…][&find=…]` | this host's log stream (the agent role) |
| `GET /api/local/oldest?container=…` | when this host's history for it starts (the agent role) |
| `GET /api/edit` | whether live-edit mode is on, and where the source is (read-only) |
| `GET /api/sprites` · `GET /sprites/<name>.<ext>` | creature icons for the pokédex theme |
| `GET /healthz` | liveness, host count, attached streams |

## License

GPL-2.0

---

Built with [yeet](https://yeet.cx/docs/?utm_source=github&utm_medium=readme&utm_campaign=logedex), a JS runtime for writing eBPF programs on Linux machines. Join us on [discord](https://discord.gg/JxVseaAVAU?utm_source=github&utm_medium=readme&utm_campaign=logedex).
