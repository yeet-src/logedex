// The dashboard: a host list on the left, attached log streams side by side on
// the right. No framework, no CDN — plain DOM against two JSON endpoints and one
// SSE stream per attached container.
//
//   GET /api/containers   every host's containers in one response
//   /api/hosts            add / remove hosts
//   GET /api/logs?host=…&container=…[&since=…][&until=…]   SSE per stream
//
// A pane holds one or more MEMBERS, a member being one (host, container) stream.
// A plain pane has one; a merged pane has several and interleaves them in
// timestamp order, which is how you read the same service on two boxes as one
// story. Single-member panes are not a special case of the code — they're the
// same pane with one member, which keeps the range handling and lifecycle in one
// place instead of two.

import { blockCross, clockSpread, localTime, memberLabels, mergeCandidates, mergeWatermark, posToTime, pushWithin, splitAtWatermark, timeToPos, tsKey, zoneLabel } from "/order.js";
import { buildQuery, matchRanges, matches, parseQuery } from "/search.js";
import { entryOf, newEntryState } from "/entries.js";
import { parseAnsi } from "/ansi.js";
import { clampWindow, DEFAULT_MAX_WINDOW_SEC, describeCap } from "/limits.js";
import { compileGuarded, CONTEXT_MAX, PATTERN_MAX } from "/alertrule.js";
import { setupEdit } from "/edit.js";
import { setupTheme } from "/theme.js";
import { loadSprites, spriteForPane, sliderSprites } from "/sprites.js";
import { identify, initAnalytics, track } from "/analytics.js";

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

/* SVG needs its own namespace — `createElement("svg")` makes an unknown HTML element
 * that renders as nothing at all, which is a silent and baffling failure. */
const SVG_NS = "http://www.w3.org/2000/svg";
const svg = (tag, attrs) => {
  const n = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
};

/**
 * The git-merge glyph: a trunk with a branch curving into it.
 *
 * Stroked rather than filled, and drawn here rather than copied from an icon set.
 * Every other mark in this UI is a 1px rule, so a solid shape would be the one heavy
 * object in the chrome — and at 14px the difference between a stroke and a fill is the
 * difference between "part of the interface" and "a sticker on it".
 *
 * The geometry is one quarter-circle: the branch stem drops from its dot, the elbow
 * turns through 90°, and the horizontal run ends exactly on the trunk. Radius and
 * endpoints are picked so the arc's tangents are vertical at one end and horizontal at
 * the other — anything else leaves a visible kink where the curve meets the line.
 */
function mergeIcon() {
  const icon = svg("svg", {
    viewBox: "0 0 16 16", width: 18, height: 18,
    fill: "none", stroke: "currentColor", "stroke-width": 1.5,
    "stroke-linecap": "round", "aria-hidden": "true", focusable: "false",
  });
  icon.append(svg("circle", { cx: 5, cy: 3.4, r: 1.6 }));      // trunk, top
  icon.append(svg("circle", { cx: 5, cy: 12.6, r: 1.6 }));     // trunk, bottom
  icon.append(svg("path", { d: "M5 5v6" }));                   // the trunk itself
  icon.append(svg("circle", { cx: 11.5, cy: 3.4, r: 1.6 }));   // the branch
  icon.append(svg("path", { d: "M11.5 5v1.4a3.1 3.1 0 0 1-3.1 3.1H5" }));
  return icon;
}

/* The alert affordance: a bell, drawn the same way as the merge glyph — stroked paths inheriting
 * `currentColor`, so hover and focus need no rules of their own.
 *
 * A bell rather than a letter or a dot because this is the one control in the header that reaches
 * outside the browser: everything else here changes what you're looking at, and this one sends
 * messages to a Slack channel at 3am. Worth being the recognisable shape. */
function alertIcon() {
  const icon = svg("svg", {
    viewBox: "0 0 16 16", width: 18, height: 18,
    fill: "none", stroke: "currentColor", "stroke-width": 1.5,
    "stroke-linecap": "round", "stroke-linejoin": "round",
    "aria-hidden": "true", focusable: "false",
  });
  // The body: a dome on a flared skirt, closed along the bottom edge.
  icon.append(svg("path", { d: "M4 11V7a4 4 0 0 1 8 0v4l1.2 1.6H2.8L4 11Z" }));
  // The clapper, as an arc rather than a circle — a filled dot at this size reads as a smudge.
  icon.append(svg("path", { d: "M6.5 13.2a1.8 1.8 0 0 0 3 0" }));
  return icon;
}

/**
 * A pokéball — one per pane header, and one per container in the sidebar list.
 *
 * Drawn here rather than fetched, for the same reason as the merge glyph above: no CDN,
 * no icon font, and the parts have to be individually styleable — every colour comes from
 * a custom property so the CSS decides what it looks like, including hiding it outright
 * in yeet mode. Nothing about it is conditional in JS: the ball is in every pane header
 * in both themes and `display: none` is what makes it a pokédex-only thing, so switching
 * theme stays a single attribute on <html> and never re-renders a pane.
 *
 * It also earns its place, which is the difference between a mark and a sticker. `.pb`
 * carries the container's state, so the ball is FULL when the container is running and
 * OPEN — hollow, no creature in it — when it has stopped. That's the one joke the object
 * actually supports: a pane is a container you caught. It is never the only signal, in
 * keeping with the rest of this interface: the state text beside it says the same thing
 * in words, so nothing is lost if the ball reads as decoration to you.
 *
 * Geometry: r=7 on a 16-box, split on the horizontal centre line. The two halves are
 * separate arcs rather than one circle with a band drawn over it, because the band has to
 * sit exactly on the seam — a stroked line across a filled circle lands half a pixel off
 * at this size and the ball looks cracked.
 *
 * @param {number} size  drawn width and height in px. The one number that differs between the
 *   two places this appears: a pane header can afford 38px, a row in a list of forty can't.
 *   Everything scales with it — the viewBox does the work, and the stroke widths are in user
 *   units, so the small one is the same drawing rather than a thinner one.
 */
function pokeball(size = 38) {
  const icon = svg("svg", {
    viewBox: "0 0 16 16", width: size, height: size,
    class: "pb", "aria-hidden": "true", focusable: "false",
  });
  // Top and bottom shells: arcs from the left of the seam to the right of it, one over
  // the top and one under the bottom, each closed back along the seam.
  icon.append(svg("path", { class: "pb-top", d: "M1 8A7 7 0 0 1 15 8Z" }));
  icon.append(svg("path", { class: "pb-bottom", d: "M1 8A7 7 0 0 0 15 8Z" }));
  icon.append(svg("circle", { class: "pb-edge", cx: 8, cy: 8, r: 7 }));
  icon.append(svg("path", { class: "pb-band", d: "M1 8h14" }));
  icon.append(svg("circle", { class: "pb-button", cx: 8, cy: 8, r: 2.7 }));
  return icon;
}

const MAX_LINES = 2000;      // per pane, so a chatty container can't eat the tab
const REFRESH_MS = 5000;     // how often the container lists are re-polled
const FLUSH_MS = 100;        // merged panes: how often the settled lines are emitted

/* How long a merged pane waits on a member that has gone quiet before ordering
 * without it. This is the merge's lateness bound: past it, a line from that member
 * can arrive after lines it should have preceded.
 *
 * Two values, because silence means opposite things in the two regimes. In a LIVE
 * tail silence is the normal state of most containers — a member that logs once a
 * minute must not hold up a member that logs constantly, so the bound is short and
 * is hit routinely. In a CLOSED window every member is replaying a finite history as
 * fast as it can, so silence means slow rather than idle and it's worth waiting: the
 * bound is there to survive a host that has genuinely stopped answering, not to be
 * hit in normal use. */
const QUIET_LIVE_MS = 1200;
const QUIET_CLOSED_MS = 6000;
const SKEW_WARN_MS = 2000;   // flag hosts whose clocks disagree by more than this

/** @type {Map<string, object>} paneKey → pane */
const panes = new Map();

/* A line's source, by element: the message as it arrived and its ANSI runs. Weak, so
 * a line trimmed out of the buffer takes its entry with it.
 *
 * The runs have to live off the element because the filter re-renders a line's message
 * — the DOM holds the VISIBLE text, escapes already resolved, so the colours would
 * survive until the first keystroke and then vanish.
 *
 * The text is here for cost rather than correctness. `repaint` runs over every line in
 * every pane on every keystroke, and reading `textContent` back out of the marked-up
 * span it produced last time re-derives, per line per keystroke, a string we were
 * handed in the first place. */
const lineData = new WeakMap();

const memberKey = (hostId, container) => `${hostId}|${container}`;
/** A pane's identity is its member set, order-independent — so merging A+B and
 *  B+A is one pane, and re-merging the same set is a no-op rather than a clone. */
const paneKeyFor = (members) => members.map((m) => memberKey(m.hostId, m.container)).sort().join("+");

let hostRows = [];   // last /api/containers response
let hintTimer = null;

/* The global time range, in the three forms the server takes:
 *   {}                       live tail
 *   {since}                  backfill from then, then keep following
 *   {since, until}           a closed window — loads, then completes
 * A preset resolves to a concrete `since` when clicked; see the note by the range
 * controls for why it isn't continuously re-anchored. */
let range = { since: null, until: null };

/* The widest window this server will replay, in seconds — the server's number, not
 * ours: it enforces the cap (shared/limits.js) and we mirror it so the controls only
 * ever offer a range that will actually be served. Until /api/containers answers, the
 * shared default is the safe assumption. 0 means the operator turned the cap off.
 *
 * A remote host can be configured differently from the hub; if one trims more than
 * this, its streams say so on their status events and the pane reports it. */
let maxWindowSec = DEFAULT_MAX_WINDOW_SEC;

/* The global filter: one box, no modes. It hides non-matching lines in the browser,
 * per keystroke, and re-fetches nothing.
 *
 * There used to be three modes — hide, mark-only, and pushing the query down to each
 * host so the whole time range was searched rather than only the loaded lines. The
 * last one is genuinely more powerful and it cost three buttons, a scope note beside
 * the box, and a rule you had to hold in your head about which of them was honest
 * about what. One box that always does the obvious thing is worth more than the
 * capability was. The server still accepts `find` (see `/api/logs`), so nothing was
 * torn out downstream — the UI just stopped asking. */
let search = { text: "", exclude: "", query: buildQuery("", "") };

/** Should the browser hide lines that don't match? */
const hidingLocally = () => !search.query.empty;

function hint(msg, kind = "") {
  const n = $("#hint");
  n.textContent = msg;
  n.dataset.kind = kind;
  clearTimeout(hintTimer);
  if (msg) hintTimer = setTimeout(() => { n.textContent = ""; n.dataset.kind = ""; }, 6000);
}

// ── host list ───────────────────────────────────────────────────────────────
async function refresh() {
  let body;
  try {
    const res = await fetch("/api/containers", { headers: { accept: "application/json" } });
    body = await res.json();
  } catch (err) {
    hint(`could not reach this server: ${err.message}`, "bad");
    return;
  }
  hostRows = body.hosts ?? [];
  if (Number.isFinite(body.maxWindowSec)) maxWindowSec = body.maxWindowSec;
  renderHosts();
  syncPaneStates();

  // Let the scrubber pick up "now" and any newly-probed stream. It decides for
  // itself whether re-scaling is safe — mid-drag and mid-window, it isn't.
  if (scrubSpan) sizeScrub();
}

/** Every (host, container) pair currently known, flattened — the candidate pool a
 *  merge picks from. */
function allStreams() {
  const out = [];
  for (const row of hostRows) {
    for (const c of row.containers) {
      out.push({ hostId: row.host.id, hostLabel: row.host.label, container: c.name, image: c.image, state: c.state });
    }
  }
  return out;
}

/** Is this (host, container) part of any open pane? Drives the sidebar marker,
 *  which has to account for merged panes too — a container merged into a pane is
 *  just as attached as one with a pane of its own. */
function isAttached(hostId, container) {
  for (const pane of panes.values()) {
    if (pane.members.some((m) => m.hostId === hostId && m.container === container)) return true;
  }
  return false;
}

/** Put each member's container state, as its host most recently reported it, into
 *  the pane header. The stream alone can't tell you this: docker's log
 *  subscription goes quiet when a container stops rather than closing, so a pane
 *  left to report only what the stream says would claim "streaming" over a dead
 *  container forever. */
function syncPaneStates() {
  for (const pane of panes.values()) {
    /* The pane's ball, in pokédex mode: full when there's something running in here,
     * open when there isn't. For a combined pane that's ANY member running, because the
     * ball answers "is this pane still showing me a live system" and one live stream is
     * enough for that — the per-member chips are where the detail lives. */
    let anyRunning = false;
    for (const m of pane.members) {
      const row = hostRows.find((r) => r.host.id === m.hostId);
      const c = row?.containers.find((x) => x.name === m.container);
      const state = row?.error ? "unreachable" : (c?.state ?? "gone");
      if (state === "running") anyRunning = true;
      if (!m.dockerEl) continue;
      /* In a combined pane the chip says the HOST and nothing else — the state rides
       * on its colour and its tooltip. Six chips each spelling out "web-02: running"
       * is a header longer than some of the log lines under it, and the state is the
       * part you only care about when it isn't "running". */
      m.dockerEl.textContent = pane.members.length > 1 ? m.label : state;
      m.dockerEl.dataset.state = state;
      m.dockerEl.title = `${m.hostLabel} · ${state}`
        + ` — ${c?.status ?? row?.error ?? "no longer in this host's container list"}`;
    }
    if (pane.ballEl) pane.ballEl.dataset.state = anyRunning ? "running" : "stopped";
  }
}

/* ── the host sidebar ────────────────────────────────────────────────────────
 *
 * Two things keep a fleet's worth of containers usable in a column: hosts collapse,
 * and a filter narrows every host at once.
 *
 * Collapsed state is per host and lives here rather than in the DOM, because the
 * sidebar is re-rendered wholesale every five seconds by the container poll — anything
 * kept on the elements themselves would be thrown away twelve times a minute. It's
 * intentionally not persisted: it describes what you're looking at right now, not a
 * preference, and a reload is a reasonable moment to see everything again. */
const collapsedHosts = new Set();

/** What's typed in the sidebar's filter, as a query. Shared matcher with the log
 *  filter, so "two terms are AND" means the same thing in both boxes. */
let hostFilter = parseQuery("");
/** The container the ↑/↓ keys have landed on, as `hostId|name`, or null. Kept across
 *  re-renders for the same reason the collapsed set is. */
let hostCursor = null;

/** Does this container match what's typed? Name and image both, since "which box is
 *  running postgres" is asked at least as often as a name is. */
const containerMatches = (c) => hostFilter.empty || matches(`${c.name} ${c.image ?? ""}`, hostFilter);

/** Text with the filter's hits wrapped in <mark>, so it's visible WHY a row survived
 *  — matching on the image is otherwise invisible when you searched a name. */
function markMatches(text, cls) {
  const span = el("span", cls);
  const str = String(text ?? "");
  const ranges = hostFilter.empty ? [] : matchRanges(str, hostFilter);
  if (ranges.length === 0) {
    span.textContent = str;
    return span;
  }
  let at = 0;
  for (const r of ranges) {
    if (r.start > at) span.append(document.createTextNode(str.slice(at, r.start)));
    span.append(el("mark", "", str.slice(r.start, r.end)));
    at = r.end;
  }
  if (at < str.length) span.append(document.createTextNode(str.slice(at)));
  return span;
}

/** Every container currently shown, flattened and in display order — what ↑/↓ walk
 *  and what Enter picks from. */
