// Turning a container's ANSI escape codes into something the browser can render.
//
// Plenty of things colour their output whether or not anyone is watching — pip, npm,
// cargo, pytest, anything using rich or chalk — and docker passes those bytes through
// untouched. Left alone they arrive here as literal text: a line that meant to say a
// green `INFO` says `←[32mINFO←[0m` instead, which is worse than no colour at all
// because it also wrecks the alignment of everything after it.
//
// So the escapes are parsed out. What comes back is the text a human was meant to see
// plus a list of styled runs over it — deliberately NOT markup, because the caller has
// to interleave these runs with search highlighting, and two things independently
// slicing the same string is how you get crossing tags.
//
// WHY THE LOG GETS COLOUR WHEN THE INTERFACE DOESN'T. The chrome is one accent on a
// grey ramp on purpose (see style.css), and this looks like an exception to that. It
// isn't: the rule is about the interface, and these bytes are the *content* the
// interface exists to show. A service that took the trouble to mark its errors red is
// telling you something, and repainting it grey to match the furniture would be
// throwing away data to protect a look.
//
// Scope: SGR (`ESC[…m`) is interpreted. Other CSI sequences — cursor moves, erase
// line, the machinery of progress bars — are recognised and dropped, since a log pane
// has no cursor to move and rendering them as text is the exact failure this avoids.

/* An escape sequence, in the three forms that turn up in real log output:
 *
 *   ESC [ … final    a CSI, the ordinary form — `ESC[33m`
 *   ESC x            a two-character escape
 *   0x9B … final     an 8-BIT CSI: one byte that means exactly what `ESC[` means
 *
 * The third one is easy to not know about and its failure is memorable, because it does not look
 * like a missing feature — it looks like the stripping half-worked. Delete the single byte and you
 * are left with `33mWARN` in the middle of a line, which reads as a bug in the log rather than an
 * escape form nobody handled. It reached a Slack alert that way once, which is why it's here.
 *
 * Rare but real: it comes from C1-emitting terminals and from anything that writes raw bytes
 * without ESC-prefixing them. Handled identically to the two-byte form — same parameters, same
 * final byte, so one alternation is the whole fix. */
const ESCAPE = /(?:\x1b\[|\x9b)([0-9;:?]*)([@-~])|\x1b[@-Z\\-_]/g;

/** The 16 basic colours, as class suffixes. Named rather than numbered so the
 *  stylesheet reads as colours and not as an index into something. */
const BASIC = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];

/** xterm's 256-colour cube → a hex string. The first 16 are the basic set (left to
 *  the stylesheet), 16–231 are a 6×6×6 cube, and 232–255 are a grey ramp. */
function xterm256(n) {
  if (n < 16) return null;                       // handled as a basic colour
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return `rgb(${v} ${v} ${v})`;
  }
  const i = n - 16;
  const step = (x) => (x === 0 ? 0 : 55 + x * 40);
  return `rgb(${step(Math.floor(i / 36) % 6)} ${step(Math.floor(i / 6) % 6)} ${step(i % 6)})`;
}

/** A fresh, unstyled state. */
const blank = () => ({ fg: null, bg: null, fgHex: null, bgHex: null, bold: false, dim: false, italic: false, underline: false });

const isStyled = (st) => st.fg || st.bg || st.fgHex || st.bgHex || st.bold || st.dim || st.italic || st.underline;

