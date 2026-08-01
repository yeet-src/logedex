// Product analytics (PostHog), loaded only when the server hands the page a key.
//
// Two things make this different from a normal web-app install.
//
// THE LIBRARY COMES FROM THE YEET PROXY (https://ph.yeet.cx by default, POSTHOG_HOST to
// change it), not from us.posthog.com. So the browser never talks to PostHog directly,
// and the script survives an ad blocker's host list.
//
// AND WHAT'S ON THIS SCREEN IS SOMEONE ELSE'S PRODUCTION LOGS. That is the whole
// constraint, and it is stricter here than in most places this library gets installed.
// A dashboard full of `docker logs` from a fleet holds request paths, customer ids,
// stack traces, connection strings and whatever else a container decided to print — and
// around it, the names of the hosts, the containers and the images that make up a
// private deployment. None of that is ours, and none of it goes anywhere.
//
// Which rules out three features PostHog would otherwise give us for free, all off below
// and none of them sampled:
//
//   * autocapture — reads the text of whatever was clicked. In this UI that is a log
//     line, a container name, or a host's URL.
//   * session recording — the same thing, continuously, for the whole session.
//   * exception autocapture — an error's message quotes what was being parsed, and this
//     page parses log lines.
//
// And it shapes what the events themselves may carry. Every event here describes the
// INTERACTION and never its subject: how many streams were combined, not which; that a
// filter was typed, not what was typed (a filter is a search over someone's logs — the
// term itself can be the sensitive part, and often is, because you grep for the id
// you're chasing). Counts, kinds and booleans are fine; names, labels, URLs, patterns,
// container ids and anything free-text are not. Keep it that way when adding events:
// there is no scrubber downstream that can put this back.

/* Calls made before the library has loaded, replayed in order once it has. Analytics
 * initialises off `/api/auth`, a round trip after the page starts running, so the boot
 * events would otherwise be the ones lost. */
let queue = [];
let ready = false;
let enabled = false;

/* Which product an event belongs to. Several of these dashboards report into ONE PostHog
 * project, and their event names genuinely collide: `dashboard_opened`, `login_started`
 * and `alert_rule_created` exist in more than one of them, with different properties on
 * each. Unlabelled, those are a single meaningless series.
 *
 * Applied in `sanitize_properties` (see below) rather than merged into each `track()` call,
 * because the events this file raises are not the only events sent. `$pageview` and
 * `$pageleave` come from the library itself and never pass through `track()`, so a
 * per-call property labels the deliberate events and leaves the automatic ones anonymous —
 * which is exactly the half that quietly pollutes a shared project. Registering a super
 * property would cover them, but only after `init()` returns; `sanitize_properties` runs
 * per event on the way out, so it cannot be beaten by the initial pageview.
 *
 * The name comes from the SERVER, not a constant here, so this file can be copied to the
 * next dashboard unchanged and the one thing that differs stays in that server's config.
 * A copy carrying a hardcoded name would mislabel a whole product's data and look
 * completely fine doing it. */
let app = "unknown";

const ph = () => (window.posthog?.__loaded ? window.posthog : null);

/**
 * Record an interaction. A no-op when analytics is off, and queued when the library
 * hasn't landed yet — so callers never have to know which of the three states we're in.
 *
 * @param {string} event  snake_case, past tense: what happened, not what to do about it
 * @param {object} [props]  counts, kinds and booleans only — see the note at the top
 */
export function track(event, props) {
  if (ready && !enabled) return;
  const live = ph();
  if (live) live.capture(event, props);
  else if (!ready) queue.push(["capture", event, props]);
}

/**
 * Tie this session to the yeet owner the box is signed in as — an ORG- id for a host an
 * organisation owns, a USER- id for a personal one (see server/auth.js, which will only
 * ever hand over one of those two shapes).
 *
 * The id is the whole identity. No email, no host label, no container list: this says
 * which account is looking, and nothing about what they're looking at.
 */
export function identify(id, kind) {
  if (!id || (ready && !enabled)) return;
  const props = kind ? { owner_kind: kind } : undefined;
  const live = ph();
  if (live) live.identify(id, props);
  else if (!ready) queue.push(["identify", id, props]);
}

/** This page's URL with everything but the path removed.
 *
 *  Nothing puts a container or a host in the URL today — the dashboard is one route and
 *  its state lives in memory. This is here so that stays true by construction rather
 *  than by everyone remembering: the first feature to deep-link a pane would otherwise
 *  start shipping container names as `$current_url` without anyone changing this file. */
function sanitizeUrl(value) {
  if (typeof value !== "string") return value;
  try {
    const u = new URL(value, window.location.origin);
    u.search = "";
    u.hash = "";
    return u.toString();
  } catch {
    return value.split(/[?#]/)[0];
  }
}

const URL_PROPS = ["$current_url", "$referrer", "$initial_current_url", "$initial_referrer", "$pathname"];

/**
 * Load and initialise PostHog. Safe to call with no config, which is what an operator
 * setting `POSTHOG_KEY=""` produces — `track` and `identify` then stay no-ops for the
 * page's life and no script is fetched.
 *
 * @param {{key: string, host: string, app?: string, debug?: boolean} | null} cfg  from /api/auth
 */
export function initAnalytics(cfg) {
  if (ready) return;
  if (!cfg?.key) {
    ready = true;
    queue = [];
    return;
  }
  /* Left as "unknown" if the server didn't say. Deliberately a visible wrong answer rather
   * than an absent property: an unlabelled event is indistinguishable from the dashboards
   * that predate this convention, so it would look like nothing was wrong. */
  if (cfg.app) app = cfg.app;

  const script = document.createElement("script");
  script.src = `${cfg.host}/static/array.js`;
  script.async = true;
  script.onload = () => {
    if (!window.posthog?.init) return void (ready = true, queue = []);
    window.posthog.init(cfg.key, {
      api_host: cfg.host,
      // One route, no history pushes — so the automatic pageview is the whole of it.
      capture_pageview: true,
      capture_pageleave: true,
      // The three that would read the logs. See the note at the top of this file.
      autocapture: false,
      disable_session_recording: true,
      capture_exceptions: false,
      debug: !!cfg.debug,
      // Runs on the way out for EVERY event, the library's own included — which is why
      // `app` is stamped here. See the note by it.
      sanitize_properties: (props) => {
        props.app = app;
        for (const k of URL_PROPS) if (k in props) props[k] = sanitizeUrl(props[k]);
        return props;
      },
    });
    ready = true;
    enabled = true;
    const q = queue;
    queue = [];
    for (const [kind, a, b] of q) {
      if (kind === "identify") window.posthog.identify(a, b);
      else window.posthog.capture(a, b);
    }
  };
  /* No route to the proxy — a box running this often has no general internet — or a
   * blocked request. Drop what queued rather than growing it for the page's lifetime;
   * a dashboard that leaks memory because analytics couldn't load is a worse bug than
   * having no analytics. */
  script.onerror = () => {
    ready = true;
    enabled = false;
    queue = [];
  };
  document.head.appendChild(script);
}
