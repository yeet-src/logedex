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
// Which rules out two features PostHog would otherwise give us for free, both off below
// and neither sampled:
//
//   * autocapture — reads the text of whatever was clicked. In this UI that is a log
//     line, a container name, or a host's URL.
//   * exception autocapture — an error's message quotes what was being parsed, and this
//     page parses log lines.
//
// SESSION REPLAY IS ON, and it is the one feature here that records the screen rather
// than describing it. What it may keep is drawn much tighter than the default, but not as
// tight as it could be, and the line is deliberate: THE LOGS ARE THE SECRET, and the app
// around them is ours. Container names, host labels, image names, button text, pane
// chrome, tooltips — all of that records normally, because it is this product's own UI and
// seeing it is the entire point of watching a replay.
//
// What stays redacted, in the browser, before rrweb builds a snapshot:
//
//   * the log line itself — `.msg` and everything inside it, which is where a container's
//     output lands. Nested, because a line with ANSI colour or a search hit is split into
//     child spans and each one holds a slice of the same text.
//   * a pattern someone typed — the filter boxes, an alert rule's regex (`.alert-pattern`)
//     and the toast that quotes it back (`.toast-msg`). These are not log text but they
//     are derived from it, and the term is often the sensitive part on its own: you grep
//     for the customer id you are chasing.
//   * `title` on an alert badge, which can carry `rule.lastError` — a failed Slack send,
//     quoting the payload it was trying to send, which is matched lines plus context.
//
// So the residual risk is named rather than absent: if a future pane renders log text
// OUTSIDE `.msg`, it records. That is the one thing to check when adding to the log view —
// the selector list below is the whole policy, and it is a list of places, not a blanket.
//
// Deliberately NOT a deny-everything allowlist any more. The previous version masked every
// attribute not explicitly permitted, which also caught the synthetic ones rrweb invents
// for itself — `_cssText`, where an external stylesheet is inlined, and the `rr_*` pair
// carrying scroll offsets and geometry. Redacting those replays the page with no CSS and
// the wrong scroll position, and nothing about the symptom points at the mask. Allowing by
// default and naming the few exceptions cannot reproduce that class of bug at all.
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

/* The only attributes session replay may ship verbatim. Everything else is redacted,
 * including anything added later — the allowlist IS the policy, so a new tooltip is
 * masked because nobody touched this file, rather than leaked because nobody remembered
 * it. Deny-by-default is the only direction that survives a year of features.
 *
 * What's here is structural: what the replayer needs to lay the page out and paint it.
 * Two deliberate absences, both checked against app.js rather than assumed:
 *
 *   * `title`, `aria-label`, `alt`, `placeholder`, `value` — the text-bearing ones. In
 *     this UI `title` carries `${hostLabel} · ${container} · ${image}`, a container's
 *     status and short id, and `rule.lastError`, which quotes what the rule was matching.
 *   * `data-*` — log rows carry `data-key` and `data-entry`, which identify a line.
 *
 * `class` and `id` ARE here, and that is safe only because nothing derives them from a
 * host or container name. If that ever changes, they come out.
 *
 * Names are matched lowercased, so SVG's camelCase attributes appear lowercased here
 * (`viewbox`, `preserveaspectratio`) — spelling them as authored would silently mask them
 * and quietly wreck every icon in the replay. */
/* The text replay may not keep. Everything not matched here records normally — see the
 * note at the top of this file for why that is the right default here and what it costs.
 *
 * `.msg *` is not redundant with `.msg`: a plain line is one text node under `.msg`, but a
 * line carrying ANSI colour or a live search hit is cut into child spans, each holding a
 * slice of the same string. Matching only the parent would redact the ordinary lines and
 * leave the interesting ones — the coloured errors, the ones someone is actively grepping
 * for — in the clear, which is the worst possible half to keep. */
const REPLAY_MASK_SELECTOR = [
  ".msg", ".msg *",       // a container's output
  ".alert-pattern",       // a regex over someone's logs
  ".toast-msg",           // which quotes that regex back after a save
].join(", ");

/* Inputs are the other way round — masked unless named, because every free-text field in
 * this UI except these two is a search over someone's logs. These two are the box's own
 * address and the label the operator gave it: app config, and the funnel worth watching. */
const REPLAY_SAFE_INPUTS = "#host-url, #host-label";

/* Fixed-width, so the redaction can't be measured. rrweb's own default is one `*` per
 * character, which would leave the LENGTH of a filter term or a customer id in the
 * recording. */
const REDACTED = "***";

/* True for the handful of attributes that can hold log-derived text. Everything else —
 * including `title` on a pane, a container or a host, and including rrweb's own `_cssText`
 * and `rr_*` — passes through untouched. */
function masksAttribute(name, element) {
  const n = String(name).toLowerCase();
  // A serialized input value; `maskInputFn` governs the live one, this is the markup.
  if (n === "value") return true;
  /* `rule.lastError` is a failed Slack send, and the message quotes the payload — matched
   * lines and their context. The sibling badges on this row are host and container names,
   * which are fine now, but they share a class and are not worth telling apart for a
   * tooltip. */
  if (n === "title") return !!element?.closest?.(".picker-badge");
  return false;
}

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
      // The two that would read the logs into event properties. See the note at the top.
      autocapture: false,
      capture_exceptions: false,
      /* Replay, masked at the source. Every key here is load-bearing; see the note at the
       * top of this file before removing one.
       *
       * PostHog does not enumerate these — it spreads this object into rrweb's `record()`
       * — so they are rrweb's names, not the SDK's, and a typo is silently ignored rather
       * than rejected. A misspelled mask is an unmasked recording that looks configured. */
      disable_session_recording: false,
      session_recording: {
        // The log lines and the patterns typed against them. Everything else is ours.
        maskTextSelector: REPLAY_MASK_SELECTOR,
        /* Masked by default, then handed back one by one: `maskAllInputs` decides WHETHER
         * an input is masked and `maskInputFn` decides what the value becomes, so the pair
         * is an allowlist. Returning the text unchanged is how a field opts out. */
        maskAllInputs: true,
        maskInputFn: (text, element) =>
          (element?.closest?.(REPLAY_SAFE_INPUTS) ? text : REDACTED),
        /* rrweb calls this for EVERY attribute once it is supplied — including the ones it
         * generated itself, since supplying a function makes it skip its own `isGenerated`
         * exemption. Hence allow-by-default: see the note at the top about the stylesheet. */
        maskAttributeFn: (name, value, element) =>
          (masksAttribute(name, element) ? REDACTED : value),
        /* Off by default, all four — pinned because each is a way for the logs to re-enter
         * a recording that is otherwise clean, and a default is a weaker promise than a
         * line of config. Headers and bodies would carry the log payloads straight from
         * the stream; canvas and cross-origin frames are pixels nothing above can mask. */
        recordHeaders: false,
        recordBody: false,
        recordCanvas: false,
        recordCrossOriginIframes: false,
      },
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
