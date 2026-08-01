// Creature icons: which file each icon slot draws. The files live in public/sprites/ —
// see the README in there.
//
// The whole point is that they are SWAPPABLE, so nothing here hardcodes a filename. The
// server lists what's actually on disk (`GET /api/sprites`) and this module picks from that
// list, which is what lets someone drop a file in and have it appear on reload without
// touching a line of code.
//
// EVERY SLOT DRAWS FROM THE WHOLE DIRECTORY. There are no reserved names and no matching on
// container name: a pane's icon and each of the two scrubber handles are a pick from
// everything on disk. Anything you drop in can turn up anywhere — you fill the folder, and
// the dashboard wears it.
//
// ROLLED, NOT STABLE. Every pick is a fresh Math.random(): a pane rolls when it opens, the
// handles roll when the page loads, and nothing is keyed on anything. Reload and the whole
// dashboard is wearing something else.
//
// This was the other way around, keyed on a hash of the container's name, and the reasoning
// is worth keeping written down because it's the cost of the current behaviour: an icon that
// holds still long enough looks like it's REPORTING something, and a reader spends a moment
// each time working out what. Rolling every time is the blunt cure — an icon that has visibly
// just changed for no reason is one you stop reading meaning into. What it costs is identity:
// the same container on two hosts draws two different creatures, closing and reopening a pane
// redraws it, and there's no longer any way to say "this one is always the database". Nothing
// in the app depends on that; the container's name is written beside the icon in every place
// one appears, so the icon was never the thing identifying anything.
//
// A pane rolls ONCE, when it's built — the src is set on an <img> and then left alone, so
// nothing flickers while you read. Don't call these on a render path.
//
// What the flat pool costs, stated plainly: you can't point a specific file at a specific
// container, and a slider handle can draw a creature while a pane draws what used to be a
// slider handle. That's the trade a flat pool makes, and it predates the rolling.

/** Filenames as reported by the server. Order is nothing to this module now that the picks
 *  are rolled rather than mapped — it's kept sorted only so logging the pool, or diffing two
 *  boxes' folders, reads the way a directory listing should. */
let pool = [];

/** Ask the server what's on disk. Safe to call more than once.
 *  @returns {Promise<number>} how many files are available */
export async function loadSprites() {
  try {
    const r = await fetch("/api/sprites", { cache: "no-store" });
    const d = await r.json();
    // The server filters to image extensions already, so whatever arrives is drawable —
    // which is why there's no extension list on this side any more.
    pool = (Array.isArray(d?.sprites) ? d.sprites : []).slice().sort();
  } catch {
    pool = [];   // no sprites is a supported state, not an error
  }
  return pool.length;
}

/** The URL for a pool index. The name goes in AS STORED — the server looks the path up
 *  verbatim, so a re-cased guess would 404 on a case-sensitive filesystem. */
function at(i) {
  return `/sprites/${encodeURIComponent(pool[i])}`;
}

/** A uniform index into the pool. */
function roll() {
  return Math.floor(Math.random() * pool.length);
}

/** One file at random, or null when the directory is empty. */
function pick() {
  if (pool.length === 0) return null;
  return at(roll());
}

/**
 * The icon for one pane, or null to fall back to the drawn pokéball.
 *
 * Rolled per call, so call it once per pane and keep what it gave you — see the note at the
 * top of this file. Takes nothing: the container's name used to select the file and no longer
 * has any bearing on it.
 */
export function spriteForPane() {
  return pick();
}

/**
 * The two scrubber handles: the window's start and end. Rolled once at boot.
 *
 * Drawn WITHOUT replacement, which the pane icons don't bother with: two handles on one rail
 * are the one pair in this app that has to be told apart at a glance, and two panes wearing
 * the same creature is merely a coincidence you'd notice. A small folder is where this earns
 * itself — at eight files a shared pair comes up one roll in eight, and the two handles of a
 * range slider being indistinguishable is the control failing at its job.
 */
export function sliderSprites() {
  if (pool.length === 0) return { a: null, b: null };
  const ia = roll();
  let ib = roll();
  if (ib === ia && pool.length > 1) ib = (ib + 1) % pool.length;
  return { a: at(ia), b: at(ib) };
}