function visibleContainers() {
  const out = [];
  for (const row of hostRows) {
    if (row.error) continue;
    // A collapsed host still contributes while filtering: the filter overrides the
    // collapse (see renderHosts), so what's on screen is what this returns.
    if (collapsedHosts.has(row.host.id) && hostFilter.empty) continue;
    for (const c of row.containers) {
      if (containerMatches(c)) out.push({ host: row.host, container: c });
    }
  }
  return out;
}

function renderHosts() {
  const root = $("#hosts");
  root.textContent = "";

  let shown = 0;
  for (const row of hostRows) {
    const { host, containers, error } = row;
    const hits = error ? [] : containers.filter(containerMatches);
    // A host with nothing matching is out of the way entirely — leaving an empty card
    // per host turns a filter that found one container into a page of headings.
    if (!hostFilter.empty && hits.length === 0) continue;

    /* Filtering overrides collapse. Hiding a match inside a host you happened to
     * collapse earlier would make the filter look broken, and the collapse was about
     * the unfiltered list anyway. */
    const collapsed = collapsedHosts.has(host.id) && hostFilter.empty;
    const card = el("div", `host${collapsed ? " collapsed" : ""}`);

    const head = el("div", "host-head");
    const toggle = el("button", "host-toggle");
    toggle.setAttribute("aria-expanded", String(!collapsed));
    toggle.append(el("span", "host-caret", collapsed ? "▸" : "▾"));
    toggle.append(el("span", "host-name", host.label));
    // The count is the reason a collapsed host is still useful to look at — it says
    // what's behind the fold without unfolding it.
    const n = hostFilter.empty ? containers.length : hits.length;
    if (!error) toggle.append(el("span", "host-count", String(n)));
    toggle.title = collapsed ? `show ${host.label}'s containers` : `hide ${host.label}'s containers`;
    toggle.addEventListener("click", () => {
      if (collapsedHosts.has(host.id)) collapsedHosts.delete(host.id);
      else collapsedHosts.add(host.id);
      renderHosts();
    });
    head.append(toggle);
    head.append(el("span", "host-url", host.url ?? "local daemon"));
    // The local host is the box serving this page; it isn't ours to remove.
    if (host.url !== null) {
      const rm = el("button", "rm", "×");
      rm.title = `remove ${host.label}`;
      rm.addEventListener("click", () => removeHost(host));
      head.append(rm);
    }
    card.append(head);

    if (collapsed) {
      root.append(card);
      continue;
    }

    if (error) {
      card.append(el("p", "host-error", error));
    } else if (hits.length === 0) {
      card.append(el("p", "empty small", "no containers"));
    } else {
      const list = el("ul", "containers");
      for (const c of hits) {
        const key = memberKey(host.id, c.name);
        const on = key === hostCursor;
        const li = el("li", `container state-${c.state}${isAttached(host.id, c.name) ? " attached" : ""}${on ? " cursor" : ""}`);
        const btn = el("button", "attach");
        /* The state mark, twice over: the square for yeet mode and the ball for pokédex mode,
         * with CSS showing exactly one. Both are always in the markup for the same reason the
         * pane headers do it — switching theme is one attribute on <html> and must never mean
         * re-rendering this list.
         *
         * The ball has two looks where the square has three: it is full when the container runs
         * and greyed out when it doesn't, so `paused` and `restarting` read here as `exited`
         * does. The square still separates them (solid grey vs a hollow ring) in yeet mode, and
         * in both themes the row's `title` and the container's own state text say which. */
        btn.append(el("span", "dot"));
        const mark = pokeball(18);
        mark.dataset.state = c.state === "running" ? "running" : "stopped";
        btn.append(mark);
        btn.append(markMatches(c.name, "cname"));
        btn.append(markMatches(c.image ?? "", "cimage"));
        btn.title = `${c.status ?? c.state} · ${c.shortId}`;
        // A stopped container still has logs worth reading — attaching one
        // replays what it wrote and then reports that it has ended.
        btn.addEventListener("click", () => toggleSingle(host, c));
        li.append(btn);
        // Combining is not offered here. It lives on the open pane's `+`, because
        // it's a thing you decide about a stream you're already reading — see the
        // comment on that button.
        list.append(li);
        shown++;
      }
      card.append(list);
    }
    root.append(card);
  }

  if (hostRows.length === 0) root.append(el("p", "empty", "no hosts"));
  else if (!hostFilter.empty && shown === 0) root.append(el("p", "empty", "nothing matches"));
}

/** Move the keyboard cursor through the visible containers, wrapping at both ends. */
function moveHostCursor(step) {
  const list = visibleContainers();
  if (list.length === 0) return;
  const at = list.findIndex((x) => memberKey(x.host.id, x.container.name) === hostCursor);
  const next = list[(at + step + list.length * 2) % list.length] ?? list[0];
  hostCursor = memberKey(next.host.id, next.container.name);
  renderHosts();
  $("#hosts").querySelector(".container.cursor")?.scrollIntoView({ block: "nearest" });
}

/** Attach whatever the cursor is on — or, if it isn't on anything, the first match.
 *  Typing a few characters and pressing Enter is the whole point of the box. */
function attachHostCursor() {
  const list = visibleContainers();
  if (list.length === 0) return;
  const pick = list.find((x) => memberKey(x.host.id, x.container.name) === hostCursor) ?? list[0];
  toggleSingle(pick.host, pick.container);
}

async function addHost(ev) {
  ev.preventDefault();
  const url = $("#host-url").value.trim();
  const label = $("#host-label").value.trim();
  if (!url) return;
  try {
    const res = await fetch("/api/hosts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url, label }),
    });
    const body = await res.json();
    if (!body.ok) return hint(body.error, "bad");
    /* Not the URL or the label: those name a box inside somebody's network. That a host
     * was added, whether it was already there, and how many there now are. */
    track("host_added", { existing: Boolean(body.existing), hosts: hostRows.length + (body.existing ? 0 : 1) });
    hint(body.existing ? `${body.host.label} was already in the list` : `added ${body.host.label}`);
    $("#host-url").value = "";
    $("#host-label").value = "";
    await refresh();
  } catch (err) {
    hint(`add failed: ${err.message}`, "bad");
  }
}

async function removeHost(host) {
  try {
    const res = await fetch(`/api/hosts?id=${encodeURIComponent(host.id)}`, { method: "DELETE" });
    const body = await res.json();
    if (!body.ok) return hint(body.error, "bad");
  } catch (err) {
    return hint(`remove failed: ${err.message}`, "bad");
  }
  // Any pane with a member on that host is now pointing at a host we don't track.
  // Close the whole pane rather than silently dropping one side of a merge — a
  // merged pane missing a member would keep claiming to interleave both.
  for (const [key, pane] of [...panes.entries()]) {
    if (pane.members.some((m) => m.hostId === host.id)) detach(key, { via: "host_removed" });
  }
  track("host_removed", { hosts: Math.max(0, hostRows.length - 1) });
  hint(`removed ${host.label}`);
  await refresh();
}

// ── the merge picker ────────────────────────────────────────────────────────
let picker = null;

function closePicker() {
  picker?.remove();
  picker = null;
}

/** Identity of a stream within one picker — host and container name, since that
 *  pair is what `attach` keys a pane on. */
const streamId = (s) => `${s.hostId}\x00${s.container}`;

/** Offer the streams `origin` can be interleaved with. Which are ranked first and
 *  which come pre-ticked is decided by `mergeCandidates` (in order.js, with tests)
 *  — the short version is "the same service on other boxes", identified by image
 *  and name rather than name alone.
 *
 *  When that produces a default, the picker doesn't ask the question: it shows the
 *  answer with a confirm button, and puts the alternatives behind a dropdown. The
 *  full tick-list is still there for picking several by hand — one dropdown entry
 *  away — and is what's shown outright when nothing matched well enough to assume. */
function openMergePicker(anchor, origin, candidates, onPick) {
  closePicker();
  const box = el("div", "picker");
  // Anchored to the button, but parented to <body> so the sidebar's 5s re-render
  // doesn't tear the open picker out from under the pointer.
  document.body.append(box);
  picker = box;

  const ranked = mergeCandidates(origin, candidates);
  const preselect = ranked.filter((r) => r.preselect).map((r) => r.stream);
  if (preselect.length > 0) renderConfirm(box, anchor, origin, ranked, preselect, onPick);
  else renderList(box, anchor, origin, ranked, [], onPick);
}

/**
 * The `+` in a pane's header: which streams could join the ones already in it.
 *
 * The suggestion is made against the pane's FIRST member — the stream it was opened
 * from, and the one whose service the pane is about. Ranking against all of them
 * would need a notion of what a mixed pane is "for" that doesn't exist; ranking
 * against the first matches how the pane was built.
 *
 * Members already here are not candidates. That's not only tidiness: `attach` keys a
 * pane on its member set, so re-adding one would resolve to the same pane and the
 * click would do nothing with no explanation.
 */
function openAddPicker(anchor, pane) {
  const here = new Set(pane.members.map((m) => memberKey(m.hostId, m.container)));
  const candidates = allStreams().filter((s) => !here.has(memberKey(s.hostId, s.container)));
  if (candidates.length === 0) return hint("there's nothing else to combine with", "bad");

  // `label` is what the picker's heading says; on a pane that already holds several
  // streams, naming only the first would describe the wrong thing.
  const origin = { ...pane.members[0], label: pane.merged ? "these streams" : pane.members[0].container };
  openMergePicker(anchor, origin, candidates, (picked) => {
    // A pane's identity IS its members, so growing one means opening the wider pane
    // and closing the narrower. The window and the search are global, so the new pane
    // comes up on the same range — it re-reads it rather than inheriting the lines.
    const members = pane.members.map((m) => ({
      hostId: m.hostId, hostLabel: m.hostLabel, container: m.container, image: m.image, state: m.state,
    }));
    track("streams_combined", {
      added: picked.length,
      members: members.length + picked.length,
      hosts: new Set([...members, ...picked].map((m) => m.hostId)).size,
      grew: pane.merged,          // adding a third box to a merge, vs starting one
    });
    detach(pane.key, { via: "recombine" });
    attach([...members, ...picked], { via: "recombine" });
  });
}

/** The confirm view: what we picked, a dropdown to pick otherwise, and one button.
 *  `chosen` is the current selection; the default set is whatever `mergeCandidates`
 *  pre-selected, which may be several streams when a service runs fleet-wide. */
function renderConfirm(box, anchor, origin, ranked, chosen, onPick, focusAlt = false) {
  box.textContent = "";
  box.append(el("div", "picker-head", `combine ${origin.label ?? origin.container} with…`));

  const defaults = ranked.filter((r) => r.preselect).map((r) => r.stream);
  const why = new Map(ranked.map((r) => [streamId(r.stream), r.why]));

  const list = el("div", "picker-list");
  for (const s of chosen) {
    const row = el("div", "picker-row match");
    row.append(el("span", "picker-host", s.hostLabel));
    row.append(el("span", "picker-container", s.container));
    row.append(el("span", "picker-image", s.image ?? ""));
    const reason = why.get(streamId(s));
    if (reason) row.append(el("span", "picker-badge", reason));
    list.append(row);
  }
  box.append(list);

  // The dropdown carries the default set as one entry, then every candidate on its
  // own, then the escape hatch back to the tick-list.
  const pick = el("select", "picker-alt");
  const defaultLabel = defaults.length > 1
    ? `${defaults.length} matching streams`
    : `${defaults[0].hostLabel} · ${defaults[0].container}`;
  const opt = (value, label) => {
    const o = el("option", "", label);
    o.value = value;
    pick.append(o);
  };
  opt("auto", `${defaultLabel} (suggested)`);
  ranked.forEach(({ stream: s, why: w }, i) => {
    opt(String(i), `${s.hostLabel} · ${s.container}${w ? ` — ${w}` : ""}`);
  });
  opt("many", "choose several…");
  // The suggestion is selected unless the reader has already narrowed to one.
  const single = chosen.length === 1 ? ranked.findIndex((r) => streamId(r.stream) === streamId(chosen[0])) : -1;
  pick.value = sameSelection(chosen, defaults) || single < 0 ? "auto" : String(single);

  pick.addEventListener("change", () => {
    if (pick.value === "many") return renderList(box, anchor, origin, ranked, chosen, onPick);
    const next = pick.value === "auto" ? defaults : [ranked[Number(pick.value)].stream];
    renderConfirm(box, anchor, origin, ranked, next, onPick, true);
  });

  const alt = el("div", "picker-change");
  alt.append(el("span", "picker-change-label", "or:"));
  alt.append(pick);
  box.append(alt);

  const { foot, go } = footer("combine", () => {
    closePicker();
    onPick(chosen);
  });
  box.append(foot);

  position(box, anchor);
  // Confirm is the point of this view, so it holds focus and Enter takes it — except
  // right after a dropdown change, where the reader is still choosing.
  (focusAlt ? pick : go).focus();
}

/** The tick-list view: every candidate, ranked, with the reason it ranked where it
 *  did. Reached when nothing matched confidently, or from the dropdown when the
 *  reader wants more than one stream. */
function renderList(box, anchor, origin, ranked, chosen, onPick) {
  box.textContent = "";
  box.append(el("div", "picker-head", `combine ${origin.label ?? origin.container} with…`));

  const ticked = new Set(chosen.map(streamId));
  const list = el("div", "picker-list");
  const boxes = [];
  for (const { stream: s, preselect, why } of ranked) {
    const on = chosen.length > 0 ? ticked.has(streamId(s)) : preselect;
    const row = el("label", `picker-row${on ? " match" : ""}`);
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = on;
    row.append(cb);
    row.append(el("span", "picker-host", s.hostLabel));
    row.append(el("span", "picker-container", s.container));
    row.append(el("span", "picker-image", s.image ?? ""));
    if (why) row.append(el("span", `picker-badge${preselect ? "" : " weak"}`, why));
    list.append(row);
    boxes.push({ cb, stream: s });
  }
  box.append(list);

  box.append(footer("combine", () => {
    const picked = boxes.filter((b) => b.cb.checked).map((b) => b.stream);
    if (picked.length === 0) return hint("pick at least one stream to combine with", "bad");
    closePicker();
    onPick(picked);
  }).foot);

  position(box, anchor);
}

/** Shared footer: the affirmative button, then cancel. */
function footer(label, onGo) {
  const foot = el("div", "picker-foot");
  const go = el("button", "", label);
  const cancel = el("button", "", "cancel");
  go.addEventListener("click", onGo);
  cancel.addEventListener("click", closePicker);
  foot.append(go, cancel);
  return { foot, go };
}

/** Same streams, order-independent — the dropdown has to know whether the current
 *  selection is still the suggested one. */
function sameSelection(a, b) {
  if (a.length !== b.length) return false;
  const ids = new Set(a.map(streamId));
  return b.every((s) => ids.has(streamId(s)));
}

/* Place the picker against its button without letting it leave the viewport.
 *
 * It has to be measured before it can be placed, so this runs after the box is in
 * the DOM: a container low in a long host list anchors near the bottom of the
 * screen, and a picker that simply hangs below it puts the checkboxes and the
 * `interleave` button off-screen — which is the bug this exists to prevent.
 *
 * Preference is below the button; if it doesn't fit and there's more room above, it
 * flips. If neither side fits it takes the roomier one and caps its own height, so
 * the list scrolls internally and the footer stays reachable either way. */
