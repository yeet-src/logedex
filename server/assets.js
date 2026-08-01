// How a URL becomes a file on disk — and, more to the point, how it does not become a
// file somewhere else. Split out of index.js so it can be tested: that module is an entry
// point which binds a port the moment it is imported, so anything testable has to live
// beside it rather than inside it.
//
// Two patterns, kept separate on purpose. Browser assets are .js/.css with one path
// segment and no dots; sprites are images whose names come from CONTAINER names, which may
// legitimately contain dots. Merging them would mean relaxing the strict one to fit the
// loose one, so they stay apart and each says exactly what it allows.

import { extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const PUBLIC = join(__dirname, "public");

export const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
};

/* A flat asset name in public/ — `app.js`, `style.css`, `logedex-mark.png`.
 *
 * A pattern rather than a route per file, because the page is ES modules now and
 * adding one will keep happening. Deliberately strict: one path segment, a known
 * extension, and no dots beyond the extension — so there is no `..` to traverse
 * with and no way to reach outside public/, which is what a naive path join would
 * hand out. Test files are excluded; they ship in the repo, not to the browser.
 *
 * Images are in the list because the page's own artwork lives here — the wordmark in the top
 * bar. This is a WIDER EXTENSION LIST, not a looser pattern: every rule above still holds, and
 * an image is no more dangerous to hand out than the stylesheet next to it. It stays separate
 * from the sprite route below, which has to allow dots inside a name and therefore has to
 * refuse `..` by hand — that is the strictness worth not merging. */
export const ASSET_RE = /^\/([a-z0-9_-]+)\.(js|css|png|svg|webp)$/i;

/* Modules the browser shares with the isolate and the server, so they can't live
 * under public/. Mapped explicitly by name rather than by widening the path rules —
 * one entry per shared module is a smaller surface than a second servable root. */
export const SHARED = new Map([
  ["search.js", join(__dirname, "..", "shared", "search.js")],
  ["limits.js", join(__dirname, "..", "shared", "limits.js")],
  ["alertrule.js", join(__dirname, "..", "shared", "alertrule.js")],
]);

export function assetFrom(url) {
  const m = ASSET_RE.exec(url);
  if (!m) return null;
  if (m[1].endsWith(".test") || m[1].endsWith("_test")) return null;
  const file = `${m[1]}.${m[2]}`;
  const type = MIME[`.${m[2].toLowerCase()}`];
  const shared = SHARED.get(file);
  return shared ? { abs: shared, type } : { file, type };
}

/* public/sprites/ — the creature icons, which are meant to be replaced. Whoever runs this
 * drops their own files in (the directory is inside the editable source, so it's live) and
 * the dashboard picks them up on the next reload. See public/sprites/README.md.
 *
 * Its own route rather than widening ASSET_RE, because that pattern deliberately allows
 * exactly one path segment and only .js/.css, and it should stay that strict — this is a
 * second, equally strict pattern next to it rather than a loosening of the first.
 *
 * A container name is the useful filename here, so the charset has to allow what docker
 * allows: letters, digits, dot, underscore, hyphen. Which means a dot is legal INSIDE the
 * name, so `..` has to be excluded on purpose rather than by the charset — hence the
 * explicit check below. Everything else that makes traversal work is already impossible:
 * one segment only, no slashes in the charset, and a known extension. */
export const SPRITE_DIR = join(PUBLIC, "sprites");
/* A leading underscore is allowed and a leading dot is not. Nothing reserves an underscore
 * any more — every file in the directory is one flat pool now (see public/sprites/README.md)
 * — but the shipped placeholders are named `_1`, `_slider-a` and so on, and underscore is a
 * legal docker name character regardless, so refusing it would refuse ordinary files. A
 * dotfile is never something we mean to serve. */
/* Case-insensitive on the extension, because these files are dropped in by hand and a
 * download called `Sprite.PNG` should just work. */
export const SPRITE_RE = /^\/sprites\/([A-Za-z0-9_][A-Za-z0-9._-]*)\.(svg|png|webp|gif|jpe?g)$/i;
export const SPRITE_EXT = new Set([".svg", ".png", ".webp", ".gif", ".jpg", ".jpeg"]);

export function spriteFrom(url) {
  const m = SPRITE_RE.exec(url);
  if (!m) return null;
  const name = m[1];
  // `a..b` is a legal docker-ish name and harmless; `..` and a leading `.` are not worth
  // reasoning about, so they're refused outright.
  if (name.includes("..") || name.startsWith(".")) return null;
  /* The extension goes into the path EXACTLY as it was given, and is lowercased only to
   * pick a content type. Normalising it into the filename would look tidier and would 404
   * on any case-sensitive filesystem: a file genuinely named `Sprite.PNG` is not
   * `Sprite.png` on Linux, which is where this runs. */
  const abs = join(SPRITE_DIR, `${name}.${m[2]}`);
  // Belt and braces: whatever the pattern let through, the resolved path must still be
  // inside the sprite directory.
  if (!resolve(abs).startsWith(resolve(SPRITE_DIR) + sep)) return null;
  return { abs, type: MIME[`.${m[2].toLowerCase()}`] ?? "application/octet-stream" };
}
