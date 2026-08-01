import test from "node:test";
import assert from "node:assert/strict";
import { assetFrom, spriteFrom } from "./assets.js";

/* The sprite route takes a filename from the URL and turns it into a path on disk, which
 * is the shape of every directory-traversal bug ever written. It also has to allow a DOT
 * inside the name: these are hand-dropped files with whatever names their author gave them,
 * and `a.b.c.svg` is an ordinary thing to find in a folder — so the usual "reject anything
 * with a dot" shortcut isn't available and `..` has to be excluded deliberately. That
 * combination is worth pinning down. */

const ALLOWED = [
  "/sprites/_1.svg",             // the shipped placeholders start with an underscore
  "/sprites/_slider-a.svg",
  "/sprites/_default.png",
  "/sprites/web-01.png",
  "/sprites/a.b.c.svg",          // dots inside a name are legal
  "/sprites/My_App.webp",
  "/sprites/x.jpeg",
  "/sprites/x.JPG",              // extension case is normalised
];

const REFUSED = [
  "/sprites/../../../etc/passwd",
  "/sprites/../index.js",
  "/sprites/....//index.js",
  "/sprites/x/../../y.svg",
  "/sprites/sub/dir.svg",        // one path segment only
  "/sprites/.hidden.svg",        // no dotfiles
  "/sprites/.svg",
  "/sprites/index.js",           // this route serves images, not code
  "/sprites/app.css",
  "/sprites/_1.svg/../app.js",
  "/sprites/",
  "/sprites/x.svg?../y",         // the caller passes a path, never a query
  "/style.css",                  // not this route's business at all
];

test("serves a sprite the directory could plausibly hold", () => {
  for (const url of ALLOWED) {
    const r = spriteFrom(url);
    assert.ok(r, `should serve ${url}`);
    assert.match(r.type, /^image\//, `${url} should be typed as an image`);
  }
});

test("never escapes the sprite directory", () => {
  for (const url of REFUSED) {
    assert.equal(spriteFrom(url), null, `should refuse ${url}`);
  }
});

/* The flat public/ route. Untested until the wordmark went in, and now worth pinning: it
 * serves images as well as code, which is one more extension to get wrong. */
test("serves the page's own assets, code and artwork alike", () => {
  for (const [url, type] of [
    ["/app.js", /javascript/],
    ["/style.css", /css/],
    ["/logedex-mark.png", /^image\/png$/],
    ["/logedex.png", /^image\/png$/],
    ["/icon.svg", /svg/],
    ["/x.webp", /webp/],
    ["/STYLE.CSS", /css/],           // extension case is normalised, as on the sprite route
  ]) {
    const r = assetFrom(url);
    assert.ok(r, `should serve ${url}`);
    assert.match(r.type, type, `${url} got type ${r?.type}`);
  }
});

test("the flat route stays one segment of known types", () => {
  for (const url of [
    "/../index.js",
    "/sub/app.js",                   // one path segment only
    "/app.test.js",                  // tests ship in the repo, not to the browser
    "/order_test.js",
    "/a.b.js",                       // no dots beyond the extension, unlike sprites
    "/hosts.json",                   // the host list is not an asset
    "/server.log",
    "/app.js?../y",
    "/",
  ]) {
    assert.equal(assetFrom(url), null, `should refuse ${url}`);
  }
});

/* The two shared modules the browser and the isolate both import. They live outside public/,
 * so they're mapped by name — the one case where this route hands back an absolute path. */
test("shared modules resolve outside public/ by name only", () => {
  const r = assetFrom("/limits.js");
  assert.ok(r.abs?.includes("shared"), `limits.js should map into shared/, got ${r.abs}`);
  assert.equal(assetFrom("/app.js").abs, undefined, "an ordinary asset stays a public/ name");
});

test("every served path really is inside the sprite directory", () => {
  // The belt to the pattern's braces: whatever the regex admits, the resolved path is
  // checked. This asserts the property directly rather than trusting the regex.
  for (const url of ALLOWED) {
    const { abs } = spriteFrom(url);
    assert.ok(abs.includes(`${"public"}${"/"}sprites${"/"}`), `${url} resolved outside: ${abs}`);
    assert.ok(!abs.includes(".."), `${url} resolved with a traversal: ${abs}`);
  }
});
