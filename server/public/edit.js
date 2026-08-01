// The "live edit" button and the panel behind it.
//
// Shown when the server is running from an editable copy of its own source, which it
// reports at /api/edit — the normal case for the container, and not the case for a
// server started straight out of a git checkout. Its whole job is to hand an AI agent
// the three things it can't work out for itself:
//
//   1. WHERE the code is on the host — inside the container it's /edit, which is not
//      a path the agent can open.
//   2. WHICH saves restart the server and which only need a browser reload, because
//      those are different loops and guessing wrong wastes a lot of time.
//   3. WHERE a crash goes, so a broken edit is a file it can read rather than a
//      dashboard that just stopped answering.
//
// The prose lives here, in the browser, rather than in the server — which means it's
// one of the files this feature lets you rewrite. If the instructions turn out to be
// unclear, the agent reading them can fix them.

/** The instructions, as text to paste into an agent. Built from the server's facts so
 *  the paths are always this deployment's, never an example.
 *
 *  Written as a briefing rather than a numbered procedure on purpose: an agent that
 *  knows the layout and the two reload rules will do the right thing, whereas a
 *  script tells it what to type and nothing about what it's touching. */
export function agentBrief(info) {
  /* The host path is passed in by whoever started the container (`make edit` does it).
   * It can't be worked out from in here: a bind mount's entry in /proc/self/mountinfo
   * gives its path relative to the FILESYSTEM it lives on, so a directory under a
   * separate mount comes out missing its prefix — a plausible path that doesn't exist.
   * A wrong path sends an agent off editing a directory nobody is serving, so when it's
   * unknown, say so and describe the directory instead. Whoever ran the container typed
   * that path; they can supply it. */
  const root = info.hostPath || `<the host directory you mounted at ${info.containerPath}>`;
  const note = info.hostPath ? "" : `
(Whoever started this container didn't pass EDIT_SRC_HOST, so the dashboard can't name
the path on the host — substitute the directory you mounted at ${info.containerPath}.)
`;
  return `You're editing Logédex, a log dashboard, WHILE IT RUNS. Don't stop or rebuild the container.

The source is at:
  ${root}
${note}
That's a bind mount of the running server's own code — ALL of it, every file the app
runs. There is no part of the behaviour you can't change from there, including how it
talks to the yeet daemon. Edit files and they take effect in place. Layout, from that
directory:

  server/index.js       HTTP server and routes
  server/*.js           backend: logs.js (streaming), hosts.js, graph.js, auth.js, remote.js
  server/isolate.js     spawns the daemon isolates and owns their lifecycle
  server/public/app.js  the dashboard UI — plain DOM ES modules, no framework, no build
  server/public/*.js    order.js (merge/ordering), entries.js, ansi.js, theme.js,
                        sprites.js — all of it plain modules, most of it unit-tested
  server/public/style.css
  server/public/sprites/  creature icons, swappable by dropping files in — see the
                        README in that directory for the naming rules
  shared/*.js           imported by more than one runtime (search.js, limits.js)
  agent/logstream.js    runs INSIDE the yeet daemon's V8 isolate, one per attached
                        container: holds the docker_logs GraphQL subscription open and
                        prints one JSON object per line. This is the data layer — change
                        it and you change what gets collected, not just what's shown.

Two reload rules, and they matter:

  * Saving under server/, shared/ or agent/ RESTARTS the server by itself (node
    --watch). Takes about a second. Open log panes reconnect on their own.
    agent/ counts because the isolate script is re-read every time a stream attaches,
    and the restart is what re-attaches them — so you never have to detach by hand.
  * Saving under server/public/ needs nothing but a browser reload — those files are
    read from disk per request. The page notices and offers you one.

What is NOT here, because it can't take effect without a rebuild: the Dockerfile, the
entrypoint, and the Makefile. Those decide how the container starts, so changing how the
app is BUILT or LAUNCHED means editing the git checkout on the host and rebuilding. Don't
go looking for them in this directory, and don't try to work around their absence.

If you break a file the SERVER imports, it exits and STAYS DOWN until you fix it —
that's normal, and it recovers with no help from you. The crash is written to:
  ${root}/${info.log}
Read that file to see what you broke. Save a fix and it starts again automatically; you
do not need to restart anything or ask anyone to.

Not everything fails that loudly, so check the right place. THREE runtimes load code from
this directory, and each one fails somewhere different:

  the server    — a crash lands in the log above
  the browser   — errors go to the browser console; the server stays happily up
  the isolate   — agent/logstream.js runs in the daemon, so a failure there is one
                  stream that dies or shows an error, not a server that goes down

shared/ spans them: shared/limits.js is loaded by the server, shared/search.js by the
browser AND the isolate. So breaking search.js leaves the server answering normally while
the page or a stream quietly stops. If the server is up but the dashboard is wrong, the
browser console is where to look, not the log above.

There are tests, and they run without a container or any npm install:
  cd ${root}/server && node --test
  cd ${root}/shared && node --test

Two things to leave alone: this code runs as root in a container holding the host's
Docker socket, so don't add anything that executes request input or writes files from
an HTTP handler. And every file has a comment explaining WHY it is the way it is —
those are load-bearing. Update them when you change the reasoning; don't strip them.`;
}