function position(box, anchor) {
  const GAP = 4;
  const EDGE = 8;                       // breathing room against the window edge
  const r = anchor.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;

  const below = vh - r.bottom - GAP - EDGE;
  const above = r.top - GAP - EDGE;

  // Measure the natural height with any CSS cap lifted, so the decision is about
  // the content rather than a stylesheet guess.
  box.style.maxHeight = "";
  const wanted = box.offsetHeight;

  // Both edges are set explicitly every time, so re-positioning can't leave a
  // stale `top` fighting a fresh `bottom`.
  if (wanted <= below || below >= above) {
    box.style.top = `${Math.round(r.bottom + GAP)}px`;
    box.style.bottom = "auto";
    box.style.maxHeight = `${Math.round(below)}px`;
  } else {
    // Flip above: pin the bottom to just over the button so it grows upward.
    box.style.top = "auto";
    box.style.bottom = `${Math.round(vh - r.top + GAP)}px`;
    box.style.maxHeight = `${Math.round(above)}px`;
  }

  // Horizontal: keep it on screen using the real width, not an assumed one.
  const width = box.offsetWidth;
  box.style.left = `${Math.round(Math.max(EDGE, Math.min(r.left, vw - width - EDGE)))}px`;
}

document.addEventListener("click", (ev) => {
  if (picker && !picker.contains(ev.target)) closePicker();
});
document.addEventListener("keydown", (ev) => { if (ev.key === "Escape") closePicker(); });
// An open picker is positioned against a button that moves when the window does.
window.addEventListener("resize", () => closePicker());

// ── the alert picker ────────────────────────────────────────────────────────
/* Setting a rule on the pane you're already reading, which is the only place the question comes
 * up: you see a line you never want to miss again, and the pattern for it is in front of you.
 *
 * A pane's members ARE the rule's targets, so a merged pane produces a rule across every stream in
 * it — including across hosts, which is the ordinary case here (a merged pane is usually one
 * service on several boxes).
 *
 * WHAT THIS DOESN'T DO. It doesn't evaluate anything. The pattern goes to the server, which stores
 * it, watches those containers whether or not this tab is open, and does the matching. Nothing
 * about alerting depends on the browser — see server/alerts.js. */

/** The last answer from /api/alerts, so re-opening a picker is instant. Refreshed on open and
 *  after every change; `caps` inside it has its own TTL on the server. */
let alertsCache = null;

async function loadAlerts({ recheck = false } = {}) {
  const res = await fetch(`/api/alerts${recheck ? "?caps=recheck" : ""}`, { headers: { accept: "application/json" } });
  const body = await res.json().catch(() => null);
  if (!body?.ok) throw new Error(body?.error ?? `alerts unavailable (${res.status})`);
  alertsCache = body;
  return body;
}

/** The rules touching any stream in this pane. Not "exactly this pane's set": if a rule already
 *  watches `api` on web-01, someone looking at a merged api pane needs to see it — otherwise they
 *  write a second rule for the same lines and get two Slack messages per incident. */
function rulesFor(targets) {
  const keys = new Set(targets.map((t) => `${t.hostId}\x00${t.container}`));
  return (alertsCache?.alerts ?? []).filter((r) =>
    (r.targets ?? []).some((t) => keys.has(`${t.hostId}\x00${t.container}`)));
}

function openAlertPicker(anchor, pane) {
  closePicker();
  const box = el("div", "picker");
  document.body.append(box);
  picker = box;

  const targets = pane.members.map((m) => ({ hostId: m.hostId, container: m.container }));
  const label = pane.merged ? `these ${pane.members.length} streams` : pane.members[0].container;

  const draw = () => { renderAlerts(box, anchor, { targets, label, pane }); position(box, anchor); };

  box.append(el("div", "picker-head", `alerts on ${label}`));
  box.append(el("div", "picker-note", "checking…"));
  position(box, anchor);

  loadAlerts().then(draw, (err) => {
    box.textContent = "";
    box.append(el("div", "picker-head", `alerts on ${label}`));
    box.append(el("div", "picker-note bad", String(err.message)));
    position(box, anchor);
  });
}

function renderAlerts(box, anchor, ctx) {
  const { targets, label } = ctx;
  box.textContent = "";
  box.append(el("div", "picker-head", `alerts on ${label}`));

  const caps = alertsCache?.caps ?? {};
  const existing = rulesFor(targets);

  /* Existing rules first, before the form. Someone opening this menu is at least as likely to be
   * checking what's already armed as adding another. */
  if (existing.length) {
    const list = el("div", "picker-list");
    for (const rule of existing) list.append(alertRow(rule, box, anchor, ctx));
    box.append(list);
  }

  /* THE GATE. `yeet.alert` delivers through a Slack workspace connected to this yeet account, and
   * that connection is made at yeet.cx/settings — outside this app. Without it every rule here
   * would save fine and silently never deliver, so the form is replaced by the reason and a link.
   *
   * `slack === null` is NOT this case: it means we couldn't ask (daemon down, not logged in). That
   * shows as a warning above a working form, because refusing to let someone write a rule on the
   * word of a check that didn't run is worse than letting them. */
  if (caps.slack === false) {
    const gate = el("div", "picker-gate");
    gate.append(el("p", "", "Slack isn't connected to this yeet account, so an alert has nowhere to go."));
    const link = el("a", "", caps.settingsUrl ?? "https://yeet.cx/settings");
    link.href = caps.settingsUrl ?? "https://yeet.cx/settings";
    link.target = "_blank";
    link.rel = "noopener";
    gate.append(el("p", "", "Connect a workspace, then come back and re-check:"), link);
    const { foot } = footer("re-check", async () => {
      // Straight through the cache: the operator has just told us the answer changed.
      try { await loadAlerts({ recheck: true }); renderAlerts(box, anchor, ctx); position(box, anchor); }
      catch (err) { hint(String(err.message), "bad"); }
    });
    gate.append(foot);
    box.append(gate);
    return;
  }

  if (caps.slack === null) {
    box.append(el("div", "picker-note bad",
      `couldn't check whether Slack is connected${caps.error ? `: ${caps.error}` : ""}`));
  }

  box.append(alertForm(box, anchor, ctx));
}

/** One existing rule: what it watches, whether it's working, and the two things you can do to it. */
function alertRow(rule, box, anchor, ctx) {
  const row = el("div", "picker-row alert-row");
  row.append(el("span", "picker-container", rule.name));
  row.append(el("code", "alert-pattern", `/${rule.pattern}/${rule.flags ?? ""}`));
  row.append(el("span", "picker-image", rule.targets.map((t) => `${t.hostId}/${t.container}`).join(" + ")));
  row.append(el("span", "picker-badge weak", rule.channel));

  /* State per target, not rolled up: with a rule across three boxes, "one of them is unreachable"
   * is the thing worth knowing and an average would hide it. */
  const bad = (rule.watching ?? []).filter((w) => w.state === "error" || w.state === "ended");
  if (!rule.enabled) {
    row.append(el("span", "picker-badge", rule.disabledReason ? "disabled — see tooltip" : "disabled"));
    if (rule.disabledReason) row.title = rule.disabledReason;
  } else if (bad.length) {
    const badge = el("span", "picker-badge", `${bad.length} not streaming`);
    badge.title = bad.map((w) => `${w.hostId}/${w.container}: ${w.state}`).join("\n");
    row.append(badge);
  }
  if (rule.lastError) {
    const badge = el("span", "picker-badge", "last send failed");
    badge.title = rule.lastError;
    row.append(badge);
  }
  if (rule.contextLines) row.append(el("span", "picker-badge weak", `±${rule.contextLines} lines`));
  if (rule.firedCount) row.append(el("span", "picker-badge weak", `fired ${rule.firedCount}×`));

  const test = el("button", "rm", "test");
  test.title = "send this alert to Slack now, ignoring the cooldown";
  test.addEventListener("click", async () => {
    test.disabled = true;
    try {
      const res = await fetch(`/api/alerts?test=${encodeURIComponent(rule.id)}`, { method: "POST" });
      const body = await res.json().catch(() => null);
      track("alert_rule_tested", { ok: Boolean(body?.ok) });
      if (body?.ok) hint(`sent to ${rule.channel}`);
      else hint(String(body?.error ?? `test failed (${res.status})`), "bad");
    } finally { test.disabled = false; }
  });
  row.append(test);

  const del = el("button", "rm", "×");
  del.title = "delete this rule";
  del.addEventListener("click", async () => {
    const res = await fetch(`/api/alerts?id=${encodeURIComponent(rule.id)}`, { method: "DELETE" });
    const body = await res.json().catch(() => null);
    if (!body?.ok) return hint(String(body?.error ?? "could not delete"), "bad");
    alertsCache.alerts = body.alerts;
    track("alert_rule_deleted", { targets: rule.targets?.length ?? 0, fired_count: rule.firedCount ?? 0 });
    hint(`deleted "${rule.name}"`);
    renderAlerts(box, anchor, ctx);
    position(box, anchor);
  });
  row.append(del);
  return row;
}

/** The new-rule form. Validated here for immediate feedback and again on the server, which is the
 *  copy that counts — see the note atop shared/alertrule.js. */
function alertForm(box, anchor, ctx) {
  const wrap = el("div", "alert-form");
  const field = (labelText, input) => {
    const l = el("label", "");
    l.append(el("span", "", labelText), input);
    wrap.append(l);
    return input;
  };

  const name = field("name", el("input"));
  name.placeholder = "api errors";
  const pattern = field("regex", el("input"));
  pattern.placeholder = "ERROR|FATAL";
  pattern.maxLength = PATTERN_MAX;
  const channel = field("channel", el("input"));
  channel.placeholder = "#alerts";
  const cooldown = field("cooldown (s)", el("input"));
  cooldown.type = "number";
  cooldown.min = "0";
  cooldown.value = String(alertsCache?.defaults?.cooldownSec ?? 300);
  cooldown.title = "the quiet period after one alert; matches inside it are counted, not sent";

  const context = field("context", el("input"));
  context.type = "number";
  context.min = "0";
  context.max = String(CONTEXT_MAX);
  context.value = String(alertsCache?.defaults?.contextLines ?? 3);
  context.title = "log lines to include either side of the matching one. The after-context delays "
    + "the alert by up to two seconds while those lines arrive; 0 sends immediately.";

  const nocase = el("input");
  nocase.type = "checkbox";
  nocase.checked = true;
  const caseLabel = el("label", "alert-check");
  caseLabel.append(nocase, el("span", "", "ignore case"));
  wrap.append(caseLabel);

  const why = el("div", "picker-note");
  wrap.append(why);

  /* Live feedback on the pattern, using the same module the server validates with. It only does
   * the cheap checks — the expensive one (does this pattern backtrack catastrophically) runs in a
   * worker on the server, so a pattern can still be refused on save. */
  const check = () => {
    const out = compileGuarded(pattern.value, nocase.checked ? "i" : "");
    why.textContent = pattern.value && "error" in out ? out.error : "";
    why.classList.toggle("bad", !!(pattern.value && "error" in out));
  };
  pattern.addEventListener("input", check);
  nocase.addEventListener("change", check);

  const { foot, go } = footer("set alert", async () => {
    go.disabled = true;
    try {
      const res = await fetch("/api/alerts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: name.value,
          pattern: pattern.value,
          flags: nocase.checked ? "i" : "",
          channel: channel.value,
          cooldownSec: cooldown.value === "" ? undefined : Number(cooldown.value),
          contextLines: context.value === "" ? undefined : Number(context.value),
          targets: ctx.targets,
        }),
      });
      const body = await res.json().catch(() => null);
      if (!body?.ok) {
        why.textContent = String(body?.error ?? `could not save (${res.status})`);
        why.classList.add("bad");
        // A 409 means Slack went away between opening this and saving — re-render into the gate.
        if (res.status === 409 && body?.caps) { alertsCache.caps = body.caps; renderAlerts(box, anchor, ctx); position(box, anchor); }
        return;
      }
      alertsCache.alerts = body.alerts;
      /* Never the pattern, the channel or the rule's name. A pattern is written to match
       * this deployment's log lines and routinely contains the identifier being hunted;
       * a channel names a team. What's useful is the shape: how many streams one rule
       * covers, and whether the context and cooldown defaults get changed. */
      track("alert_rule_created", {
        targets: ctx.targets.length,
        merged_pane: ctx.pane.merged,
        context_lines: body.alert.contextLines ?? 0,
        cooldown_sec: body.alert.cooldownSec ?? null,
        ignore_case: nocase.checked,
      });
      hint(`alerting on /${body.alert.pattern}/ → ${body.alert.channel}`);
      renderAlerts(box, anchor, ctx);
      position(box, anchor);
    } finally { go.disabled = false; }
  });
  wrap.append(foot);
  setTimeout(() => name.focus(), 0);
  return wrap;
}

// ── panes ───────────────────────────────────────────────────────────────────
function toggleSingle(host, container) {
  const key = paneKeyFor([{ hostId: host.id, container: container.name }]);
  if (panes.has(key)) detach(key);
  else attach([{ hostId: host.id, hostLabel: host.label, container: container.name, image: container.image, state: container.state }]);
}

/**
 * Open a pane over one or more streams.
 * @param {Array<{hostId:string,hostLabel:string,container:string,image?:string,state?:string}>} members
 * @param {object} [opts]
 * @param {string} [opts.via]  how this pane came to be, for analytics. "recombine" is the
 *   close-and-reopen a growing merge does (see openAddPicker) — the same streams, re-keyed,
 *   not somebody attaching a pane.
 */
