# Logédex

> **Container logs from every host you run, side by side in one browser tab.** Enter a host's URL, get its containers, attach the ones you care about — from any host — and read the streams next to each other.

<p align="center">
  <img src="https://img.shields.io/badge/platform-Linux-1793D1" alt="Linux">
  <img src="https://img.shields.io/badge/built%20with-yeet%20system%20graph-8A2BE2" alt="yeet system graph">
  <img src="https://img.shields.io/badge/deps-zero%20runtime%20npm-4fc1ff" alt="no runtime dependencies">
  <img src="https://img.shields.io/badge/render-native%20DOM%20%C2%B7%20no%20CDN-3DA639" alt="native browser components">
</p>

<p align="center">
  <img src="assets/logedex.gif" alt="Logédex — container logs from several hosts, side by side in one browser tab" width="820">
</p>

**Logédex puts `docker logs` from your whole fleet in one tab.** Attach any container on
any box; each pane is a live subscription. One time range moves every pane at once, so
lining up 04:08:54–04:08:59 across six containers on four hosts is a drag of one slider.
Combine several streams into a single pane and read them interleaved by timestamp — the
same service on three boxes as one story.

Built on the [yeet](https://yeet.cx) **system graph**, which already models the Docker
API: no agent protocol, no log shipper, no index, no eBPF.

> [!TIP]
> **Every instance is both halves.** The box you point a browser at fans out to the
> others by calling the exact endpoints it answers for itself. Nothing registers and
> nothing is discovered — you type a URL.

## Quick start

Run this on **every host you want logs from** — one instance per box:

```sh
make up                              # build + run detached  → http://localhost:8080
```

Then open whichever one you want as your view and add the others in the top bar
(`box-two.lan:8080`, `https://logs.example.com`, …). Or declare them up front:

```sh
make up HOSTS="box-two.lan:8080 box-three.lan:8080" LOCAL_LABEL=web-01
```

The equivalent `docker run`, if you'd rather not use the Makefile:

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
- **`--network host`** is what makes adding a host *by name* just work: the container
  reads the host's own `resolv.conf`, so loopback resolvers like systemd-resolved or
  Tailscale MagicDNS still answer. On a bridge, add remote hosts by IP, or pass
  `make up NET= DNS=100.100.100.100`.
- **`LOCAL_LABEL`** names this box in the UI. Inside a container `hostname` is the
  container id, so pass it by hand (`make up` does it for you).
- **`/data`** is where the host list and alert rules are persisted — mount something
  there or they go away with the container.
- **`/edit`** is the app's own source, which the container serves out of. See
  [Live editing](#live-editing).

**The Docker socket is the only grant it needs** — no `--privileged`, no BPF
capabilities, no host PID namespace. That socket is also the whole security story: the
Docker API has no read-only mode, so grant it as you'd grant docker access, and don't
put the port on the public internet without something in front of it.

Other targets: `make down`, `make logs`, `make dev` (run from a checkout with
`node --watch`, no container), `make demo` / `make demo-stop` (three containers logging
like real services, so there's something to look at).

## What you're looking at

- **A host list you type into.** A LAN name or a public URL, kept in a JSON file across
  restarts. Each box is asked what it calls itself, so a row reads `web-02` rather than
  `box-two.lan:8080`. Reachability is your problem — no discovery, no tunnel.
- **Containers per host, running or stopped.** Hosts collapse to a line with a count,
  one box narrows every host at once (type, `↑`/`↓`, `Enter` to attach), and the sidebar
  folds to a rail (`«`, or ctrl+B) when the logs want the width.
- **Log panes, side by side.** Each is a live subscription. stderr reads brighter than
  stdout, ANSI colour from the container is preserved, timestamps are docker's, and a
  stopped container replays what it wrote then says `ended`. Drag the seam between panes
  to resize (arrow keys work too); double-click to even them out.
- **One time range across every pane.** `live`, a lookback (`15m`/`1h`/`6h`), or a custom
  window — every open pane jumps together.
- **A scrubber spanning the history you actually have.** Its left edge is the oldest line
  the open panes can reach, measured rather than guessed. Drag the handles to pick a
  window; the right handle at the end means keep following.
- **Combined panes.** The merge glyph in a pane's header pulls other hosts' logs into it,
  ordered by timestamp and colour-coded per stream. It suggests the same service
  elsewhere in the fleet, so the usual case is one click — and hitting it again adds a
  third host to the two already there. If two hosts' clocks disagree, the pane says so
  (`⚠ clocks differ ~Ns`) rather than ordering lines confidently and wrongly.
- **Two filter boxes.** One keeps the lines that match, one hides the lines that do, so
  `/health` flooding a pane is one word away from gone. Terms are space-separated,
  `"quoted phrases"` work, and both apply to every pane as you type — nothing is
  re-fetched. A multi-line entry like a traceback is filtered as one thing. No regex, by
  design. A pane holds 2000 lines, so "no matches" means "not in the lines loaded" —
  narrow the time range to search further back.
- **Alerts.** The bell in a pane's header takes a regex and a Slack channel. The rule
  runs whether or not a tab is open, sends the lines around the match, and is rate
  limited to one message per five minutes. Slack has to be paired with your yeet account
  first at [yeet.cx/settings](https://yeet.cx/settings).
- **Two themes.** The top-bar button switches between **yeet mode** (dark, the default)
  and **pokédex mode** (light, with creature icons). Remembered per browser. The sprites
  that ship are placeholders — drop your own into `server/public/sprites/` and reload.

A window is capped at one day wide by default (`MAX_WINDOW`), since `since` two months
back makes docker replay every line to a browser that shows the last 2000. Width, not
age: a one-hour window from six weeks ago is fine. An over-wide window is trimmed at its
far edge and the pane shows `⚠ trimmed to 1d`.

## Login

The dashboard is gated on **this box being signed in to yeet** — the same door the rest
of the tooling uses, so there's no second credential. Open it on a box that isn't signed
in and it offers a **sign in with yeet** button that drives the ordinary device flow.
For a deployment, skip the click:

```sh
make up YEET_AUTH_KEY=...       # or REQUIRE_LOGIN=0 to drop the gate entirely
```

Only the box you point a browser at needs to be signed in; the ones it fans out to can
stay signed out. The gate covers the UI and nothing else — `/api/*` stays open, because
the yeet daemon underneath answers without any of this. **If the logs themselves need
protecting, that's a network boundary**: a tailnet, a VPN, or a reverse proxy with real
auth.

## Live editing

Every run mounts the app's own source out to the host and serves from there, so you can
rewrite any part of it while it keeps serving — no rebuild, no restart, no `docker exec`.
It's built for pointing an AI agent at the dashboard.

```sh
make edit           # the same as `make up`, then prints where the source landed
```

The source lands at `~/.local/state/logedex/src` by default. Save a `.js` file under
`server/`, `shared/` or `agent/` and the server restarts itself in about a second, with
open panes reconnecting on their own; save something under `server/public/` and the
dashboard offers you a reload in the corner. If an edit doesn't parse, the server stays
down until you fix it and the crash is in `.logedex/server.log`.

Your edits survive restarts *and image upgrades* — the mount is the source of truth once
seeded, and the startup log tells you when the image has diverged from it. To go back:

```sh
make up EDIT_RESET=1        # discard the edits, re-seed from the image
```

The `Dockerfile`, entrypoint and `Makefile` are deliberately not in there, since changing
them needs a rebuild anyway.

> **What you're granting.** That directory is code this container executes, and the
> container holds the Docker socket — so anything that can write to it has root on the
> box. Nothing is writable over HTTP (there is deliberately no endpoint that changes a
> file), and `/app` inside the image is never touched. If you don't want it, don't mount
> `/edit`: the app still runs, with the source reachable only via `docker exec`.

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
| `POSTHOG_KEY` | a Logédex project key | product analytics for the dashboard; `""` turns it off — see [Analytics](#analytics) |
| `POSTHOG_HOST` | `https://ph.yeet.cx` | the PostHog proxy the browser loads from and reports to             |
| `POSTHOG_DEBUG` | `0`                | `1` logs every event to the browser console                         |

## Analytics

The dashboard reports product analytics to PostHog through the yeet proxy at `ph.yeet.cx`.
`POSTHOG_KEY=""` turns it off, and then no script is fetched and nothing is sent.

**None of your logs are in it, and none of your infrastructure is either.** Autocapture,
session recording and exception autocapture are off outright — each of them would read
the screen, which here is a fleet's production output. Events describe the interaction,
never its subject: `filter_used` carries how many terms you typed and roughly how much
they narrowed, never the query. Counts, kinds and booleans go; names, labels, URLs,
patterns and anything free-text do not. The one thing tied to you is the yeet owner id
the box is signed in as. See
[`server/public/analytics.js`](server/public/analytics.js).

## Requirements

Linux, Docker, and yeetd on each host (the image installs its own). The graph's
`docker_logs` subscription needs yeetd **v0.19 or newer**; on v0.20+ a freshly attached
pane also backfills history from docker itself. Hosts in one list don't have to agree on
a version — each answers for itself.

Not macOS/Windows Docker Desktop as a *target*: that's a VM, so you'd be listing the VM's
containers. It's fine as the browser you view from.

## How it works

Every instance plays two roles, which is what keeps it small:

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
The **hub role** calls those endpoints — in-process for the local host, over HTTP for
everyone else — and serves the UI. A remote host isn't a different kind of thing to talk
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

server/public/           the dashboard (plain DOM, no framework, no CDN)
server/public/order.js   line ordering, merge defaults, stream labels
server/public/entries.js grouping lines back into multi-line entries
server/public/ansi.js    escape sequences → text plus styled runs
```

Run the tests with `cd server && npm test` — node's built-in runner, nothing to install.

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
