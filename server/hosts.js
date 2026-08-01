// The host list — the thing this app is organized around.
//
// A host is somewhere else running this same image. It answers the local agent
// API (`/api/local/*`) for its own box, and this process fans queries out to
// every entry in the list, so one page shows containers and logs from all of
// them side by side.
//
// The box we're running on is always in the list as the built-in `local` host,
// with a null url meaning "no HTTP hop, read our own daemon". That's what makes
// a single-host run work with nothing entered, and it keeps the rest of the code
// from needing a special case: everything iterates the same list.
//
// Reachability is the operator's problem by design — a LAN name or a public URL,
// no tunnel, no discovery, no agent registration handshake.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";

export const LOCAL_ID = "local";

/** The url the operator typed, normalized, or an Error explaining why not. */
function normalizeUrl(input, defaultPort = "8080") {
  let raw = String(input ?? "").trim();
  if (!raw) return new Error("url is required");
  // A bare `box.lan` or `box.lan:8080` is what people actually type; assume http
  // rather than rejecting it. An explicit scheme always wins.
  const bare = !/^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  if (bare) raw = `http://${raw}`;
  let u;
  try { u = new URL(raw); }
  catch { return new Error(`not a valid url: ${input}`); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return new Error(`url must be http or https, got ${u.protocol}`);
  }
  if (!u.hostname) return new Error("url has no host");
  // A bare host means "another one of these", so fill in the port this app
  // serves on. A *typed* url is taken literally — someone who writes
  // `http://box.lan` behind a proxy on :80 means :80, and guessing 8080 there
  // would break a deployment in a way that's hard to see from the error.
  if (bare && !u.port) u.port = defaultPort;
  // Keep origin + path prefix (someone may sit behind a reverse proxy at /logs),
  // drop query and fragment, and never keep a trailing slash.
  return `${u.origin}${u.pathname}`.replace(/\/+$/, "");
}