function attach(members, { via = "sidebar" } = {}) {
  const key = paneKeyFor(members);
  if (panes.has(key)) return void hint("that view is already open");

  const merged = members.length > 1;
  const node = el("div", `pane${merged ? " merged" : ""}`);
  const head = el("div", "pane-head");

  const title = merged
    ? [...new Set(members.map((m) => m.container))].join(" + ")
    : members[0].container;
  /* First in the row, before the name: the mark is what makes a pane read as a pane at a
   * glance. Hidden in yeet mode by CSS — see pokeball().
   *
   * A creature sprite if the sprites directory has anything in it at all, and the drawn
   * pokéball otherwise. Both are built and only one is added, because the ball is the
   * guaranteed fallback: sprites are files someone dropped in and the directory may be
   * empty or missing. Which file this pane gets is up to sprites.js — a fresh roll from the
   * whole folder, so it's whatever it is until this pane is closed and opened again.
   *
   * Rolled HERE, once, rather than in the header render: this runs when the pane is built,
   * so the creature is fixed for the pane's life and a repaint can't reshuffle it.
   *
   * A merged pane gets one too. It used to be excluded — back when the file was chosen from
   * the container's name there was no single name to choose from, so a merge fell back to the
   * ball. The pick is a roll now, so there's nothing to key on and nothing to exclude, and a
   * merged pane reading as a lesser kind of pane was only ever a side effect of that. One
   * creature for the pane, not one per member: the members are already named individually in
   * the chips below the header, and a row of sprites there would compete with them. */
  const ball = pokeball();
  const spriteUrl = spriteForPane();
  if (spriteUrl) {
    const img = el("img", "pane-sprite");
    img.src = spriteUrl;
    img.alt = "";              // decorative: the container's name is right beside it
    // Matches the CSS box; set as attributes too so the header doesn't reflow when the
    // file loads. The ball's own size is in pokeball(), and moves with this.
    img.width = 44; img.height = 44;
    /* A file that 404s or isn't really an image leaves a broken-image glyph in the header,
     * which looks like a bug in the dashboard rather than a missing file. Swap in the ball
     * instead — the same fallback as having no sprite at all. */
    img.addEventListener("error", () => { img.replaceWith(ball); }, { once: true });
    head.append(img);
  } else {
    head.append(ball);
  }
  head.append(el("span", "pane-container", title));

  const pane = {
    key, node, body: null, members: [], count: 0, merged,
    pending: [], flushTimer: null, raf: null, arrival: 0, lastKey: "", emittedKey: "",
    stateEl: null, skewEl: null, cappedEl: null, ballEl: null, loading: false, loadingEl: null, loadingTimer: null, graceTimer: null,
  };

  if (merged) {
    /* One chip per member: what it's called here, its colour in the gutter, and its
     * container state. With several streams in one pane, "which stream said this" has
     * to be legible at a glance or the interleaving is unreadable.
     *
     * `memberLabels` decides what "called here" means — the host name only separates
     * these streams when they're on different hosts, and combining two containers on
     * one box would otherwise label every line identically. */
    const labels = memberLabels(members);
    const legend = el("span", "pane-legend");
    members.forEach((m, i) => {
      const chip = el("span", `pane-chip h${(i % 6) + 1}`);
      chip.append(el("span", "chip-dot"));
      const stateEl = el("span", "chip-state", labels[i]);
      chip.append(stateEl);
      // The tooltip is always the full identity, however short the label got.
      chip.title = `${m.hostLabel} · ${m.container}${m.image ? ` · ${m.image}` : ""}`;
      legend.append(chip);
      pane.members.push({ ...m, label: labels[i], colour: (i % 6) + 1, dockerEl: stateEl, es: null, state: "starting", skew: null, lastKey: null, advancedAt: 0, entries: newEntryState(), entryGroup: null });
    });
    head.append(legend);
  } else {
    const m = members[0];
    head.append(el("span", "pane-host", m.hostLabel));
    const docker = el("span", "pane-docker", m.state ?? "");
    docker.dataset.state = m.state ?? "";
    head.append(docker);
    pane.members.push({ ...m, label: m.hostLabel, colour: 0, dockerEl: docker, es: null, state: "starting", skew: null, lastKey: null, advancedAt: 0, entries: newEntryState(), entryGroup: null });
  }

  pane.ballEl = ball;

  const skew = el("span", "pane-skew");
  skew.hidden = true;
  head.append(skew);
  pane.skewEl = skew;

  // The host trimmed the window it was asked for. Shown per pane rather than as a
  // one-off hint because it stays true for as long as the pane is open, and it's the
  // answer to "why does this pane start where it starts" — which is a question
  // someone asks minutes later, long after a transient toast has gone.
  const capped = el("span", "pane-capped");
  capped.hidden = true;
  head.append(capped);
  pane.cappedEl = capped;

  const state = el("span", "pane-state", "connecting…");
  head.append(state);
  pane.stateEl = state;

  /* Interleaving starts here, from a pane that's already open, rather than from a
   * container in the sidebar. Two reasons it belongs on this side.
   *
   * You almost never decide to interleave before you've looked at something — you
   * open a service, see what it's doing, and *then* want the other boxes running it
   * next to it. And a merged pane is built up, not declared: `+` again adds a third
   * host to the two already here, which the sidebar's version couldn't express at all
   * without re-picking the whole set from scratch. */
  const add = el("button", "add-stream");
  add.append(mergeIcon());
  add.title = "combine another host's logs into this pane";
  add.setAttribute("aria-label", "combine another host's logs into this pane");
  add.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openAddPicker(add, pane);
  });
  head.append(add);

  /* Alerting, next to combining, because they're the same kind of decision made in the same place:
   * both are things you want about the stream you're currently reading. It sits before the close
   * button so `×` stays last in the row — the destructive one at the end, where it always is. */
  const bell = el("button", "alert-btn");
  bell.append(alertIcon());
  bell.title = "alert on a pattern in these logs";
  bell.setAttribute("aria-label", "alert on a pattern in these logs");
  bell.addEventListener("click", (ev) => {
    ev.stopPropagation();
    openAlertPicker(bell, pane);
  });
  head.append(bell);

  const close = el("button", "rm", "×");
  close.title = "close";
  close.addEventListener("click", () => detach(key));
  head.append(close);

  // Width the host column to the labels this pane actually shows, so the message
  // column starts at the same x on every row.
  //
  // Clamped at both ends. A floor, because a column sized exactly to "web-01" looks
  // pinched against its neighbours and leaves no room for a host added later. A
  // ceiling, because one verbosely-named host shouldn't cost every line a fifth of
  // its width — past that the label truncates and the full text lives on hover.
  if (merged) {
    const widest = Math.max(...pane.members.map((m) => m.label.length));
    node.style.setProperty("--who-w", `${Math.min(Math.max(widest, 10), 20)}ch`);
  }

  // The body and the loading skeleton share a positioned box, so the skeleton can
  // sit over the body without either one being in the other's scroll or child list —
  // `appendLine`, the line trim and `repaint` all walk `pane.body.children`, and a
  // placeholder living in there would be counted as a line by all three.
  const view = el("div", "pane-view");
  const body = el("div", "pane-body");
  pane.body = body;
  pane.loadingEl = buildSkeleton(merged);
  pane.loadingTimer = null;
  view.append(body, pane.loadingEl);
  node.append(head, view);
  $("#panes").append(node);
  $("#panes").querySelector(".empty")?.remove();

  panes.set(key, pane);
  /* How many streams, on how many boxes — never which. `hosts` is what says whether
   * combining is being used to read one service across a fleet or two containers on one
   * machine, which is the question worth being able to answer about this feature. */
  track("pane_attached", {
    via,
    merged,
    members: members.length,
    hosts: new Set(members.map((m) => m.hostId)).size,
    panes: panes.size,
  });
  addGrip(pane);   // the seam between this pane and whatever ends up to its right
  openStreams(pane);
  renderHosts();
  syncPaneStates();
  // The scrubber spans the open panes' history, so a new pane can extend it.
  refreshScrubSpan();
}

/* ── resizing panes ──────────────────────────────────────────────────────────
 *
 * Dragging the seam between two panes moves width from one to the other, and touches
 * nothing else in the row.
 *
 * The thing being dragged is a `flex-grow` weight, not a pixel width. Pinning pixels
 * is the obvious implementation and it decays badly here: panes are opened and closed
 * constantly, and a row of pinned widths leaves a gap when one closes and refuses to
 * make room when one opens. Weights are proportions, so the row always fills itself
 * and a new pane simply takes its share.
 *
 * The pair's TOTAL weight is held constant through a drag. That's what keeps the
 * gesture local: the two panes either side of the seam trade with each other, and a
 * third pane two seams away doesn't move because nothing about it changed.
 */
const PANE_MIN_PX = 320;      // matches `.pane { min-width }` — see the note there

/** Give a pane a grip on its right-hand seam. The last pane's is hidden in CSS rather
 *  than skipped here, because which pane is last changes as panes come and go. */
function addGrip(pane) {
  const grip = el("button", "pane-grip");
  grip.type = "button";
  grip.tabIndex = 0;
  grip.title = "drag to resize · double-click to even them out";
  // Named by what it resizes, not by the pane's internal key, which is a host id and
  // a container name glued together with a pipe.
  grip.setAttribute("aria-label",
    `resize the ${[...new Set(pane.members.map((m) => m.container))].join(" + ")} pane`);

  let drag = null;   // {x, a, b, wa, wb, ga, gb}

  const begin = (ev) => {
    const a = pane.node;
    const b = a.nextElementSibling;
    if (!b) return;   // nothing to trade with
    drag = {
      x: ev.clientX,
      a, b,
      wa: a.getBoundingClientRect().width,
      wb: b.getBoundingClientRect().width,
      // Read the computed weight rather than the inline one: until the first drag
      // these come from the stylesheet (1, or 2 for a combined pane).
      ga: Number(getComputedStyle(a).flexGrow) || 1,
      gb: Number(getComputedStyle(b).flexGrow) || 1,
    };
    grip.classList.add("dragging");
    grip.setPointerCapture?.(ev.pointerId);
    ev.preventDefault();       // no text selection while dragging
  };

  const move = (ev) => {
    if (!drag) return;
    const total = drag.wa + drag.wb;
    const totalG = drag.ga + drag.gb;
    // Clamped as a pair: past the limit the seam stops rather than one pane shrinking
    // below its minimum while the other keeps growing.
    const wa = Math.max(PANE_MIN_PX, Math.min(total - PANE_MIN_PX, drag.wa + (ev.clientX - drag.x)));
    if (total <= PANE_MIN_PX * 2) return;   // no room to trade; both are at the floor
    drag.a.style.flexGrow = String(totalG * (wa / total));
    drag.b.style.flexGrow = String(totalG * (1 - wa / total));
  };

  const end = () => {
    drag = null;
    grip.classList.remove("dragging");
  };

  grip.addEventListener("pointerdown", begin);
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);

  /* Keyboard: the same gesture without a pointer. A fixed pixel step rather than a
   * proportional one, so it feels the same on a wide row as on a narrow one. */
  grip.addEventListener("keydown", (ev) => {
    const step = ev.key === "ArrowLeft" ? -24 : ev.key === "ArrowRight" ? 24 : 0;
    if (step === 0) return;
    ev.preventDefault();
    const b = pane.node.nextElementSibling;
    if (!b) return;
    const wa = pane.node.getBoundingClientRect().width;
    const wb = b.getBoundingClientRect().width;
    const total = wa + wb;
    if (total <= PANE_MIN_PX * 2) return;
    const totalG = (Number(getComputedStyle(pane.node).flexGrow) || 1) + (Number(getComputedStyle(b).flexGrow) || 1);
    const next = Math.max(PANE_MIN_PX, Math.min(total - PANE_MIN_PX, wa + step * (ev.shiftKey ? 4 : 1)));
    pane.node.style.flexGrow = String(totalG * (next / total));
    b.style.flexGrow = String(totalG * (1 - next / total));
  });

  // Double-click clears every pane's weight, handing the row back to the stylesheet —
  // equal shares, with a combined pane still getting its double. Resetting only the
  // two either side would leave the row lopsided in a way that's fiddly to undo.
  grip.addEventListener("dblclick", (ev) => {
    ev.preventDefault();
    for (const p of panes.values()) p.node.style.flexGrow = "";
  });

  pane.node.append(grip);
}

// ── the loading state ───────────────────────────────────────────────────────
/* Repopulating a pane is not instant: the old window's lines are dropped the moment
 * the range changes, and the new ones arrive a round trip later — longer for a merged
 * pane, which holds its first burst back to order it. An empty body in that gap reads
 * as "this window has no logs", which is a different and wrong answer.
 *
 * So the gap is filled with placeholder rows in the shape of real lines — the same
 * time / host / message columns — under a sweep that moves left to right. Shape
 * rather than a spinner because it says what is coming and where, and the eye has
 * something to settle on before the text lands. */

/* Fixed widths rather than random ones: a skeleton that reshuffles itself on every
 * range change draws attention to the placeholder instead of to the wait. */
const SKELETON_WIDTHS = [72, 44, 88, 61, 35, 79, 53, 67, 41, 84, 58, 47];

function buildSkeleton(merged) {
  const box = el("div", "pane-loading");
  box.hidden = true;
  const rows = el("div", "skel-rows");
  for (const w of SKELETON_WIDTHS) {
    const row = el("div", "skel-line");
    row.append(el("span", "skel-bar skel-ts"));
    if (merged) row.append(el("span", "skel-bar skel-who"));
    const msg = el("span", "skel-bar skel-msg");
    msg.style.width = `${w}%`;
    row.append(msg);
    rows.append(row);
  }
  box.append(rows);
  // Named, so the wait is legible to a screen reader too — the bars alone say nothing.
  const label = el("div", "skel-label", "loading window…");
  label.setAttribute("role", "status");
  box.append(label);
  return box;
}

/* How long a live stream may report itself open without producing a line before the
 * pane is called empty. Long enough to cover the backfill of a window that does have
 * lines, short enough that a genuinely quiet container isn't left under a skeleton. */
const FIRST_LINE_GRACE_MS = 700;

/** Give an open-but-silent stream a moment to produce its first line. One-shot: the
 *  timer is armed once per load, and `hideLoading` clears it if a line beats it. */
function awaitFirstLine(pane) {
  if (pane.graceTimer) return;
  pane.graceTimer = setTimeout(() => {
    pane.graceTimer = null;
    if (pane.pending.length === 0) hideLoading(pane);
  }, FIRST_LINE_GRACE_MS);
}

function showLoading(pane) {
  clearTimeout(pane.loadingTimer);
  clearTimeout(pane.graceTimer);
  pane.graceTimer = null;
  pane.loading = true;
  pane.loadingEl.hidden = false;
  pane.loadingEl.classList.remove("out");
  pane.loadingEl.querySelector(".skel-label").textContent = range.until ? "loading window…" : "connecting…";
}

/** Fade out rather than cut: the skeleton and the first lines occupy the same rows,
 *  so a hard swap looks like a flicker. Kept in the DOM until the fade finishes, then
 *  hidden so it can't take the pointer or be read out. */
function hideLoading(pane) {
  if (!pane.loading) return;
  pane.loading = false;
  pane.loadingEl.classList.add("out");
  clearTimeout(pane.graceTimer);
  pane.graceTimer = null;
  clearTimeout(pane.loadingTimer);
  pane.loadingTimer = setTimeout(() => {
    pane.loadingEl.hidden = true;
    pane.loadingEl.classList.remove("out");
  }, 200);
}

/** Point a pane's members at the current global range. Called on attach and again
 *  whenever the range changes — old streams are dropped and the body cleared,
 *  because a new window's lines are a different set, not more of the same. */
function openStreams(pane) {
  for (const m of pane.members) m.es?.close();
  clearInterval(pane.flushTimer);
  pane.flushTimer = null;
  cancelAnimationFrame(pane.raf);
  pane.raf = null;
  pane.body.textContent = "";
  pane.count = 0;
  pane.shown = 0;
  pane.pending = [];
  pane.lastKey = "";
  pane.emittedKey = "";
  pane.skewEl.hidden = true;
  pane.cappedEl.hidden = true;
  showLoading(pane);

  pane.stateEl.dataset.state = "starting";
  pane.stateEl.textContent = range.until ? "loading window…" : "connecting…";

  for (const m of pane.members) {
    m.state = "starting";
    m.skew = null;
    m.capped = null;
    m.lastKey = null;
    // The body is cleared with the streams, so grouping starts over — carrying an
    // open traceback across a range change would attach the new window's first line
    // to a stack trace that is no longer on screen.
    m.entries = newEntryState();
    // The lines those entries were on are gone with the body, so the element refs
    // this holds are stale — see `appendLine`.
    m.entryGroup = null;
    m.advancedAt = Date.now();
    const q = new URLSearchParams({ host: m.hostId, container: m.container });
    if (range.since) q.set("since", String(range.since));
    if (range.until) q.set("until", String(range.until));
    // No `find` goes on the wire: the filter runs here, over the lines already
    // loaded. The endpoint still accepts one — see the note by `search`.

    const es = new EventSource(`/api/logs?${q}`);
    m.es = es;
    es.onmessage = (ev) => {
      let evt;
      try { evt = JSON.parse(ev.data); } catch { return; }
      if (evt.t === "log") return void onLine(pane, m, evt);
      if (evt.t !== "status") return;
      m.state = evt.state;
      m.error = evt.error ?? null;
      m.lines = evt.lines;
      m.seen = evt.seen;
      // Sticky: the host says this once, on every status for that stream, and a
      // later status without it (there shouldn't be one) must not clear the fact.
      if (evt.capped) { m.capped = evt.capped; reportCapped(pane); }
      // A member reaching a terminal state stops holding the merge back, and usually
      // releases its tail — don't make that wait for the next tick of the timer.
      if (pane.merged) maybeFlush(pane);
      reportState(pane);
    };
    es.onerror = () => {
      if (m.state === "complete") return; // nothing left to reconnect to
      m.state = "reconnecting";
      reportState(pane);
    };
  }

  // A merged pane emits on a timer so lines can be ordered before they land. A
  // single-member pane appends immediately — there is nothing to interleave, and
  // buffering would only add latency to a live tail.
  if (pane.merged) pane.flushTimer = setInterval(() => maybeFlush(pane), FLUSH_MS);
}

