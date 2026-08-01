// The other half of the fan-out: reaching a host in the list over HTTP.
//
// Every host runs this same image, so "query a remote host" is just calling its
// local agent API — `GET /api/local/containers` for the list, and its SSE stream
// for logs. There's no separate agent protocol to keep in sync: the endpoints the
// hub calls on a remote box are the same ones it answers for itself.
//
// This is the one place that talks to a box we don't control the uptime of, so
// everything here is written to fail politely — a timeout on the list, a
// reported-not-thrown error on the stream. One unreachable host must never be
// able to stall or blank the page for the others.

const LIST_TIMEOUT_MS = 8000;

/* Stream states that mean "no more lines are coming, and we know why". */
const TERMINAL = new Set(["complete", "ended", "error"]);

/** `GET <host.url>/api/local/containers`. Throws with a short, showable reason. */
export async function remoteContainers(host, { timeoutMs = LIST_TIMEOUT_MS } = {}) {
  const signal = AbortSignal.timeout(timeoutMs);
  let res;
  try {
    res = await fetch(`${host.url}/api/local/containers`, { signal, headers: { accept: "application/json" } });
  } catch (err) {
    // A DNS failure, a refused connection and a timeout all land here, and the
    // operator needs to tell them apart to fix the entry they typed.
    throw new Error(err.name === "TimeoutError" ? `no response in ${timeoutMs}ms` : shortCause(err));
  }
  if (!res.ok) throw new Error(`host answered ${res.status} ${res.statusText}`);
  let body;
  try { body = await res.json(); }
  catch { throw new Error("host did not answer with JSON — is that URL really Logédex?"); }
  if (!body?.ok) throw new Error(String(body?.error ?? "host reported an error"));
  return body.containers ?? [];
}

/**
 * Ask a host what it calls itself, for labelling a row the operator added by URL.
 *
 * Best effort by design and on a short leash: this runs while someone waits for an
 * "added" reply, and a host that's slow or down must cost them a URL-derived label,
 * not a failed add. `null` means "couldn't tell" — never an error.
 */
export async function remoteLabel(host, { timeoutMs = 2500 } = {}) {
  try {
    const res = await fetch(`${host.url}/api/local/containers`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!res.ok) return null;
    const body = await res.json();
    const label = String(body?.label ?? "").trim();
    return label || null;
  } catch {
    return null;
  }
}

/** `GET <host.url>/api/local/oldest` — where that host's log history for this
 *  container begins, as an RFC-3339 stamp, or null if it has none / didn't answer. */
export async function remoteOldest(host, container, { timeoutMs = 10_000 } = {}) {
  const url = `${host.url}/api/local/oldest?container=${encodeURIComponent(container)}`;
  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { accept: "application/json" },
  }).catch((err) => { throw new Error(shortCause(err)); });
  if (!res.ok) throw new Error(`host answered ${res.status}`);
  const body = await res.json().catch(() => null);
  return body?.ts ?? null;
}

/**
 * Subscribe to a remote host's log stream, re-emitting its SSE events locally.
 *
 * The hub is a relay here, not a parser of log content: whatever event objects
 * the remote sent, the browser gets. Returns a detach function.
 *
 * @param {object} host
 * @param {string} container
 * @param {{since?:number, until?:number, find?:string}} win  window + query, forwarded as-is
 * @param {(evt:object)=>void} onEvent
 */
export function remoteLogs(host, container, win, onEvent) {
  const ctrl = new AbortController();
  let closed = false;
  let settled = false;

  (async () => {
    // The window and the search travel as query params, so the remote applies both
    // in its own subscription — we never filter here. Filtering at the relay would
    // mean shipping a whole log across the network to throw most of it away, which
    // is the entire cost this design avoids.
    const q = new URLSearchParams({ container });
    if (win?.since) q.set("since", String(win.since));
    if (win?.until) q.set("until", String(win.until));
    if (win?.find) q.set("find", String(win.find));
    const url = `${host.url}/api/local/logs?${q}`;
    let res;
    try {
      res = await fetch(url, { signal: ctrl.signal, headers: { accept: "text/event-stream" } });
    } catch (err) {
      if (!closed) onEvent({ t: "status", state: "error", container, error: shortCause(err) });
      return;
    }
    if (!res.ok || !res.body) {
      if (!closed) onEvent({ t: "status", state: "error", container, error: `host answered ${res.status}` });
      return;
    }

    // Minimal SSE reader: we only ever emit `data:` lines with a JSON payload
    // (plus `:` heartbeats), so there's no need for a general parser here.
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let nl;
        while ((nl = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, nl).replace(/\r$/, "");
          buf = buf.slice(nl + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          let evt;
          try { evt = JSON.parse(payload); } catch { continue; /* not ours */ }
          // Remember a terminal verdict the remote already gave us, so the
          // connection closing afterwards doesn't overwrite "complete" (a window
          // fully delivered) with the vaguer "ended".
          if (evt.t === "status" && TERMINAL.has(evt.state)) settled = true;
          onEvent(evt);
        }
      }
      if (!closed && !settled) onEvent({ t: "status", state: "ended", container, error: null });
    } catch (err) {
      if (!closed && err.name !== "AbortError") {
        onEvent({ t: "status", state: "error", container, error: shortCause(err) });
      }
    }
  })();

  return function detach() {
    closed = true;
    try { ctrl.abort(); } catch { /* ignore */ }
  };
}

/** fetch wraps the real problem in a generic "fetch failed" — dig out the cause,
 *  because `ECONNREFUSED` vs `ENOTFOUND` is the difference between "wrong port"
 *  and "wrong name". */
function shortCause(err) {
  const cause = err?.cause;
  if (cause?.code) return `${cause.code}${cause.port ? ` (port ${cause.port})` : ""}`;
  return String(cause?.message ?? err?.message ?? err);
}