/** Fold one SGR parameter list into the running state. */
function applySgr(st, params) {
  // A bare `ESC[m` is `ESC[0m` — a reset.
  const codes = params === "" ? [0] : params.split(";").map((p) => Number(p.split(":")[0]) || 0);
  for (let i = 0; i < codes.length; i++) {
    const c = codes[i];
    if (c === 0) Object.assign(st, blank());
    else if (c === 1) st.bold = true;
    else if (c === 2) st.dim = true;
    else if (c === 3) st.italic = true;
    else if (c === 4) st.underline = true;
    else if (c === 22) { st.bold = false; st.dim = false; }
    else if (c === 23) st.italic = false;
    else if (c === 24) st.underline = false;
    else if (c >= 30 && c <= 37) { st.fg = BASIC[c - 30]; st.fgHex = null; }
    else if (c >= 90 && c <= 97) { st.fg = `b${BASIC[c - 90]}`; st.fgHex = null; }
    else if (c === 39) { st.fg = null; st.fgHex = null; }
    else if (c >= 40 && c <= 47) { st.bg = BASIC[c - 40]; st.bgHex = null; }
    else if (c >= 100 && c <= 107) { st.bg = `b${BASIC[c - 100]}`; st.bgHex = null; }
    else if (c === 49) { st.bg = null; st.bgHex = null; }
    else if (c === 38 || c === 48) {
      /* Extended colour, and the one place the parameter list stops being a flat set
       * of codes: `38;5;N` is one 256-colour index and `38;2;R;G;B` is a triple, so
       * those arguments have to be consumed here or they'd be read as codes of their
       * own — `38;2;0;0;255` would otherwise turn into "reset, reset, blue". */
      const target = c === 38 ? "fg" : "bg";
      const mode = codes[i + 1];
      if (mode === 5) {
        const n = codes[i + 2];
        i += 2;
        if (n < 16) { st[target] = n < 8 ? BASIC[n] : `b${BASIC[n - 8]}`; st[`${target}Hex`] = null; }
        else { st[target] = null; st[`${target}Hex`] = xterm256(n); }
      } else if (mode === 2) {
        const [r, g, b] = [codes[i + 2] | 0, codes[i + 3] | 0, codes[i + 4] | 0];
        i += 4;
        st[target] = null;
        st[`${target}Hex`] = `rgb(${r} ${g} ${b})`;
      }
    }
    // Anything else — blink, conceal, framed, fonts — is ignored rather than guessed
    // at. A log pane that starts blinking is not an improvement.
  }
}

/**
 * Split a raw log line into its visible text and the styled runs over it.
 *
 * @param {string} raw
 * @returns {{text: string, runs: Array<{start:number, end:number, cls:string[], style:object}>}}
 *   `text` is what a terminal would have shown. Run offsets index into THAT string,
 *   not the raw one, so a caller can match and highlight against `text` without
 *   knowing escapes were ever involved. `runs` is empty for the overwhelmingly common
 *   case of a line with no escapes in it at all.
 */
export function parseAnsi(raw) {
  const src = String(raw ?? "");
  /* The fast path matters: almost every line has no escapes, and this runs per line per render.
   * `indexOf` on a 200-char string beats building a parser state for it.
   *
   * BOTH introducers have to be checked here, and forgetting the second one is invisible: an 8-bit
   * CSI line has no ESC in it at all, so a fast path that only looks for ESC returns the line
   * untouched no matter what the parser below is capable of. That is how `33mWARN` survived into a
   * Slack alert after the regex already knew about `\x9b`. */
  if (src.indexOf("\x1b") === -1 && src.indexOf("\x9b") === -1) return { text: src, runs: [] };

  const st = blank();
  const runs = [];
  let text = "";
  let at = 0;            // where we are in `src`
  let runStart = 0;      // where the current run began, in `text`

  const closeRun = () => {
    if (text.length > runStart && isStyled(st)) {
      const cls = [];
      if (st.fg) cls.push(`a-${st.fg}`);
      if (st.bg) cls.push(`a-bg-${st.bg}`);
      if (st.bold) cls.push("a-bold");
      if (st.dim) cls.push("a-dim");
      if (st.italic) cls.push("a-italic");
      if (st.underline) cls.push("a-underline");
      const style = {};
      if (st.fgHex) style.color = st.fgHex;
      if (st.bgHex) style.background = st.bgHex;
      runs.push({ start: runStart, end: text.length, cls, style });
    }
    runStart = text.length;
  };

  ESCAPE.lastIndex = 0;
  for (let m; (m = ESCAPE.exec(src)) !== null;) {
    text += src.slice(at, m.index);
    at = m.index + m[0].length;
    // `m[2]` is the CSI's final byte; only `m` is styling. Everything else — cursor
    // motion, erase-line, and the two-character escapes that fall through with no
    // capture group at all — is dropped, having consumed its own characters.
    if (m[2] === "m") {
      closeRun();
      applySgr(st, m[1] ?? "");
    }
  }
  text += src.slice(at);
  closeRun();

  return { text, runs };
}
