// One-shot reads of this host's system graph, via the yeet CLI.
//
// A point-in-time query needs no isolate — `yeet graph query` asks the daemon
// directly and prints JSON. That's the whole of checkpoint one: the container
// list is host state, and the graph already models the Docker API. Only the
// *streaming* side (docker_logs is a GraphQL subscription) needs an isolate, and
// that lives in logs.js.

import { execYeet, socketArgs } from "./isolate.js";

const CONTAINERS = `{
  docker {
    list_containers(opts: { all: true }) {
      id
      names
      image
      state
      status
      created
    }
  }
}`;

/**
 * @param {object} cfg  {yeetBin, socket, userSocket}
 * @returns {{ containers: () => Promise<object[]> }}
 */
export function createGraph(cfg) {
  const globalArgs = socketArgs(cfg);

  /** Run a GraphQL query against the local daemon. Throws with the daemon's own
   *  message, which is what a UI should show — "docker unreachable" and "no such
   *  container" are both things the operator needs to read verbatim. */
  async function query(q) {
    const res = await execYeet(cfg.yeetBin, [...globalArgs, "graph", "query", q]);
    const text = `${res.stdout}`.trim();
    if (res.exitCode !== 0 || !text.startsWith("{")) {
      throw new Error((res.stderr || res.stdout || `yeet graph query exited ${res.exitCode}`).trim());
    }
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { throw new Error(`unparseable graph response: ${text.slice(0, 200)}`); }
    if (parsed.errors?.length) throw new Error(parsed.errors.map((e) => e.message).join("; "));
    return parsed.data;
  }

  return {
    query,

    /** Every container on this host, running or not, normalized for the UI.
     *  `list_containers` leaves `name` null and puts the real thing in `names`
     *  (slash-prefixed, plural for legacy links) — so the name the operator
     *  knows has to be derived here. It's also the handle `docker_logs` wants. */
    async containers() {
      const data = await query(CONTAINERS);
      const list = data?.docker?.list_containers ?? [];
      return list.map((c) => {
        const name = (c.names?.[0] ?? "").replace(/^\//, "") || (c.id ?? "").slice(0, 12);
        return {
          id: c.id ?? null,
          shortId: (c.id ?? "").slice(0, 12),
          name,
          image: c.image ?? null,
          state: (c.state ?? "UNKNOWN").toLowerCase(),
          status: c.status ?? null,
          created: c.created ?? null,
        };
      }).sort((a, b) => {
        // Running first, then newest — the containers someone wants logs from.
        const run = (x) => (x.state === "running" ? 0 : 1);
        return run(a) - run(b) || (b.created ?? 0) - (a.created ?? 0) || a.name.localeCompare(b.name);
      });
    },
  };
}