/** Member states that mean no further lines are coming at all. */
const TERMINAL_STATES = new Set(["complete", "ended", "error"]);

/** One status line for the whole pane, worst-first: a pane whose members disagree
 *  should show the member that needs attention, not an average. */
function reportState(pane) {
  const rank = { error: 0, reconnecting: 1, starting: 2, loading: 3, ended: 4, complete: 5, streaming: 6 };
  const worst = [...pane.members].sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9))[0];

  /* The other ways out of the loading state, for a window that yields no lines —
   * without these the skeleton would sweep forever over a pane that is simply empty.
   *
   * Buffered lines don't count as arrived: a merged pane can be holding lines that
   * the watermark hasn't released yet, and dropping the skeleton there would show an
   * empty pane a moment before it fills.
   *
   * The two cases are not the same wait. A member that has ENDED will send nothing
   * more, so an empty body is the final answer and the skeleton goes at once. A
   * member that is STREAMING has only opened its stream — the server reports that
   * the moment the log subscription is live, which is before any backfill has been
   * read — so it says nothing yet about whether lines are coming. That one waits out
   * a grace period, and the first line to land cancels it. */
  if (pane.loading && pane.pending.length === 0) {
    if (pane.members.every((m) => TERMINAL_STATES.has(m.state))) hideLoading(pane);
    else if (pane.members.every((m) => m.state === "streaming" || TERMINAL_STATES.has(m.state))) {
      awaitFirstLine(pane);
    }
    // A stream that has dropped isn't loading, it's stuck. Sweeping over it would
    // claim progress that isn't happening; the status line says what went wrong.
    else if (pane.members.some((m) => m.state === "reconnecting")) hideLoading(pane);
  }

  const st = pane.stateEl;
  st.dataset.state = worst.state;

  if (worst.error) {
    // `label`, not `hostLabel`: in a pane combining two containers on one box, naming
    // the host says nothing about which of them failed.
    st.textContent = pane.merged ? `${worst.label}: ${worst.error}` : `${worst.state}: ${worst.error}`;
    return;
  }
  /* With a filter on, the count IS the status: "3 of 900" says both that the filter
   * is working and what it's working over. The scope is always the same now — the
   * lines loaded into this pane — which is why it no longer has to be spelt out.
   *
   * A terminal state is kept alongside it, or a pane whose container has stopped
   * reads "3 of 900" and looks live. */
  if (!search.query.empty) {
    const done = pane.members.every((m) => m.state === "complete") ? "complete"
      : pane.members.every((m) => m.state === "ended" || m.state === "complete") ? "ended"
      : "";
    st.textContent = `${pane.shown ?? 0} of ${pane.count}${done ? ` · ${done}` : ""}`;
    return;
  }

  if (pane.members.every((m) => m.state === "complete")) {
    const n = pane.members.reduce((a, m) => a + (m.lines ?? 0), 0);
    st.dataset.state = "complete";
    st.textContent = n === 0 ? "no lines in range" : `complete · ${n} line${n === 1 ? "" : "s"}`;
    return;
  }
  st.textContent = pane.merged && worst.state !== "streaming"
    ? `${worst.label}: ${worst.state}`
    : worst.state;
}

// ── ordering ────────────────────────────────────────────────────────────────
// The comparison itself lives in order.js, as pure functions with tests — getting
// timestamp order wrong would present two hosts' logs in a plausible, false
// sequence, which is worse than a visible bug.

function onLine(pane, member, evt) {
  /* Escapes are resolved once, here, before anything looks at the message.
   *
   * Everything downstream reasons about the text a human would SEE: grouping keys off
   * leading whitespace, which `\x1b[2m  File "x"` would hide; the filter would match
   * `31m` in a line that never said it; and the entry text is joined from what's on
   * screen. Parsing at the edge means none of them has to know escapes exist. */
  const painted = parseAnsi(evt.message);
  evt.message = painted.text;
  evt.runs = painted.runs;

  /* Which ENTRY this line belongs to, decided here — on arrival, per member, before
   * the merge reorders anything. A combined pane interleaves hosts, so "the line
   * above" on screen is not the line above in this container's output, and grouping
   * from the rendered order would staple one host's traceback to another's. Each
   * member's own lines do arrive in order, which is what makes it decidable.
   *
   * The id carries the member key so two containers can't collide on a sequence
   * number they both counted to. */
  evt.entry = `${memberKey(member.hostId, member.container)}#${entryOf(member.entries, evt.message)}`;

  if (!pane.merged) return void queueLine(pane, member, evt);

  const key = tsKey(evt.ts) ?? pane.lastKey;   // unstamped: keep it where it arrived
  if (key > pane.lastKey) pane.lastKey = key;
  /* What this member has caught up to, which is what the watermark is computed from,
   * and when it last got there.
   *
   * Monotonic by max rather than by assignment: one stamp out of order from a single
   * container would otherwise walk the watermark backwards and release lines twice.
   *
   * The clock is stamped on ADVANCING, not on receiving. A member that delivers lines
   * docker never stamped advances nothing, and if merely receiving counted it would
   * look alive to the quiet bound below while holding the merge open forever — the
   * pane would sit empty with lines pouring into it. Judged on advancing, it stalls
   * like a silent member and the merge carries on without it. */
  if (key > (member.lastKey ?? "")) {
    member.lastKey = key;
    member.advancedAt = Date.now();
  }
  noteSkew(pane, member, evt.ts);
  // `arrival` is the tiebreak, so lines sharing a timestamp keep the order they
  // reached us in rather than being shuffled by an unstable comparison.
  pane.pending.push({ key, arrival: pane.arrival++, member, evt });
}

/* ── writing lines out in batches ────────────────────────────────────────────
 *
 * Both kinds of pane hand their lines to the DOM a batch at a time, and the reason is
 * the same in both: the two measurements around an append are the expensive part, not
 * the append.
 *
 * `nearBottom` reads scrollTop, clientHeight and scrollHeight, and the autoscroll after
 * it reads scrollHeight again. Those reads have to be answered against fresh geometry,
 * so each one flushes the layout the append just invalidated — over a body holding up
 * to MAX_LINES rows. Done once per line, a container writing a few hundred lines a
 * second buys a few hundred forced reflows a second, per pane, and the tab stops being
 * able to keep up long before the buffer is even full.
 *
 * Batched, the whole cost is two reads per pane per frame however many lines landed in
 * it. A merged pane already had this, as a side effect of holding lines back to order
 * them (`maybeFlush`, below). A plain pane got a line and wrote it straight out, and
 * that is what made a chatty single container feel worse than six interleaved ones.
 *
 * The wait a plain pane now takes is one animation frame — the frame the write would
 * have been painted on anyway, and a fraction of the 100ms a merged pane holds a line
 * to order it. Nothing else about the pane changes: the lines are appended in the order
 * they arrived, from the same queue the loading state already watches. */
function queueLine(pane, member, evt) {
  pane.pending.push({ member, evt });
  /* rAF doesn't fire in a hidden tab, so a backgrounded dashboard on a busy container
   * would queue without bound. Nothing older than the buffer can survive the trim
   * anyway — dropping it here rather than appending it and immediately trimming it is
   * the same set of lines on screen for a fixed amount of work. */
  if (pane.pending.length > MAX_LINES) pane.pending.splice(0, pane.pending.length - MAX_LINES);
  if (pane.raf) return;
  pane.raf = requestAnimationFrame(() => {
    pane.raf = null;
    flushQueue(pane);
  });
}

/** Write out everything a plain pane has queued, measuring once around the batch. */
function flushQueue(pane) {
  if (pane.pending.length === 0) return;
  const batch = pane.pending;
  pane.pending = [];
  const atBottom = nearBottom(pane.body);
  for (const item of batch) appendLine(pane, item.member, item.evt, { batched: true });
  if (atBottom) pane.body.scrollTop = pane.body.scrollHeight;
}

/** Release whatever the watermark has settled — see the note in order.js. Runs on a
 *  short timer, and again the moment a member's state changes, since a member going
 *  `complete` stops it holding the merge back and usually releases its tail at once. */
function maybeFlush(pane) {
  if (pane.pending.length === 0) return;

  const now = Date.now();
  const quietMs = range.until ? QUIET_CLOSED_MS : QUIET_LIVE_MS;
  const wm = mergeWatermark(pane.members.map((m) => ({
    done: TERMINAL_STATES.has(m.state),
    // Silence is measured from the stream opening, not from its first line, so a
    // member that never says anything can't hold the pane empty indefinitely.
    stalled: now - m.advancedAt > quietMs,
    lastKey: m.lastKey,
  })));

  const { ready, held } = splitAtWatermark(pane.pending, wm);
  pane.pending = held;
  if (ready.length === 0) return;

  const atBottom = nearBottom(pane.body);
  for (const item of ready) appendLine(pane, item.member, item.evt, { batched: true, key: item.key });
  if (atBottom) pane.body.scrollTop = pane.body.scrollHeight;
}

/* Clock skew, the one thing timestamp ordering can't survive.
 *
 * Interleaving trusts two machines' clocks to agree. When they don't, the lines
 * are ordered confidently and wrongly, which is worse than obviously broken — so
 * estimate each member's offset (how far its newest stamp sits from our clock when
 * it reaches us) and say so when members disagree. Only meaningful for live lines;
 * historical ones are legitimately old, so this is skipped for a closed window. */
function noteSkew(pane, member, ts) {
  if (!ts || range.until) return;
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return;
  const offset = Date.now() - t;
  // Track the smallest offset seen: the least-delayed line is the best estimate of
  // the clock difference, since network and buffering only ever add delay.
  member.skew = member.skew === null ? offset : Math.min(member.skew, offset);

  const spread = clockSpread(pane.members.map((m) => m.skew));
  if (spread === null) return;
  const el_ = pane.skewEl;
  if (spread > SKEW_WARN_MS) {
    el_.hidden = false;
    el_.textContent = `⚠ clocks differ ~${(spread / 1000).toFixed(1)}s`;
    el_.title = "These hosts' clocks disagree by roughly this much, so timestamp"
      + " ordering between them is off by the same amount. Interleaving is only as"
      + " good as the clocks — check NTP on these boxes.";
  } else {
    el_.hidden = true;
  }
}

/* A host refused to replay as much history as the window asked for.
 *
 * The browser applies the same cap before asking (see `setRange`), so in normal use
 * this never fires. It fires when the two disagree — a host configured with a
 * tighter MAX_WINDOW than the hub, or a range that drifted past the cap while the
 * pane sat open and following. Both are cases where the pane holds less than the
 * range control claims, and the pane is where that has to be said. */
function reportCapped(pane) {
  const capped = pane.members.map((m) => m.capped).filter(Boolean);
  const el_ = pane.cappedEl;
  if (capped.length === 0) return void (el_.hidden = true);

  // The earliest start any member was actually given is where this pane really
  // begins — the others start later still, but this is the honest headline.
  const tightest = capped.reduce((a, b) => (a.since <= b.since ? a : b));
  const which = capped.length < pane.members.length
    ? pane.members.filter((m) => m.capped).map((m) => m.label).join(", ")
    : "";
  el_.hidden = false;
  el_.textContent = `⚠ trimmed to ${describeCap(tightest.maxSec)}`;
  // The requested start is quoted as an age, not a clock time: it can be weeks back,
  // where "01:58:20" says nothing about which day and reads like a near miss.
  el_.title = `This window asked for ${describeSpan(nowSec() - tightest.requested)} of history,`
    + ` and a host will replay at most ${describeCap(tightest.maxSec)} in one request — so this pane`
    + ` starts at ${hhmmss(tightest.since)} ${ZONE}. Narrow the window to read further back.`
    + (which ? ` (${which})` : "");
}

/** Re-decide one entry after a line joined it. The line that makes a traceback match
 *  is usually its last — the `TimeoutError:` terminator — so an entry that was hidden
 *  while it was only a header has to be able to change its mind.
 *
 *  Over the entry's own lines, which the member has to hand, rather than over the ones
 *  a `[data-entry=…]` search of the body turns up: the entry is a handful of rows and
 *  the body is thousands, and this runs for every line of every open traceback. */
function rejudgeEntry(pane, group) {
  const lines = group.lines.filter((l) => l.isConnected);
  if (lines.length === 0) return;
  group.lines = lines;               // trimmed rows can go now that we've walked them
  const text = lines.map((l) => lineData.get(l)?.text ?? "").join("\n");
  const hit = matches(text, search.query);
  for (const line of lines) {
    const was = line.classList.contains("filtered");
    if (was === !hit) continue;
    line.classList.toggle("filtered", !hit);
    pane.shown = Math.max(0, (pane.shown ?? 0) + (hit ? 1 : -1));
  }
}

const nearBottom = (node) => node.scrollTop + node.clientHeight >= node.scrollHeight - 24;

/** A log line's text, with search hits wrapped in <mark>.
 *
 *  Built from text nodes and elements rather than innerHTML: a log line is
 *  arbitrary bytes from whatever a container decided to print, so assembling
 *  markup out of it is how a log viewer becomes an XSS hole. `matchRanges`
 *  guarantees the spans are ordered and non-overlapping, which is what lets this
 *  slice straight through in one pass. */
function renderMessage(text, runs = []) {
  const span = el("span", "msg");
  const str = String(text ?? "");
  const ranges = search.query.empty ? [] : matchRanges(str, search.query);
  if (ranges.length === 0 && runs.length === 0) {
    span.textContent = str;               // the overwhelmingly common line
    return span;
  }

  /* Two independent sets of ranges over the same string: the container's own colours
   * and the reader's search hits. They overlap freely — half a coloured word can be a
   * match — so neither can slice the text on its own without producing crossing tags.
   *
   * Instead, cut at every boundary either one cares about and emit one piece per gap.
   * A piece is then wholly inside or wholly outside each, and both can be applied to
   * it without either having to know about the other. */
  const cuts = new Set([0, str.length]);
  for (const r of runs) { cuts.add(r.start); cuts.add(r.end); }
  for (const r of ranges) { cuts.add(r.start); cuts.add(r.end); }
  const edges = [...cuts].filter((n) => n >= 0 && n <= str.length).sort((a, b) => a - b);

  for (let i = 0; i < edges.length - 1; i++) {
    const [from, to] = [edges[i], edges[i + 1]];
    if (from === to) continue;
    const piece = str.slice(from, to);
    const hit = ranges.some((r) => from >= r.start && to <= r.end);
    const run = runs.find((r) => from >= r.start && to <= r.end);

    // A search hit outranks the line's own colour: it's the thing the reader asked to
    // see, and the accent fill has to stay recognisable whatever the log painted.
    let node = hit ? el("mark", "", piece) : document.createTextNode(piece);
    if (run) {
      const wrap = el("span", run.cls.join(" "));
      Object.assign(wrap.style, run.style);
      wrap.append(node);
      node = wrap;
    }
    span.append(node);
  }
  return span;
}

/* Where a line goes in the body.
 *
 * Normally the end: the watermark releases lines in order, so each one is newer than
 * the last. The exception is a line from a member the merge stopped waiting on — it
 * can be older than lines already on screen, and appending it would put it visibly
 * out of sequence, which is the one thing an interleaved pane must not do.
 *
 * So a late line is walked backwards to its place instead. The scan is capped: a
 * host that reconnects after a long silence can dump thousands of old lines, and
 * inserting each one an unbounded distance back is quadratic. Past the cap it goes
 * at the end, which is the old behaviour and honest enough — by then the gap is
 * large enough to be obvious rather than misleading. */
const LATE_SCAN_MAX = 400;