const ASSET_POLL_MS = 2500;

/**
 * Notice when the frontend on disk stops matching the frontend in this tab, and offer a
 * reload.
 *
 * This closes the one genuinely confusing gap in editing the dashboard live. A backend
 * edit announces itself — the server restarts and the streams blink — but the browser's
 * own files are served from disk per request, so an agent rewriting app.js changes
 * nothing you can see and produces no signal at all. Without this, the loop is "edit,
 * stare, wonder, reload on a hunch".
 *
 * Offered, never taken: a page that reloads itself would throw away your open panes,
 * your filters and your scroll position — mid-incident, possibly while you were reading
 * something — and it would do it repeatedly while an agent saves a file every few
 * seconds. The prompt waits, and it says which of the two things happened.
 *
 * Only runs in edit mode, so an ordinary deployment never polls for this.
 */
function watchForNewAssets(loadedVersion) {
  const bar = document.querySelector("#edit-stale");
  if (!bar || !loadedVersion) return;
  const reload = bar.querySelector("#edit-stale-reload");
  const dismiss = bar.querySelector("#edit-stale-dismiss");
  // Once dismissed, stay quiet for THIS version — an agent mid-task saves repeatedly,
  // and a prompt that keeps coming back for the same change is a prompt you learn to
  // ignore. A genuinely newer version speaks up again.
  let muted = null;

  reload.addEventListener("click", () => location.reload());
  dismiss.addEventListener("click", () => { muted = bar.dataset.version || null; bar.hidden = true; });

  setInterval(async () => {
    let v;
    try {
      const r = await fetch("/api/edit", { cache: "no-store" });
      v = (await r.json())?.assetVersion;
    } catch {
      // The server is mid-restart or down on a bad edit. Not our business to report —
      // it's expected here, and the crash log is where that story is told.
      return;
    }
    if (!v || v === loadedVersion || v === muted) return;
    bar.dataset.version = v;
    bar.hidden = false;
  }, ASSET_POLL_MS);
}

/** Wire the button and its panel. No-ops when edit mode is off, so app.js can call
 *  this unconditionally. */
export async function setupEdit() {
  const btn = document.querySelector("#edit-btn");
  const panel = document.querySelector("#edit-panel");
  if (!btn || !panel) return;

  let info;
  try {
    const r = await fetch("/api/edit");
    info = await r.json();
  } catch {
    return;   // can't reach our own server; the dashboard has bigger problems to show
  }
  if (!info?.enabled) return;   // stays hidden, which is the default state in the HTML

  btn.hidden = false;
  const brief = agentBrief(info);
  const pathEl = panel.querySelector("#edit-path");
  const textEl = panel.querySelector("#edit-brief");
  const copyBtn = panel.querySelector("#edit-copy");
  const closeBtn = panel.querySelector("#edit-close");

  // Named exactly when it's known, and described when it isn't — see agentBrief.
  pathEl.textContent = info.hostPath || `the directory you mounted at ${info.containerPath}`;
  textEl.value = brief;

  const open = () => {
    panel.hidden = false;
    // Select it all, so the paste is one keystroke away even if the copy button is
    // unavailable — see below for when that happens.
    textEl.focus();
    textEl.select();
  };
  const close = () => { panel.hidden = true; btn.focus(); };

  btn.addEventListener("click", () => (panel.hidden ? open() : close()));
  closeBtn.addEventListener("click", close);
  // Click the backdrop, not the card, to dismiss.
  panel.addEventListener("mousedown", (e) => { if (e.target === panel) close(); });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !panel.hidden) close();
  });

  watchForNewAssets(info.assetVersion);

  copyBtn.addEventListener("click", async () => {
    // navigator.clipboard is unavailable on a plain-HTTP origin that isn't localhost,
    // which is exactly how this dashboard is usually reached (http://box.lan:8080).
    // So the textarea is the real interface and the button is the convenience: on
    // failure, say so and leave the text selected rather than reporting a copy that
    // didn't happen.
    try {
      await navigator.clipboard.writeText(brief);
      copyBtn.textContent = "copied";
    } catch {
      textEl.focus();
      textEl.select();
      copyBtn.textContent = "press ⌘/ctrl+C";
    }
    setTimeout(() => { copyBtn.textContent = "copy"; }, 2000);
  });
}