/** A stable, readable id from a url — `box.lan:8080` → `box-lan-8080`. */
function idFor(url, taken) {
  const base = url.replace(/^https?:\/\//, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").toLowerCase()
    || "host";
  if (base !== LOCAL_ID && !taken.has(base)) return base;
  for (let i = 2; ; i++) {
    const candidate = `${base}-${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * @param {object} cfg
 * @param {string|null} cfg.file      where the list is persisted (null = memory only)
 * @param {string} [cfg.localLabel]   what to call the box we're running on
 * @param {string[]} [cfg.seed]       urls to add at boot (HOSTS env var)
 * @param {number|string} [cfg.defaultPort]  port to assume for a bare hostname —
 *   our own, since the fleet is copies of this app rather than something else
 */
export function createHosts(cfg) {
  const localLabel = cfg.localLabel || "this host";
  const defaultPort = String(cfg.defaultPort ?? 8080);
  /** @type {Map<string, {id:string,label:string,url:string|null,addedAt:number}>} */
  const remotes = new Map();

  const local = { id: LOCAL_ID, label: localLabel, url: null, addedAt: 0 };

  /** Every host, local always first — the order the UI lays them out in. */
  function list() {
    return [local, ...[...remotes.values()].sort((a, b) => a.addedAt - b.addedAt)];
  }

  function get(id) {
    if (id === LOCAL_ID) return local;
    return remotes.get(String(id)) ?? null;
  }

  /* Writing the list out.
   *
   * Serialized and coalesced: two hosts added in quick succession would otherwise
   * mean two overlapping `writeFile`s on one path, and since that isn't atomic the
   * file can end up holding a mix of both. One writer at a time, and a change that
   * lands mid-write just re-runs the loop against the newest state — so N rapid
   * edits cost at most two writes and the last one always wins.
   *
   * Written via a temp file and renamed, because rename within a directory IS
   * atomic: a reader (or a crash) sees either the old complete list or the new one,
   * never a half-written file. This is the state the whole app is organized around,
   * so "truncated on an unlucky restart" is not an acceptable failure mode. */
  let writing = null;
  let dirty = false;

  function persist() {
    if (!cfg.file) return Promise.resolve();
    dirty = true;
    if (writing) return writing;      // in flight; it will pick up this change
    writing = (async () => {
      try {
        while (dirty) {
          dirty = false;              // snapshot AFTER clearing, so a late edit re-loops
          await writeOnce();
        }
      } finally {
        writing = null;
      }
    })();
    return writing;
  }

  async function writeOnce() {
    const tmp = `${cfg.file}.tmp`;
    try {
      await mkdir(dirname(cfg.file), { recursive: true });
      const body = JSON.stringify({ hosts: [...remotes.values()] }, null, 2);
      await writeFile(tmp, `${body}\n`, "utf8");
      await rename(tmp, cfg.file);
    } catch (err) {
      // Losing persistence shouldn't lose the running list — the operator can
      // re-add hosts, but a crashed server serves nothing at all.
      console.error(`[hosts] could not write ${cfg.file}: ${err.message}`);
    }
  }

  /** Add a host. Idempotent on url: re-adding one returns the existing entry
   *  rather than a duplicate row pointing at the same box.
   *
   *  Awaits the write, so a caller that replies "added" has already got it on disk
   *  — otherwise a restart in that gap would drop a host the operator was told was
   *  saved, which is exactly the thing this list is supposed to guarantee. */
  async function add({ url, label } = {}) {
    const normalized = normalizeUrl(url, defaultPort);
    if (normalized instanceof Error) return { error: normalized.message };
    for (const h of remotes.values()) {
      if (h.url === normalized) return { host: h, existing: true };
    }
    const host = {
      id: idFor(normalized, new Set(remotes.keys())),
      label: String(label ?? "").trim() || normalized.replace(/^https?:\/\//, ""),
      url: normalized,
      addedAt: Date.now(),
    };
    remotes.set(host.id, host);
    await persist();
    return { host, existing: false };
  }

  /** The url `add` would store for this input, or null if it isn't usable — so a
   *  caller can talk to a host before committing it to the list, using exactly the
   *  address the list will hold rather than a second interpretation of the input. */
  function probeUrl(url) {
    const normalized = normalizeUrl(url, defaultPort);
    return normalized instanceof Error ? null : normalized;
  }

  async function remove(id) {
    if (id === LOCAL_ID) return { error: "the local host can't be removed" };
    if (!remotes.delete(String(id))) return { error: "no such host" };
    await persist();
    return { ok: true };
  }

  /** Load the persisted list, then apply the HOSTS seed. Both are best effort:
   *  a corrupt state file or an unparseable env entry is logged, not fatal. */
  async function load() {
    if (cfg.file) {
      try {
        const parsed = JSON.parse(await readFile(cfg.file, "utf8"));
        for (const h of parsed?.hosts ?? []) {
          const normalized = normalizeUrl(h?.url, defaultPort);
          if (normalized instanceof Error) continue;
          const id = typeof h.id === "string" && h.id !== LOCAL_ID && !remotes.has(h.id)
            ? h.id
            : idFor(normalized, new Set(remotes.keys()));
          remotes.set(id, {
            id,
            label: String(h.label || normalized.replace(/^https?:\/\//, "")),
            url: normalized,
            addedAt: Number(h.addedAt) || Date.now(),
          });
        }
        console.log(`[hosts] loaded ${remotes.size} host(s) from ${cfg.file}`);
      } catch (err) {
        if (err.code !== "ENOENT") console.error(`[hosts] could not read ${cfg.file}: ${err.message}`);
      }
    }
    for (const url of cfg.seed ?? []) {
      const r = await add({ url });
      if (r.error) console.error(`[hosts] ignoring seed "${url}": ${r.error}`);
    }
    return list();
  }

  return { list, get, add, remove, load, probeUrl, LOCAL_ID };
}