function placeLine(pane, line, key) {
  if (key) line.dataset.key = key;
  if (!key || key >= pane.emittedKey) {
    if (key) pane.emittedKey = key;
    pane.body.append(line);
    return;
  }
  let at = pane.body.lastElementChild;
  for (let scanned = 0; at && scanned < LATE_SCAN_MAX; scanned++) {
    const k = at.dataset.key;
    if (!k || k <= key) return void at.after(line);   // found its neighbour
    at = at.previousElementSibling;
  }
  // Either the body ran out (it belongs at the very top) or the scan hit its cap.
  if (at) pane.body.append(line);
  else pane.body.prepend(line);
}

function appendLine(pane, member, evt, { batched = false, key = null } = {}) {
  // The first line of a window is the moment the skeleton has served its purpose.
  if (pane.loading) hideLoading(pane);
  // Only autoscroll if the reader is already at the bottom — scrolling up to
  // read something shouldn't get yanked away by the next line. In a batch the
  // caller does this once, around the whole batch.
  const atBottom = batched ? false : nearBottom(pane.body);

  const line = el("div", `line${evt.stream === "stderr" ? " err" : ""}`);
  if (member.colour) line.classList.add(`h${member.colour}`);
  // Kept on the element because the filter re-runs over the DOM, not over a model —
  // this is what lets `repaint` reassemble entries it never saw arrive.
  if (evt.entry) line.dataset.entry = evt.entry;

  // The time column is always emitted, even for a line docker didn't stamp — an
  // absent cell would shift that row's message left and break the alignment that
  // makes a log scannable. Shown in the viewer's zone to match the times they type
  // into the range picker; the original UTC stamp, at full nanosecond precision,
  // stays on hover since that's the value to quote at another tool.
  const ts = el("span", "ts", localTime(evt.ts));
  if (evt.ts) ts.title = evt.ts;
  line.append(ts);

  if (pane.merged) {
    const who = el("span", "who", member.label);
    who.title = `${member.hostLabel} · ${member.container}`;  // in full, when truncated
    line.append(who);
  }
  line.append(renderMessage(evt.message, evt.runs));
  // Kept off the element rather than read back out of it — see `lineData`.
  lineData.set(line, { text: evt.message, runs: evt.runs });
  /* A non-matching line is hidden, not dropped: clearing the filter has to bring the
   * context straight back, and it can't if the line was never added. Trimming still
   * counts it, so the buffer means the same thing whatever the filter is.
   *
   * A line arriving into an entry that is ALREADY on screen inherits that entry's
   * verdict rather than being judged alone — otherwise the frames of a traceback
   * would blink in one at a time and disagree with the header above them. The entry
   * is then re-judged as a whole below, because this line may be the one that makes
   * it match.
   *
   * Which entry that is, and whether any of its lines are still on screen, comes off
   * the MEMBER rather than out of a search of the body. A member's own lines arrive in
   * its own order, so a continuation always reaches this the append after the line it
   * continues — the group holds those elements, and `isConnected` is what says whether
   * the buffer trim has since taken them. This used to be
   * `body.querySelector('[data-entry=…]')`, which walked up to MAX_LINES rows for every
   * line that arrived, filter or no filter: quadratic over a buffer fill, and paid in
   * full by the panes that never group anything. */
  let group = null;
  if (evt.entry) {
    group = member.entryGroup;
    if (group?.id !== evt.entry) group = member.entryGroup = { id: evt.entry, lines: [] };
  }
  const sibling = group?.lines.find((l) => l.isConnected) ?? null;
  const hit = search.query.empty
    || (sibling ? !sibling.classList.contains("filtered") : matches(evt.message, search.query));
  if (hidingLocally() && !hit) line.classList.add("filtered");
  else pane.shown = (pane.shown ?? 0) + 1;
  placeLine(pane, line, key);
  if (group) {
    group.lines.push(line);
    /* An entry has no upper bound on its length — a container printing an indented line
     * forever is one entry — so this can't be allowed to outgrow the buffer it
     * describes. `rejudgeEntry` compacts it whenever a filter is on; this is the case
     * where nothing ever calls it. */
    if (group.lines.length > MAX_LINES) group.lines = group.lines.filter((l) => l.isConnected);
  }
  // Cheap when nothing is filtered, and only over an entry that is actually growing.
  if (hidingLocally() && sibling) rejudgeEntry(pane, group);

  if (++pane.count > MAX_LINES) {
    const dropped = pane.body.firstChild;
    if (dropped && !dropped.classList?.contains("filtered")) pane.shown = Math.max(0, (pane.shown ?? 0) - 1);
    dropped?.remove();
    pane.count--;
  }
  if (atBottom) pane.body.scrollTop = pane.body.scrollHeight;
}

function detach(key, { via = "user" } = {}) {
  const pane = panes.get(key);
  if (!pane) return;
  for (const m of pane.members) m.es?.close();
  clearInterval(pane.flushTimer);
  cancelAnimationFrame(pane.raf);
  clearTimeout(pane.loadingTimer);
  clearTimeout(pane.graceTimer);
  pane.node.remove();
  panes.delete(key);
  track("pane_detached", { via, merged: pane.merged, members: pane.members.length, panes: panes.size });
  if (panes.size === 0) {
    $("#panes").append(el("p", "empty", "Pick a container to attach its logs."));
  }
  renderHosts();
  sizeScrub();   // one fewer stream may narrow the span, or remove it entirely
}

// ── the global time range ───────────────────────────────────────────────────
const nowSec = () => Math.floor(Date.now() / 1000);
const hhmmss = (sec) => new Date(sec * 1000).toTimeString().slice(0, 8);
/* Every time in this UI — line stamps, range notes, the custom picker's inputs —
 * is the viewer's local zone. Naming it once removes the guesswork; the underlying
 * UTC stamp is on each line's tooltip for anyone who needs it. */
const ZONE = zoneLabel();

/** Adopt a range and move every open pane to it.
 *
 *  Every control that sets a window comes through here, which is why the cap is
 *  applied here too rather than in each of them: a preset, the custom form and the
 *  scrubber can't disagree about it, and a control added later inherits it. The
 *  server enforces the same cap regardless (shared/limits.js) — doing it here as
 *  well is so the note tells the truth about what's on screen, instead of the range
 *  claiming two months while the pane holds a day. */
function setRange(next, noteText, { syncSlider = true, via = "preset" } = {}) {
  const win = clampWindow({ since: null, until: null, ...next }, maxWindowSec, nowSec());
  range = { since: win.since, until: win.until };
  /* Which control moved the window, what shape the window is, and how wide — not when
   * it starts. A span is a number; a `since` is a timestamp, and a timestamp says when
   * someone's incident was. */
  track("range_changed", {
    via,
    closed: Boolean(win.until),
    live: !win.since && !win.until,
    span_sec: win.since ? Math.round((win.until ?? nowSec()) - win.since) : null,
    capped: Boolean(win.capped),
    panes: panes.size,
  });
  if (win.capped) {
    // The caller's note described the window it asked for, which is no longer the
    // window on screen — so it's replaced rather than annotated. A note reading
    // "since 09:00" over a pane starting at 14:00 is worse than no note.
    const start = `${hhmmss(win.since)} ${ZONE}`;
    noteText = win.until
      ? `${start} → ${hhmmss(win.until)} (closed window, trimmed to ${describeCap(maxWindowSec)})`
      : `since ${start}, still following (trimmed to ${describeCap(maxWindowSec)})`;
    hint(`${describeSpan(nowSec() - win.requested)} is more history than one request may ask for — showing the most recent ${describeCap(maxWindowSec)}`);
  }
  $("#range-note").textContent = noteText;
  // Mirror the range onto the handles — unless the handles are where it came from.
  // Re-deriving positions from the timestamps they just produced is a round trip
  // that can only lose precision, and it fights the drag that is still finishing.
  if (syncSlider) syncScrubFromRange();
  for (const pane of panes.values()) openStreams(pane);
}

/** Follow live: no window at all, just the tail and whatever arrives next. Its own
 *  entry point rather than a position on the slider, because it isn't a window — it's
 *  the absence of one, and the slider can only draw where it would put you if you
 *  asked for one. Reached from the `live` preset and from double-clicking the track. */
function goLive() {
  selectPreset($('.range button[data-range="live"]'));
  $("#custom-range").hidden = true;
  setRange({}, "following, newest lines as they arrive", { via: "live" });
}

/** Light up one preset, or none — `null` when the window came from the scrubber and
 *  no preset describes it, so nothing claims a range it didn't set. */
function selectPreset(btn) {
  for (const b of document.querySelectorAll(".range button")) b.classList.toggle("on", b === btn);
}

function applyPreset(btn) {
  const val = btn.dataset.range;

  if (val === "custom") {
    // Prefill with the last 15 minutes so the fields are a starting point rather
    // than two empty boxes demanding a timestamp format.
    const form = $("#custom-range");
    form.hidden = !form.hidden;
    if (!form.hidden && !$("#range-from").value) {
      $("#range-from").value = localInputValue(nowSec() - 900);
    }
    return;
  }

  $("#custom-range").hidden = true;
  selectPreset(btn);

  if (val === "live") return goLive();

  const since = nowSec() - Number(val);
  setRange({ since }, `since ${hhmmss(since)} ${ZONE}, still following`, { via: "preset" });
}

/** A datetime-local input's value for a unix second, in the viewer's own zone —
 *  which is the zone they read log timestamps in, so it's the one to show. */
