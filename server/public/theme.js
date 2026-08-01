// Which skin the app wears.
//
//   yeet     the default, and the DARK one — greyscale and one amber accent, matching
//            yeet.cx
//   pokemon  the LIGHT one — a pale page with a crimson band across the top, after the
//            name Logédex
//
// Both are the SAME interface: a theme moves values, never rules, so the ramp still means
// what it means and the accent still marks the same things. Inverting the field is not
// free, though — the ANSI palette and the stream hues both had to be re-derived for a
// light background, because the dark set is illegible on one. The note above
// `:root[data-theme="pokemon"]` in style.css has the numbers and the reasoning; they are
// load-bearing, so read it before changing a colour there.
//
// The theme lives on <html> as `data-theme`, so CSS is the only thing that reads it, and
// it is applied by a small inline script in index.html rather than here — this module
// runs after first paint, so choosing the theme here would show everyone the other one
// first. What's left for this file is the button.

const KEY = "logedex.theme";
const THEMES = ["yeet", "pokemon"];

/* What the button should SAY. It names the theme you'll get by pressing it, not the one
 * you're in — a button labelled with the current state reads as a status display, and
 * people press it expecting to be told more rather than to be switched. */
const NEXT_LABEL = { yeet: "pokédex mode", pokemon: "yeet mode" };

/* The tab icon, per theme, as an inline SVG data URI.
 *
 * Drawn here rather than served, because there is no icon file in this project and adding
 * one would mean a route, a MIME type and a 404 whenever it's missing — for something that
 * is fifteen elements of markup. The pokéball is the same geometry as the pane headers'.
 *
 * A tab is the one place the skin is visible when the app isn't in front of you, and it's
 * most of what makes pokédex mode read as a different program rather than a recoloured one.
 */
const ICON = {
  yeet: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
    <rect width="16" height="16" fill="#0a0a0a"/>
    <g stroke="#ffdf20" stroke-width="1.6" stroke-linecap="round">
      <path d="M3.5 5h9"/><path d="M3.5 8h9"/><path d="M3.5 11h9"/>
    </g></svg>`,
  pokemon: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16">
    <path d="M1 8A7 7 0 0 1 15 8Z" fill="#e11c15"/>
    <path d="M1 8A7 7 0 0 0 15 8Z" fill="#fefdfc"/>
    <circle cx="8" cy="8" r="7" fill="none" stroke="#322621" stroke-width="1.5"/>
    <path d="M1 8h14" stroke="#322621" stroke-width="1.7"/>
    <circle cx="8" cy="8" r="2.7" fill="#fefdfc" stroke="#322621" stroke-width="1.5"/>
  </svg>`,
};

/** Point the tab icon at the current theme's mark. */
function paintFavicon(theme) {
  const link = document.querySelector("#favicon");
  if (!link) return;
  // encodeURIComponent, not a raw string: `#` in the fills would otherwise terminate the
  // URI as a fragment and the icon would silently fail to load.
  link.href = `data:image/svg+xml,${encodeURIComponent(ICON[theme] ?? ICON.yeet)}`;
}

/** The theme in effect. Reads the DOM rather than storage, because the inline script in
 *  index.html is what decided it and storage may be unreadable. */
export function currentTheme() {
  const t = document.documentElement.dataset.theme;
  return THEMES.includes(t) ? t : "yeet";
}

/** Switch to `name`, remember it, and return what's now in effect. */
export function applyTheme(name) {
  const theme = THEMES.includes(name) ? name : "yeet";
  // "yeet" is the absence of the attribute, not a value of it: the default palette lives
  // in plain `:root`, so a `data-theme="yeet"` would be a selector with nothing behind it.
  if (theme === "yeet") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  paintFavicon(theme);
  try { localStorage.setItem(KEY, theme); } catch { /* unreadable storage; theme is still applied */ }
  return theme;
}

/** Wire the header button. No-ops if the button isn't in the page.
 *
 *  @param {object} [opts]
 *  @param {(theme: string) => void} [opts.onChange]  called when the READER switches
 *    theme, not when another tab does and not on boot — so a caller counting the choice
 *    counts choices. This module stays unaware of what the callback is for; passing one in
 *    is what keeps the theme's own dependencies at zero. */
export function setupTheme({ onChange } = {}) {
  const btn = document.querySelector("#theme-btn");
  if (!btn) return;

  const label = () => { btn.textContent = NEXT_LABEL[currentTheme()]; };
  label();
  // The inline script in index.html set the theme before first paint but can't reach this
  // table, so the icon is painted once on boot to catch up with it.
  paintFavicon(currentTheme());

  btn.addEventListener("click", () => {
    const i = THEMES.indexOf(currentTheme());
    const theme = applyTheme(THEMES[(i + 1) % THEMES.length]);
    label();
    onChange?.(theme);
  });

  /* Another tab switched theme. Worth following: the host list and the panes are the same
   * dashboard in both tabs, and having them disagree about what colour "live" is defeats
   * the point of the accent meaning one thing. */
  window.addEventListener("storage", (e) => {
    if (e.key !== KEY || !e.newValue) return;
    applyTheme(e.newValue);
    label();
  });
}
