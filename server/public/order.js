// The logic behind interleaved panes: which streams to offer merging with, what
// order their lines go in, and how their timestamps read. These live here as pure
// functions the browser imports and a test exercises directly
// (server/public/order.test.js) — the rest of the dashboard is DOM wiring, but
// these fail *quietly*, offering the wrong default, a plausible-but-false line
// order, or a time that's off by a whole timezone.
//
// TIMEZONES, once, since three separate things get confused here:
//
//   Ordering needs no timezone handling at all. Docker stamps lines RFC-3339 in
//   UTC with a `Z`, so every stamp is an absolute instant — two hosts in Tokyo and
//   New York produce directly comparable strings, and comparing them IS comparing
//   instants. Timezone is a formatting question, never an ordering one.
//
//   Clock skew is unrelated to timezone. A machine set to the wrong zone still
//   reports the right instant; only a wrong *clock* (bad NTP) moves it. So the
//   skew warning can't be tripped by hosts in different zones — which is what
//   makes it worth trusting when it does fire.
//
//   Display is where a zone belongs, and it must be the viewer's, because that's
//   the zone they type into the range picker and read their own wall clock in.

// ── which streams to merge with ─────────────────────────────────────────────
/**
 * Rank the streams `origin` could be interleaved with, and mark which to
 * pre-select.
 *
 * The default aims at one case: the same service running on other boxes. Image
 * equality identifies that better than name equality — two hosts can both run a
 * container called `nginx` from different images, and the same image is often
 * deployed under different names.
 *
 * But image alone over-selects on a shared base image: everything built `FROM
 * alpine` would tick. So the preselect is image AND name when anything matches
 * both, falling back to image alone when nothing does. Ranking always puts the
 * likeliest first regardless, so a wrong default is one click from right.
 *
 * @param {{hostId:string,container:string,image?:string}} origin
 * @param {Array<{hostId:string,container:string,image?:string}>} candidates
 * @returns {Array<{stream:object, preselect:boolean, why:string}>}
 */
export function mergeCandidates(origin, candidates) {
  const sameImage = (s) => !!s.image && !!origin.image && s.image === origin.image;
  const sameName = (s) => s.container === origin.container;

  const tier = (s) => (sameImage(s) && sameName(s) ? 0 : sameImage(s) ? 1 : sameName(s) ? 2 : 3);
  const ranked = [...candidates].sort((a, b) =>
    tier(a) - tier(b)
    || String(a.hostLabel ?? a.hostId).localeCompare(String(b.hostLabel ?? b.hostId))
    || a.container.localeCompare(b.container));

  // Tighten the default only if the precise match exists.
  const hasExact = ranked.some((s) => tier(s) === 0);
  return ranked.map((stream) => {
    const t = tier(stream);
    return {
      stream,
      preselect: hasExact ? t === 0 : t === 1,
      why: t === 0 ? "same image · same name" : t === 1 ? "same image" : t === 2 ? "same name" : "",
    };
  });
}

/**
 * What to call each member of a combined pane, in its gutter and its chip.
 *
 * The host name is the obvious label and it's only right for the obvious case — one
 * service across several boxes. Combine two containers ON one host and every line is
 * tagged with the same word, which is worse than no label at all: the column looks
 * like it's telling you something and isn't.
 *
 * So the label is whatever actually separates these members, shortest first:
 *
 *   the same container on three hosts   → `web-01`, `web-02`, `web-03`
 *   three containers on one host        → `api`, `worker`, `cache`
 *   a mix of both                       → `web-01/api`, `web-01/worker`, `web-02/api`
 *
 * The mixed form is only reached when neither name is unique on its own, so the pane
 * never spends width on a qualifier that distinguishes nothing.
 *
 * @param {Array<{hostLabel?:string, hostId?:string, container?:string}>} members
 * @returns {string[]} one label per member, in the order given
 */
export function memberLabels(members) {
  const hosts = members.map((m) => String(m.hostLabel ?? m.hostId ?? ""));
  const names = members.map((m) => String(m.container ?? ""));
  const unique = (list) => new Set(list).size === list.length;
  if (unique(hosts)) return hosts;
  if (unique(names)) return names;
  return members.map((_, i) => `${hosts[i]}/${names[i]}`);
}

// ── what order the lines go in ──────────────────────────────────────────────
/**
 * A sort key from docker's RFC-3339 timestamp.
 *
 * Lexicographic on a fixed-width string, not a parsed number, for two reasons:
 * `Date.parse` throws the nanoseconds away, and milliseconds × 1e6 overflows the
 * 53-bit safe integer range — either way two lines 200ns apart would compare equal
 * and interleave arbitrarily. Padding the fraction to 9 digits makes plain string
 * order the correct time order, since the rest of the stamp is fixed width.
 *
 * @param {string|null|undefined} ts
 * @returns {string|null} null when there's no usable stamp
 */
export function tsKey(ts) {
  if (!ts) return null;
  const m = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z?$/.exec(String(ts).trim());
  if (!m) return null;
  return `${m[1]}.${(m[2] ?? "").slice(0, 9).padEnd(9, "0")}`;
}