function localInputValue(sec) {
  const d = new Date(sec * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function applyCustom(ev) {
  ev.preventDefault();
  const fromVal = $("#range-from").value;
  const toVal = $("#range-to").value;
  if (!fromVal) return hint("a custom range needs a start", "bad");

  // datetime-local carries no zone, so this parses as the viewer's local time —
  // which is what they typed and what they see in the pane.
  const since = Math.floor(new Date(fromVal).getTime() / 1000);
  const until = toVal ? Math.floor(new Date(toVal).getTime() / 1000) : null;
  if (!Number.isFinite(since)) return hint("that start time didn't parse", "bad");
  if (until !== null && until <= since) return hint("the end must be after the start", "bad");

  selectPreset($('.range button[data-range="custom"]'));
  $("#custom-range").hidden = true;
  setRange(
    { since, until },
    until
      ? `${hhmmss(since)} → ${hhmmss(until)} ${ZONE} (closed window)`
      : `since ${hhmmss(since)} ${ZONE}, still following`,
    { via: "custom" },
  );
}

// ── the scrubber ────────────────────────────────────────────────────────────
/* A two-handled slider whose span is the history the open panes can actually serve.
 *
 * The left edge is the oldest log line any attached stream can reach — measured, not
 * assumed. Container creation time is the tempting stand-in and it's wrong the moment
 * a log has rotated, which would leave a stretch of slider that silently returns
 * nothing. So each stream is probed once (`/api/oldest`, which reads one line) and
 * the earliest answer becomes position 0.
 *
 * Positions are 0–1000 rather than timestamps, so the two native range inputs stay
 * integer-stepped and the mapping to time lives in one place. The right handle at
 * 1000 is special: it means "no end", i.e. keep following, which is why the label
 * reads `live` there rather than a clock time.
 */
const SCRUB_MAX = 1000;
const oldestByStream = new Map();   // "hostId|container" → unix seconds, or null
let scrubSpan = null;               // {from, to} unix seconds, or null when unknown
/* The cap is on how WIDE a window may be, not on how far back it may sit — so the
 * track still reaches the oldest line there is, and you can put a one-hour window on
 * six weeks ago. What's bounded is the distance between the handles. This is the
 * limit in slider positions, or 0 when the whole span fits inside the cap and there
 * is nothing to enforce. */
let scrubMaxWidth = 0;

/* True while a handle is under the pointer.
 *
 * Nothing may write to the handles while this is set. Three things otherwise would,
 * and all three were yanking the slider back mid-drag:
 *   - the 5s container-list poll, which re-anchors the span's right edge to "now"
 *   - a probe (`/api/oldest`) resolving late, up to 8s after a pane was attached
 *   - `setRange`, which normally mirrors the range onto the handles
 * A drag is the one case where the handles are the source of truth and everything
 * else has to follow them, not the other way round. */
let scrubBusy = false;
/** Which handle the pointer has hold of — "a" or "b" — so the bubble tracks it. */
let scrubActive = null;

/** Ask each open pane's streams how far back they go, then size the slider. Cached
 *  per stream: the answer only changes when a log rotates, and re-probing on every
 *  pane open would spawn an isolate per attach. */
async function refreshScrubSpan() {
  const wanted = [];
  for (const pane of panes.values()) {
    for (const m of pane.members) {
      const key = memberKey(m.hostId, m.container);
      if (!oldestByStream.has(key)) wanted.push({ key, m });
    }
  }
  await Promise.all(wanted.map(async ({ key, m }) => {
    try {
      const res = await fetch(`/api/oldest?host=${encodeURIComponent(m.hostId)}&container=${encodeURIComponent(m.container)}`);
      const body = await res.json();
      oldestByStream.set(key, body?.oldest ?? null);
    } catch {
      oldestByStream.set(key, null);
    }
  }));
  sizeScrub();
}

function sizeScrub() {
  // Re-scaling mid-drag would change what the position under the pointer means, so
  // the span itself is left alone until the drag finishes. Whatever prompted this —
  // a new pane, a late probe, the poll — is picked up on the next call.
  if (scrubBusy) return;
  const box = $("#scrub");
  const olds = [];
  for (const pane of panes.values()) {
    for (const m of pane.members) {
      const v = oldestByStream.get(memberKey(m.hostId, m.container));
      if (typeof v === "number") olds.push(v);
    }
  }
  if (olds.length === 0) {
    // Nothing attached, or nothing with history: a slider with no span would be a
    // control that silently does nothing, so it stays hidden.
    scrubSpan = null;
    box.hidden = true;
    $("#scrub-readout").hidden = true;
    return;
  }
  /* The right edge only advances to "now" while the whole span is selected.
   *
   * Re-scaling changes what every position means, so moving it under a chosen window
   * slides that window sideways — which is what made the handles jump whenever a
   * pane was attached or a late probe landed. Held still, a selected window keeps a
   * stable scale for as long as it's being read. */
  const following = range.since === null && range.until === null;
  const to = scrubSpan && !following ? scrubSpan.to : nowSec();
  scrubSpan = { from: Math.min(...olds), to };
  /* How far apart the handles may get, on this scale. The cap bounds a window's
   * width, so the track keeps its full reach — every moment of history is still
   * somewhere on it — and it's the size of the selection that's held down.
   *
   * Recomputed here because it depends on the scale: the same day is 16 positions
   * on a two-month span and the whole track on a one-day one. Zero means the span
   * fits inside the cap and no selection on it can breach the limit. */
  const width = Math.max(1, scrubSpan.to - scrubSpan.from);
  scrubMaxWidth = maxWindowSec > 0 && width > maxWindowSec
    ? Math.max(1, Math.floor((maxWindowSec / width) * SCRUB_MAX))
    : 0;
  box.hidden = false;
  paintTicks();
  syncScrubFromRange();
}

/* Position ↔ time. The arithmetic lives in order.js with tests — the edge cases
 * (a zero-width span, a handle outside the span, an unknown span) are exactly the
 * ones that would silently produce NaN and a slider that does nothing. */
const scrubToTime = (pos) => posToTime(pos, scrubSpan, SCRUB_MAX);
const timeToScrub = (sec) => timeToPos(sec, scrubSpan, SCRUB_MAX);

/* Where the handles sit when nothing is selected — following live.
 *
 * Not the whole track. On a span longer than the cap that would draw a band nobody
 * can have: grab it and it snaps to a day, which reads as the control fighting you.
 * It also over-claims, since following live means the tail plus whatever arrives, not
 * two months of history. A band of exactly the maximum width, parked at the live end,
 * says the true thing — this is the window you'd get if you took hold of it — and is
 * a legal selection the moment you touch it.
 *
 * On a span the cap doesn't bite into, that's the whole track, exactly as before. */
const liveHandles = () => [scrubMaxWidth ? SCRUB_MAX - scrubMaxWidth : 0, SCRUB_MAX];

/** Reflect the current range onto the handles — so picking `15m` or a custom window
 *  moves the slider too, instead of leaving it contradicting the range it shares. */
function syncScrubFromRange() {
  if (!scrubSpan) return;
  if (scrubBusy) return;   // a drag in progress owns the handles; don't fight it
  const [liveLo] = liveHandles();
  const a = range.since ? timeToScrub(range.since) : liveLo;
  const b = range.until ? timeToScrub(range.until) : SCRUB_MAX;
  $("#scrub-a").value = String(a);
  $("#scrub-b").value = String(b);
  paintScrub();
}

/** A duration in words, coarse on purpose: at a glance "2h 15m" answers "how much am
 *  I looking at" and the seconds never help. */
function describeSpan(secs) {
  const s = Math.max(0, Math.round(secs));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

/** How long ago, for a time that means more as a distance than as a clock reading. */
const agoText = (sec) => (nowSec() - sec < 2 ? "now" : `${describeSpan(nowSec() - sec)} ago`);

/** A clock time, with the date prefixed when the span is wide enough that a bare
 *  `21:50:30` would be ambiguous about which day it belongs to. */
function scrubClock(sec) {
  const wide = scrubSpan && scrubSpan.to - scrubSpan.from > 12 * 3600;
  const d = new Date(sec * 1000);
  const pad = (n) => String(n).padStart(2, "0");
  const day = wide ? `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` : "";
  return `${day}${hhmmss(sec)}`;
}

/** The filled band, the edge labels, the readout, and the bubble on the live handle.
 *
 *  The bubble is the point of all this: while dragging, the number that matters is
 *  the one under the pointer, and reading it off a label at the end of the track
 *  means looking away from what you're doing. */
function paintScrub() {
  const a = Number($("#scrub-a").value);
  const b = Number($("#scrub-b").value);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);

  const fill = $("#scrub-fill");
  fill.style.left = `${(lo / SCRUB_MAX) * 100}%`;
  fill.style.width = `${((hi - lo) / SCRUB_MAX) * 100}%`;

  const from = scrubToTime(lo);
  const to = scrubToTime(hi);
  const atOldest = lo === 0;
  const atLive = hi >= SCRUB_MAX;

  $("#scrub-from").textContent = atOldest ? "oldest" : scrubClock(from);
  $("#scrub-to").textContent = atLive ? "live" : scrubClock(to);

  // The readout spells out the window three ways, because each answers a different
  // question: where it starts and ends, how far back that is, and how wide it is.
  const readout = $("#scrub-readout");
  if (scrubSpan && range.since === null && range.until === null && !scrubBusy) {
    // Following live: the band shows the window you'd get by grabbing it, so the
    // readout must not describe it as one you already have. What's loaded is the
    // tail, and no amount of band says that.
    readout.hidden = false;
    readout.textContent = scrubMaxWidth
      ? `following live   ·   drag for a window, up to ${describeCap(maxWindowSec)} at a time`
      : "following live   ·   drag to open a window";
  } else if (scrubSpan) {
    /* Three facts, not six: where it starts, where it ends, how wide it is. The
     * edges used to carry a clock time AND how long ago that was AND the zone, which
     * is the same instant said three ways — and the edge labels either side of the
     * track already show the clock times. The limit is mentioned only while dragging,
     * when it's the thing about to stop you. */
    readout.hidden = false;
    const left = atOldest ? "oldest" : `${scrubClock(from)} · ${agoText(from)}`;
    const right = atLive ? "live" : scrubClock(to);
    const limit = scrubBusy && scrubMaxWidth ? `   max ${describeCap(maxWindowSec)}` : "";
    readout.textContent = `${left}  →  ${right}    ${describeSpan(to - from)}${limit}`;
  } else {
    readout.hidden = true;
  }

  // Bubble on whichever handle is being moved — or, when the whole window is being
  // slid, on the middle of the band, reading both of its edges at once. Sliding
  // changes both ends together, so one end's time doesn't describe the gesture.
  const bubble = $("#scrub-bubble");
  if (scrubBusy && scrubActive === "band") {
    bubble.hidden = false;
    bubble.textContent = `${atOldest ? "oldest" : scrubClock(from)} → ${atLive ? "live" : scrubClock(to)}`;
    bubble.style.left = `${((lo + hi) / 2 / SCRUB_MAX) * 100}%`;
  } else if (scrubBusy && scrubActive) {
    const pos = scrubActive === "a" ? a : b;
    const atEnd = scrubActive === "a" ? pos === 0 : pos >= SCRUB_MAX;
    bubble.hidden = false;
    bubble.textContent = atEnd
      ? (scrubActive === "a" ? "oldest" : "live")
      : `${scrubClock(scrubToTime(pos))}  (${agoText(scrubToTime(pos))})`;
    bubble.style.left = `${(pos / SCRUB_MAX) * 100}%`;
  } else {
    bubble.hidden = true;
  }
}

/* Sliding the whole window.
 *
 * Dragging the band moves both handles by the same amount, so the window keeps its
 * width and only changes where it sits — "the same ten minutes, but earlier", which
 * with two independent handles takes two drags and a subtraction to get right.
 *
 * The shift is clamped as a pair rather than per handle: clamping each one on its own
 * would let the leading edge stop at the end of the span while the trailing edge kept
 * moving, silently narrowing the window the user is trying to slide. */
function shiftWindow(lo, hi, delta) {
  const d = Math.max(-lo, Math.min(SCRUB_MAX - hi, Math.round(delta)));
  return [lo + d, hi + d];
}

/**
 * Hold the selection down to the cap while a handle is being dragged, by PUSHING the
 * other handle rather than stopping the one under the pointer.
 *
 * Stopping it dead is the obvious implementation and it makes the control useless for
 * the thing the cap doesn't forbid: putting a bounded window somewhere far back. You'd
 * drag left, hit a wall a day out, and have no way to reach last Tuesday without first
 * dragging the *other* handle there — two gestures and a subtraction to express "the
 * same width, but earlier". Pushing keeps the gesture direct: drag into the limit and
 * the window travels with you at its maximum width.
 *
 * @param {"a"|"b"} which  the handle under the pointer; the other is the one that moves
 */
function limitWidth(which) {
  const moved = $(which === "a" ? "#scrub-a" : "#scrub-b");
  const other = $(which === "a" ? "#scrub-b" : "#scrub-a");
  // The arithmetic is in order.js with the rest of the slider's, and with tests.
  other.value = String(pushWithin(Number(moved.value), Number(other.value), scrubMaxWidth, SCRUB_MAX));
}

/**
 * Stop the handle under the pointer at the other one, so start stays left of end.
 *
 * Runs BEFORE `limitWidth` on every input: the width limit moves the handle that isn't being
 * dragged, and it's entitled to assume the dragged one is already somewhere legal. Reversing
 * the two would let a push be computed from a crossed position and land the pushed handle on
 * the wrong side.
 *
 * @param {"a"|"b"} which  the handle under the pointer
 */
function keepOrder(which) {
  const moved = $(which === "a" ? "#scrub-a" : "#scrub-b");
  const other = $(which === "a" ? "#scrub-b" : "#scrub-a");
  moved.value = String(blockCross(Number(moved.value), Number(other.value), which, 1, SCRUB_MAX));
}

/** Write a slid window onto the handles and repaint. Normalises a/b to start/end,
 *  which is harmless: the pair means the same window whichever input holds which. */
function moveBandTo(lo, hi) {
  $("#scrub-a").value = String(lo);
  $("#scrub-b").value = String(hi);
  paintScrub();
}

const bandEdges = () => {
  const a = Number($("#scrub-a").value);
  const b = Number($("#scrub-b").value);
  return [Math.min(a, b), Math.max(a, b)];
};

/** Evenly spaced clock labels under the track, so the scale is readable at rest. */
function paintTicks() {
  const box = $("#scrub-ticks");
  box.textContent = "";
  if (!scrubSpan) return;
  for (let i = 0; i <= 4; i++) {
    const pos = (SCRUB_MAX / 4) * i;
    const tick = el("span", "scrub-tick", i === 4 ? "now" : scrubClock(scrubToTime(pos)));
    tick.style.left = `${(pos / SCRUB_MAX) * 100}%`;
    box.append(tick);
  }
}

/** Commit the handles as the global range. Called on release, not while dragging:
 *  every change re-opens each pane's stream, and doing that per pixel would spawn
 *  and kill isolates as fast as the mouse moves. */
function commitScrub() {
  if (!scrubSpan) return;
  const a = Number($("#scrub-a").value);
  const b = Number($("#scrub-b").value);
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);

  /* Every committed selection is a real window with a real `since` — including one
   * whose left handle is at the stop.
   *
   * There used to be a special case there: the whole track selected meant "follow
   * live", which sends no `since` at all. That reads well and serves the wrong thing.
   * "No since" is tail-then-follow — a couple of hundred lines — so a band drawn
   * across two months of history delivered the last thirty seconds of it. Following
   * live is now its own state, reached by the `live` preset or a double-click, and it
   * has its own place on the track (see `liveHandles`) rather than borrowing the
   * appearance of a selection that means something else.
   *
   * At the stop the request goes a second earlier than the oldest line we measured,
   * so that line falls inside the window rather than on its boundary. */
  let since = lo === 0 ? scrubSpan.from - 1 : scrubToTime(lo);
  const until = hi >= SCRUB_MAX ? null : scrubToTime(hi);

  /* A window that ends at "live" ends at NOW, not at the track's right edge — and the
   * track's right edge is frozen for as long as a window is selected, so the two drift
   * apart while you sit and read. A day-wide selection on a track that stopped moving
   * an hour ago is a 25-hour window, and would come back trimmed.
   *
   * Pull it in here instead, and move the handle to match. The rule is unchanged; what
   * this buys is that the handles never describe a window you don't get. */
  if (since && !until) {
    const w = clampWindow({ since }, maxWindowSec, nowSec());
    if (w.capped) {
      since = w.since;
      moveBandTo(timeToScrub(since), hi);
    }
  }

  selectPreset(null);   // no preset owns this window any more
  $("#custom-range").hidden = true;
  const label = `${lo === 0 ? "oldest" : hhmmss(since)} → ${until ? hhmmss(until) : "now"} ${ZONE}`;
  setRange(
    { since, until },
    until ? `${label} (closed window)` : `${label}, still following`,
    { syncSlider: false, via: "scrubber" },
  );
  paintScrub();   // the band and labels, from the handles as they now stand
}

/* Note on drift: "15m" resolves to a fixed `since` the moment you click it, and
 * from then on the window grows as the stream follows. That's why the note reads
 * "since 04:12:33" rather than "last 15m" — it stays true. Re-anchoring on a timer
 * would mean tearing down and re-spawning every pane's isolate periodically and
 * clearing the panes mid-read, which is a bad trade for a label. Click the preset
 * again to re-anchor. */

// ── the filter ──────────────────────────────────────────────────────────────
/** Adopt both boxes and re-run them over the lines already on screen. Nothing is
 *  re-fetched — no stream re-opens, no isolate re-spawns, no scroll position is
 *  lost — which is what lets this run on every keystroke.
 *
 *  The two are one query by the time anything matches against them; how they combine
 *  is in shared/search.js, with tests. */
function applySearch(text, exclude) {
  search = { text, exclude, query: buildQuery(text, exclude) };
  for (const pane of panes.values()) repaint(pane);
}

/**
 * Re-apply the filter to a pane's existing lines: highlight hits, and hide or show
 * each line. No re-fetch, no flash, no lost scroll position, no re-spawned isolate —
 * which is what makes typing feel instant.
 *
 * The decision is per ENTRY, not per line. A traceback reaches us as seven lines, and
 * matching `TimeoutError` has to show the six frames that say where it came from, not
 * just the one line that happens to contain the word. So lines are gathered by the
 * entry id they were tagged with on arrival, the query runs against the entry's whole
 * text, and every line of a surviving entry is shown.
 *
 * Exclusion works on the entry too, and that's the deliberate half: if any line of a
 * traceback mentions something you asked to hide, the whole traceback goes. Hiding
 * three lines of a stack trace and leaving four would be worse than either extreme.
 *
 * An entry's lines need not be adjacent — in a combined pane another host's output
 * can land between two frames of the same traceback — so this groups by id rather
 * than by position.
 */
function repaint(pane) {
  const atBottom = nearBottom(pane.body);
  const hide = hidingLocally();

  /* Gather first: an entry's verdict depends on lines that may come after this one.
   *
   * A line's text comes from `lineData`, not from the DOM. Reading it back off the
   * element means `textContent` over the span this function itself built last time —
   * walking the marks and the colour wrappers to reassemble a string we were handed
   * when the line arrived, for every line in every pane on every keystroke. The message
   * is the row's last child by construction (see `appendLine`), so finding it doesn't
   * need a subtree search either. */
  const entries = new Map();
  let loose = 0;
  for (const line of pane.body.children) {
    const msg = line.lastElementChild;
    const data = lineData.get(line);
    if (!msg || !data) continue;
    // A line with no entry id predates this grouping or arrived without one; it is
    // its own entry rather than being lumped in with a neighbour.
    const id = line.dataset.entry || `\u0000loose${loose++}`;
    let group = entries.get(id);
    if (!group) entries.set(id, group = { lines: [], text: [] });
    group.lines.push({ line, msg, data });
    group.text.push(data.text);
  }

  let shown = 0;
  for (const group of entries.values()) {
    const hit = search.query.empty || matches(group.text.join("\n"), search.query);
    for (const { line, msg, data } of group.lines) {
      const hidden = hide && !hit;
      line.classList.toggle("filtered", hidden);
      if (!hidden) shown++;
      /* Only what's on screen is re-marked. A hidden line's marks can't be seen, and
       * every repaint re-decides every line — so if this one comes back, it is rendered
       * on that pass, by the branch below, before it becomes visible. With a filter
       * narrowing thousands of lines to a handful, that's the difference between
       * rebuilding the whole buffer per keystroke and rebuilding what you can see.
       *
       * Highlighting stays per line and marks only what that line contains — a frame
       * shown for its neighbour's sake is context, and marking it would claim a hit
       * that isn't there. */
      if (hidden) continue;
      // Keyed by the line, which survives this — only its message child is replaced.
      if (!search.query.empty || msg.firstElementChild) {
        line.replaceChild(renderMessage(data.text, data.runs), msg);
      }
    }
  }

  pane.shown = shown;
  reportState(pane);
  if (atBottom) pane.body.scrollTop = pane.body.scrollHeight;
}

// ── the login gate ──────────────────────────────────────────────────────────
/* The dashboard is covered until this box's yeet instance is logged in. The flow is
 * the device kind: ask the server to start `yeet login`, get back a URL, send the
 * user there, and poll until `whoami` resolves.
 *
 * Host-level rather than per-visitor — see server/auth.js. */
let authPoll = null;
let booted = false;
let identified = false;
let gateShown = false;

/** Tie the session to the yeet owner this box is signed in as, once it's known.
 *
 *  Called from every path that reads `/api/auth`, because which one gets there first
 *  depends on whether the box was already logged in: on boot when it was, and off the
 *  login poll when the reader has just signed in. The server hands over an ORG-/USER-
 *  owner id or nothing at all — see server/auth.js. */
function adoptIdentity(state) {
  if (identified || !state?.identity) return;
  identified = true;
  identify(state.identity, state.identityKind);
}

/** Start the app, once. Called when the gate clears, from whichever path got there. */
function startApp() {
  if (booted) return;
  booted = true;
  /* `gated` separates "someone opened a dashboard that was already signed in" from
   * "someone signed in to open it" — the same event either way, and two quite different
   * sessions. */
  track("dashboard_opened", { gated: gateShown, theme: document.documentElement.dataset.theme || "yeet" });
  $("#gate").hidden = true;
  clearInterval(authPoll);
  authPoll = null;
  refresh();
  setInterval(refresh, REFRESH_MS);
  /* Behind the gate deliberately: the button tells you where this box's source is
   * mounted, which is not something to print in front of a dashboard nobody has
   * signed into yet. No-ops unless the server is in live-edit mode. */
  setupEdit();
}

function showGate(state) {
  gateShown = true;
  $("#gate").hidden = false;
  $("#gate-login").disabled = false;
  // A login already in flight — another tab, or this one before a reload — carries on
  // rather than starting a second `yeet login` racing the first for the same code.
  if (state?.loginPending && state.loginUrl) {
    $("#gate-url").textContent = state.loginUrl;
    $("#gate-url").href = state.loginUrl;
    $("#gate-link").hidden = false;
    pollAuth();
  }
}

async function pollAuth() {
  if (!authPoll) authPoll = setInterval(pollAuth, 2000);
  try {
    const state = await (await fetch("/api/auth", { cache: "no-store" })).json();
    adoptIdentity(state);
    if (state.loggedIn) return void startApp();
    if (state.error) gateError(state.error);
  } catch { /* the server may be restarting; keep polling */ }
}

function gateError(msg) {
  const box = $("#gate-error");
  box.textContent = msg;
  box.hidden = false;
  $("#gate-login").disabled = false;
}

$("#gate-login").addEventListener("click", async () => {
  $("#gate-login").disabled = true;
  $("#gate-error").hidden = true;
  track("login_started");
  /* The tab is opened NOW, synchronously inside the click, and pointed at the URL
   * once the server answers. Opening it after the await would be a popup the browser
   * has no user gesture to attribute, and it would be blocked. */
  const tab = window.open("about:blank", "_blank");
  try {
    const r = await (await fetch("/api/login/start", { method: "POST" })).json();
    if (r.loggedIn) { tab?.close(); return void startApp(); }
    if (!r.ok || !r.url) throw new Error(r.error || "could not start the login");
    if (tab) { try { tab.location.href = r.url; } catch { /* blocked — the link below still works */ } }
    $("#gate-url").textContent = r.url;
    $("#gate-url").href = r.url;
    $("#gate-link").hidden = false;
    pollAuth();
  } catch (err) {
    tab?.close();
    gateError(String(err.message ?? err));
  }
});

// ── boot ────────────────────────────────────────────────────────────────────
$("#add-host").addEventListener("submit", addHost);
/* Filters as you type. The small debounce is for render cost, not for the network —
 * nothing is fetched — and it coalesces a fast typist's keystrokes into one pass over
 * the lines. */
let findTimer = null;
const runFind = () => {
  clearTimeout(findTimer);
  applySearch($("#find-input").value.trim(), $("#find-exclude").value.trim());
  noteFind();
};

/* Counting the filter, on a much longer timer than the one that runs it.
 *
 * Two reasons it isn't just tracked in `runFind`. Typing `timeout` at 60ms per pass is
 * seven filters and one act of filtering, and the event would be junk. And whatever this
 * records must survive being looked at later: the terms themselves are never sent, so all
 * that's left is how the box is being used — one term or several, whether the exclude box
 * is in play at all, and how much it cut down.
 *
 * NOT the query. A log filter is where someone types the request id, the customer's
 * email, the token they're chasing through a stack — the term is frequently the most
 * sensitive string on the screen, and it's typed by hand into a box. There is no version
 * of shipping it that is all right. */
let findNoteTimer = null;
let lastFindShape = "";
function noteFind() {
  clearTimeout(findNoteTimer);
  findNoteTimer = setTimeout(() => {
    const include = parseQuery($("#find-input").value.trim());
    const exclude = parseQuery($("#find-exclude").value.trim());
    if (include.empty && exclude.empty) return;      // clearing the box isn't a filter
    // Retyping the same shape after a pause is the same filter, not a new one.
    const shape = `${include.terms.length}/${exclude.terms.length}`;
    if (shape === lastFindShape) return;
    lastFindShape = shape;
    let shown = 0;
    let loaded = 0;
    for (const pane of panes.values()) { shown += pane.shown ?? 0; loaded += pane.count; }
    track("filter_used", {
      terms: include.terms.length,
      excluded: exclude.terms.length,
      phrases: [...include.terms, ...exclude.terms].filter((t) => t.text.includes(" ")).length,
      panes: panes.size,
      // How well it narrowed, in buckets — a ratio, never the counts of somebody's lines.
      hit_ratio: loaded > 0 ? Math.round((shown / loaded) * 10) / 10 : null,
    });
  }, 1500);
}
for (const id of ["#find-input", "#find-exclude"]) {
  const box = $(id);
  box.addEventListener("input", () => {
    clearTimeout(findTimer);
    findTimer = setTimeout(runFind, 60);
  });
  // Escape clears the box you're in — not both, since the two are used separately
  // and losing the one you'd just got right would be its own small disaster.
  box.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !box.value) return;
    ev.stopPropagation();
    box.value = "";
    runFind();
  });
}
$("#find-form").addEventListener("submit", (ev) => { ev.preventDefault(); runFind(); });