// ── mapping the time scrubber ───────────────────────────────────────────────
/* The scrubber's span is the history the open panes can actually serve: position 0
 * is the oldest line any of them can reach, position `max` is now. These convert
 * between slider positions and unix seconds.
 *
 * Positions stay integers so the native range inputs step cleanly, which means the
 * conversion is lossy in one direction — a 6-day span over 1000 steps is ~8 minutes
 * per step. That's fine for a scrubber, but it's why the committed window uses the
 * position's time rather than re-deriving it later, and why `pos === 0` and
 * `pos === max` are treated as "oldest" and "live" instead of as timestamps. */

/** Slider position → unix seconds. */
export function posToTime(pos, span, max = 1000) {
  if (!span || !Number.isFinite(span.from) || !Number.isFinite(span.to)) return null;
  const width = Math.max(1, span.to - span.from);          // a zero-width span would divide by zero
  const p = Math.max(0, Math.min(max, Number(pos) || 0));
  return Math.round(span.from + (width * p) / max);
}

/**
 * Hold two handles within `maxWidth` of each other by moving the one that ISN'T being
 * dragged. Returns where the other handle belongs.
 *
 * Pushing rather than blocking is what keeps a width limit from becoming a reach
 * limit: the window travels at its maximum size instead of stopping dead, so putting
 * a bounded window far back stays one gesture. The pushed handle keeps the side it
 * was already on, or dragging through the limit would turn the window inside out.
 *
 * @param {number} at        where the dragged handle now is
 * @param {number} other     where the other handle is
 * @param {number} maxWidth  0 or less means no limit
 * @param {number} max       the far end of the track
 * @returns {number} the other handle's position — unchanged when it's already legal
 */
export function pushWithin(at, other, maxWidth, max = 1000) {
  if (!(maxWidth > 0) || Math.abs(at - other) <= maxWidth) return other;
  const to = other > at ? at + maxWidth : at - maxWidth;
  return Math.max(0, Math.min(max, to));
}

/**
 * Keep the start handle left of the end handle by STOPPING the one being dragged when it
 * reaches the other. Returns where the dragged handle is allowed to be.
 *
 * Two separate range inputs can each be dragged the length of the track, so nothing in the
 * platform stops them swapping over. Reading `min`/`max` of the pair — which is what the
 * rest of the scrubber does, and still does defensively — makes a crossed pair *mean* the
 * right window, but it doesn't make it look like one: drag the start handle past the end and
 * the two sprites trade places, so the handle under your pointer is suddenly the other end
 * of the window and pushing further right makes the selection grow instead of shrink. The
 * gesture inverts under the hand that's making it.
 *
 * Blocking is right here even though the width limit next door deliberately PUSHES instead
 * (see `pushWithin`): pushing exists so a capped window can still be moved anywhere, and a
 * push at the crossing point would mean shoving the far end of the window backwards through
 * history — a drag on the start handle silently rewriting the end. There is nowhere the user
 * is trying to get to that blocking denies them.
 *
 * `gap` keeps a step between them so the band never collapses to nothing, which would commit
 * `since === until` — a window containing no time at all.
 *
 * @param {number} at      where the dragged handle now is
 * @param {number} other   where the other handle is
 * @param {"a"|"b"} which  which handle is being dragged; "a" is the start
 * @param {number} gap     minimum steps to leave between them
 * @param {number} max     the far end of the track
 * @returns {number} the dragged handle's position — unchanged when it isn't crossing
 */
export function blockCross(at, other, which, gap = 1, max = 1000) {
  return which === "a"
    ? Math.max(0, Math.min(at, other - gap))
    : Math.min(max, Math.max(at, other + gap));
}

/** Unix seconds → slider position, clamped into the span so a time outside it lands
 *  on an edge rather than off the track. */
export function timeToPos(sec, span, max = 1000) {
  if (!span || !Number.isFinite(span.from) || !Number.isFinite(span.to)) return 0;
  const width = Math.max(1, span.to - span.from);
  const raw = ((Number(sec) - span.from) * max) / width;
  if (!Number.isFinite(raw)) return 0;
  return Math.max(0, Math.min(max, Math.round(raw)));
}

// ── how a timestamp reads ───────────────────────────────────────────────────
/**
 * Docker's UTC stamp as a clock time in the VIEWER's zone: `04:50:30.574Z` seen
 * from Los Angeles reads `21:50:30.574`.
 *
 * Slicing the raw string instead — which is the obvious thing, and what this used
 * to do — displays UTC while the range picker reads local, so on a box 7 hours off
 * UTC you'd ask for 21:45 and get lines stamped 04:45 and conclude the filter was
 * broken. Same instant, two zones, no way to tell from looking.
 *
 * Milliseconds, not nanoseconds: `Date` truncates the fraction to ms, so the extra
 * digits are kept only in the sort key (see `tsKey`) where they actually matter.
 *
 * @param {string|null|undefined} ts
 * @returns {string} `HH:MM:SS.mmm`, or "" when there's no usable stamp
 */