/* Folding the whole sidebar away, for when the logs want the width.
 *
 * Not persisted, for the same reason the per-host collapse isn't: it describes how
 * you're using the screen right now, and a reload is a fair moment to see everything
 * again. Nothing else has to know — `main` is a flex row and `.panes` takes what's
 * left, so the panes widen on their own. */
{
  const panel = $("#host-panel");
  const toggle = $("#hosts-toggle");

  const setCollapsed = (collapsed) => {
    panel.classList.toggle("collapsed", collapsed);
    toggle.textContent = collapsed ? "»" : "«";
    toggle.setAttribute("aria-expanded", String(!collapsed));
    const what = collapsed ? "show the container list" : "hide the container list";
    toggle.title = `${what} (ctrl+B)`;
    toggle.setAttribute("aria-label", what);
    // Expanding is nearly always the prelude to looking for something.
    if (!collapsed) $("#host-filter").focus();
  };

  toggle.addEventListener("click", () => setCollapsed(!panel.classList.contains("collapsed")));

  /* Ctrl/Cmd+B, the shortcut every editor uses for the same gesture. Deliberately not
   * a bare key: this page has three text inputs, and a single-key binding would fire
   * mid-word in any of them. */
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "b" && ev.key !== "B") return;
    if (!(ev.ctrlKey || ev.metaKey) || ev.altKey) return;
    ev.preventDefault();
    setCollapsed(!panel.classList.contains("collapsed"));
  });
}

/* The sidebar filter. No debounce: this re-renders a list of tens of rows, not
 * thousands of log lines, and the typeahead has to feel immediate to be worth using
 * instead of the mouse. */
{
  const box = $("#host-filter");
  box.addEventListener("input", () => {
    hostFilter = parseQuery(box.value.trim());
    // The old cursor may be on a row the new query hides; the first match is a better
    // guess than a selection that isn't on screen.
    hostCursor = null;
    renderHosts();
  });
  box.addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown") { ev.preventDefault(); return moveHostCursor(1); }
    if (ev.key === "ArrowUp") { ev.preventDefault(); return moveHostCursor(-1); }
    if (ev.key === "Enter") { ev.preventDefault(); return attachHostCursor(); }
    if (ev.key === "Escape" && box.value) {
      // Escape clears the box rather than blurring it, so a mistyped search is one
      // key from gone and you're still in position to retype.
      ev.stopPropagation();
      box.value = "";
      hostFilter = parseQuery("");
      hostCursor = null;
      renderHosts();
    }
  });
}
$("#find-clear").addEventListener("click", () => {
  $("#find-input").value = "";
  $("#find-exclude").value = "";
  runFind();
  $("#find-input").focus();
});

/* The scrubber. `input` fires continuously while dragging — that only repaints the
 * band and the labels. `change` fires on release, and only that re-opens the streams.
 *
 * The two handles are separate inputs, so nothing in the platform stops one being dragged
 * past the other: `keepOrder` blocks it on every change (see `blockCross` for why blocking
 * and not swapping). The min/max taken at read time elsewhere in here stays as a backstop —
 * a crossed pair reaching `paintScrub` or `commitScrub` from some path this doesn't cover
 * still describes the right window rather than a negative-width one. */
for (const id of ["#scrub-a", "#scrub-b"]) {
  const input = $(id);
  // `pointerdown` and `keydown` claim the handles before any value changes, so even
  // the first movement of a drag can't be overwritten by a poll landing on it.
  const which = id === "#scrub-a" ? "a" : "b";
  input.addEventListener("pointerdown", () => { scrubBusy = true; scrubActive = which; });
  input.addEventListener("keydown", () => { scrubBusy = true; scrubActive = which; });
  input.addEventListener("input", () => {
    scrubBusy = true;
    scrubActive = which;
    keepOrder(which);    // first: limitWidth pushes from where the dragged handle ended up
    limitWidth(which);   // before the repaint, so the band never draws a window it won't commit
    paintScrub();
  });
  input.addEventListener("change", () => { scrubBusy = false; scrubActive = null; commitScrub(); });
  /* Releasing without moving fires no `change`, so the claim has to be dropped here
   * too or the slider would freeze after a stray click on a thumb. Deferred by a
   * turn: `pointerup` lands *before* `change`, and clearing the flag first would
   * reopen the very gap the flag exists to close — a poll could then rewrite the
   * handles in between, and `commitScrub` would read the rewritten ones. */
  const release = () => setTimeout(() => { scrubBusy = false; scrubActive = null; paintScrub(); }, 0);
  input.addEventListener("pointerup", release);
  input.addEventListener("pointercancel", release);
  input.addEventListener("blur", release);
}
/* The band drag. Same contract as the handles: `scrubBusy` while the pointer is down
 * so nothing else rewrites the window, repaint on every move, re-open the streams once
 * on release.
 *
 * Pixels are converted to positions against the track width measured at the start of
 * the drag, and every position is derived from the edges the drag started from rather
 * than accumulated per move — accumulating would drift by a rounding error each frame,
 * and a window that ends up a few seconds narrower than it started is exactly the bug
 * this control exists to avoid. */
{
  const band = $("#scrub-fill");
  let drag = null;   // {x, lo, hi, width, moved}

  band.addEventListener("pointerdown", (ev) => {
    if (!scrubSpan) return;
    const [lo, hi] = bandEdges();
    drag = { x: ev.clientX, lo, hi, width: $(".scrub-track").getBoundingClientRect().width, moved: false };
    scrubBusy = true;
    scrubActive = "band";
    band.classList.add("dragging");
    band.setPointerCapture(ev.pointerId);
    ev.preventDefault();       // no text selection while sliding
    paintScrub();
  });

  band.addEventListener("pointermove", (ev) => {
    if (!drag || drag.width === 0) return;
    const [lo, hi] = shiftWindow(drag.lo, drag.hi, ((ev.clientX - drag.x) / drag.width) * SCRUB_MAX);
    if (lo === drag.lo && hi === drag.hi) return;
    drag.moved = true;
    moveBandTo(lo, hi);
  });

  const endDrag = () => {
    if (!drag) return;
    const moved = drag.moved;
    drag = null;
    band.classList.remove("dragging");
    scrubBusy = false;
    scrubActive = null;
    // A click that didn't move anything is not a range change. Committing it anyway
    // would tear down and re-open every pane's stream to arrive at the same window.
    if (moved) commitScrub();
    else paintScrub();
  };
  band.addEventListener("pointerup", endDrag);
  band.addEventListener("pointercancel", endDrag);

  /* Keyboard: the same gesture for anyone not using a pointer. The arrows nudge, the
   * commit waits for the key to come up so holding one down slides continuously and
   * re-opens the streams once, at the end, rather than on every repeat. */
  band.addEventListener("keydown", (ev) => {
    if (!scrubSpan) return;
    const step = ev.key === "ArrowLeft" ? -1 : ev.key === "ArrowRight" ? 1 : 0;
    if (step === 0) return;
    ev.preventDefault();
    scrubBusy = true;
    scrubActive = "band";
    const [lo, hi] = bandEdges();
    moveBandTo(...shiftWindow(lo, hi, step * (ev.shiftKey ? 50 : 10)));
  });
  band.addEventListener("keyup", (ev) => {
    if (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight") return;
    scrubBusy = false;
    scrubActive = null;
    commitScrub();
  });
  band.addEventListener("blur", () => {
    if (drag) return;
    scrubBusy = false;
    scrubActive = null;
    paintScrub();
  });
}

// Double-click the track to snap back to following. Goes through `goLive` rather
// than writing handle positions and committing them: the handles can't express
// "no window", so committing them would ask for one.
$("#scrub").addEventListener("dblclick", () => goLive());

/* Keep the "N of M" counter honest while lines stream in. Updated on a timer rather
 * than per line: a busy container would otherwise rewrite the status text hundreds of
 * times a second to say almost the same thing. */
setInterval(() => {
  if (search.query.empty) return;
  for (const pane of panes.values()) reportState(pane);
}, 300);
for (const btn of document.querySelectorAll(".range button")) {
  btn.addEventListener("click", () => applyPreset(btn));
}
$("#custom-range").addEventListener("submit", applyCustom);
$("#range-cancel").addEventListener("click", () => { $("#custom-range").hidden = true; });
/* Not gated, unlike the live-edit button: the theme is already applied before this runs
 * (see the inline script in index.html), so all this does is label the button that
 * changes it — and a control that sits there unlabelled until you sign in looks broken. */
setupTheme({ onChange: (theme) => track("theme_changed", { theme }) });
/* Sprites are read once at boot and then used synchronously, because a pane is built in
 * response to a click and must not wait on a fetch to draw its own header. Panes opened
 * before this resolves get the drawn pokéball, which is the correct fallback anyway. */
loadSprites().then(() => {
  const { a, b } = sliderSprites();
  /* Handed to CSS as custom properties rather than set as styles, because the thing being
   * painted is a `::-webkit-slider-thumb` — a pseudo-element JS cannot touch directly.
   * Custom properties inherit into it, which is the only way in. */
  if (a) $("#scrub-a").style.setProperty("--thumb", `url("${a}")`);
  if (b) $("#scrub-b").style.setProperty("--thumb", `url("${b}")`);
});
$("#range-note").textContent = "following, newest lines as they arrive";
$("#range-zone").textContent = ZONE || "this machine's local time";

/* Nothing polls until the gate is clear. Starting the container poll behind a gate
 * would fill the sidebar underneath the sign-in card — visible round its edges, and
 * a needless request every five seconds to a dashboard nobody has reached yet. */
(async () => {
  try {
    const state = await (await fetch("/api/auth", { cache: "no-store" })).json();
    /* Analytics comes up from the same answer, before the gate is decided either way:
     * `login_started` and the sign-in card itself are things worth counting, and both
     * happen on the locked side of the door. Off entirely unless the server sent a key. */
    initAnalytics(state.analytics);
    adoptIdentity(state);
    if (state.loggedIn) startApp();
    else showGate(state);
  } catch {
    // The gate can't be asked about, so don't stand in front of the dashboard on a
    // guess — a server that answers nothing will make itself obvious soon enough.
    //
    // Analytics is settled OFF rather than left alone: its config came from the request
    // that just failed, and an uninitialised module queues what it's handed against a
    // load that is never coming.
    initAnalytics(null);
    startApp();
  }
})();