export function localTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** The viewer's timezone abbreviation (`PDT`, `JST`), for labelling times so a
 *  reader never has to guess which zone they're looking at. Falls back to the IANA
 *  name, then to nothing — a missing label is better than a wrong one. */
export function zoneLabel(date = new Date()) {
  try {
    const parts = new Intl.DateTimeFormat(undefined, { timeZoneName: "short" }).formatToParts(date);
    const name = parts.find((p) => p.type === "timeZoneName")?.value;
    if (name) return name;
  } catch { /* fall through */ }
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone ?? ""; } catch { return ""; }
}

/**
 * Compare two buffered lines: timestamp first, arrival order as the tiebreak.
 *
 * The tiebreak matters more than it looks. Docker stamps at nanosecond resolution
 * but plenty of log drivers land two lines on the identical stamp, and any two
 * hosts will collide eventually — without a tiebreak those lines would be ordered
 * by whatever the sort felt like, and a re-render could reorder them. Arrival keeps
 * them stable and puts them in the order we actually learned about them.
 */
export function compareLines(a, b) {
  if (a.key !== b.key) return a.key < b.key ? -1 : 1;
  return a.arrival - b.arrival;
}

/** Sort a batch of buffered lines in place and return it. */
export function orderBatch(batch) {
  return batch.sort(compareLines);
}

/* ── emitting a merge progressively ──────────────────────────────────────────
 *
 * The naive way to interleave two streams is to collect everything and sort at the
 * end. It is correct and it is unusable: a merged pane over a closed window shows
 * nothing at all until the slowest host has finished replaying its history.
 *
 * The standard fix is a WATERMARK. Each member's own stream is already in timestamp
 * order — docker replays a container's log forwards, and then follows it — so a
 * member that has delivered a line stamped K will never later deliver one older than
 * K. The lowest such K across the members still delivering is therefore a line below
 * which the merge is settled: every buffered line at or under it is already in its
 * final position and can be shown now, while anything above it might yet be
 * overtaken by a member that hasn't caught up.
 *
 * So lines flow out continuously, at the pace of the SLOWEST member rather than
 * after the slowest member — and the ordering guarantee is the same one the
 * collect-and-sort version gave. What it costs is that a member has to be heard from
 * before anything below it can be released, which is what `stalled` is for: see the
 * caller, which decides how long silence is allowed to hold the merge up.
 */

/** Sorts above every real key, so "everyone is done, release everything" needs no
 *  separate flag at the call site. Not a valid timestamp — `tsKey` can't produce it. */
export const KEY_MAX = "￿";

/**
 * The key at or below which a merge is settled.
 *
 * @param {Array<{done?:boolean, stalled?:boolean, lastKey?:string|null}>} members
 *   `done` — will deliver nothing further, so it can't overtake anything.
 *   `stalled` — silent long enough that the caller has chosen to stop waiting on it.
 *   `lastKey` — the newest key it has delivered, or null if it hasn't delivered yet.
 * @returns {string|null} the watermark, `KEY_MAX` when nothing is still delivering,
 *   or null when a member is still expected but has said nothing — in which case no
 *   line can be released, because its first line could belong before any of them.
 */
export function mergeWatermark(members) {
  let low = null;
  for (const m of members) {
    if (m.done || m.stalled) continue;
    if (!m.lastKey) return null;
    if (low === null || m.lastKey < low) low = m.lastKey;
  }
  return low === null ? KEY_MAX : low;
}

/**
 * Split a pending buffer into what the watermark makes safe to show and what has to
 * keep waiting. Sorts the whole buffer, so the held remainder stays ordered for the
 * next pass and a line is never compared twice against the same neighbour.
 *
 * Lines exactly AT the watermark go out: a member may still emit another line on
 * that same stamp, but `compareLines` breaks stamp ties by arrival, and a line that
 * arrives later is meant to sort later. Holding them back would stall a merge
 * between two members sitting on the same coarse timestamp.
 *
 * @returns {{ready: Array, held: Array}}
 */
export function splitAtWatermark(pending, watermark) {
  if (watermark === null) return { ready: [], held: pending };
  const ordered = orderBatch(pending);
  const cut = ordered.findIndex((x) => x.key > watermark);
  if (cut === -1) return { ready: ordered, held: [] };
  return { ready: ordered.slice(0, cut), held: ordered.slice(cut) };
}

/**
 * Estimate how far apart two or more hosts' clocks are, from the offsets between
 * their line timestamps and when those lines reached us.
 *
 * Only the *smallest* offset per host is meaningful: network and buffering can only
 * ever add delay, so the least-delayed line is the closest thing to a direct read
 * of the clock difference. The spread between hosts is what we report — an absolute
 * offset shared by everyone is our own clock being off, which doesn't affect the
 * interleaving at all.
 *
 * @param {Array<number|null>} offsets  per-host minimum (arrivalMs - lineMs)
 * @returns {number|null} spread in ms, or null when there's nothing to compare
 */
export function clockSpread(offsets) {
  const known = offsets.filter((x) => typeof x === "number" && Number.isFinite(x));
  if (known.length < 2) return null;
  return Math.max(...known) - Math.min(...known);
}
