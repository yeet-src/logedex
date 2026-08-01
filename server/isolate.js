// The bridge from a yeet isolate to this node process.
//
// An agent script (agent/*.js) runs in the daemon's V8 isolate and prints JSON
// lines to its console; this module runs one as a child process and hands each
// parsed line to a callback:
//
//   yeet run --no-tty <script> -- <flags>
//
// So "printing to the console" IS the wire, and the isolate's stdout is the RPC
// transport. yeet can also mirror a *detached* isolate's console onto a
// WebSocket (`--detach -p console:ws://…`), which keeps it alive across a restart
// of this process — the right trade for a long-lived host-wide probe, and the
// wrong one here. A log stream belongs to whoever is watching it: when the last
// viewer detaches we want the subscription gone, and if this process dies we want
// no orphaned isolates left holding docker log streams open. Child-process stdout
// gives exactly that lifetime, needs no port, and works on daemons predating the
// portal flag (it landed in yeet v0.20).
//
// Zero npm deps: node's child_process is all of it.

import { spawn } from "node:child_process";

/** Run `yeet <args>` to completion, capturing stdout+stderr. */
export function execYeet(bin, args) {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } });
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => resolve({ exitCode: -1, stdout, stderr: stderr + String(err) }));
    child.on("close", (code) => resolve({ exitCode: code ?? -1, stdout, stderr }));
  });
}

/** The `--socket`/`--user-socket` pair that every yeet invocation shares. */
export function socketArgs({ socket, userSocket }) {
  const a = [];
  if (socket) a.push("--socket", socket);
  if (userSocket) a.push("--user-socket", userSocket);
  return a;
}

/**
 * Start an agent isolate and stream the JSON lines it prints.
 *
 * @param {object} opts
 * @param {string} opts.yeetBin       path to the `yeet` binary
 * @param {string} opts.script        the agent script to run (path or project dir)
 * @param {string} [opts.name]        isolate name, as shown by `yeet ps`
 * @param {string} [opts.socket]      privileged daemon socket
 * @param {string} [opts.userSocket]  user daemon socket
 * @param {string[]} [opts.scriptArgs]  flags passed after `--`
 * @param {(obj:object)=>void} opts.onLine    each parsed JSON line
 * @param {(line:string)=>void} [opts.onLog]  non-JSON output (isolate logs, errors)
 * @param {(info:{code:number|null})=>void} [opts.onClose]  the isolate exited
 * @returns {{stop:()=>Promise<void>}}
 */
export function startIsolate(opts) {
  const {
    yeetBin, script, name, socket, userSocket, scriptArgs = [],
    onLine, onLog = () => {}, onClose = () => {},
  } = opts;

  const args = [...socketArgs({ socket, userSocket }), "run", "--no-tty", "--quiet"];
  if (name) args.push("--name", name);
  args.push(script);
  if (scriptArgs.length) args.push("--", ...scriptArgs);

  // NO_COLOR keeps the daemon's own banners from arriving wrapped in escape
  // codes, which would otherwise break the `line[0] !== "{"` test below.
  const child = spawn(yeetBin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, NO_COLOR: "1" },
  });

  let stopped = false;
  let buf = "";

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "").trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      // Non-JSON output is the isolate's own logs, the daemon's banners, or a
      // crash dump. Surface it rather than swallowing it — this is exactly the
      // output that explains why a stream died.
      if (line[0] !== "{") { onLog(line); continue; }
      let msg;
      try { msg = JSON.parse(line); } catch { onLog(line); continue; }
      onLine(msg);
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    for (const line of chunk.split("\n")) if (line.trim()) onLog(line.trim());
  });

  child.on("error", (err) => {
    onLog(`could not run ${yeetBin}: ${err.message}`);
    if (!stopped) onClose({ code: null });
  });

  child.on("close", (code) => {
    if (!stopped) onClose({ code });
  });

  return {
    async stop() {
      stopped = true;
      // SIGTERM lets the isolate unwind its subscription; the SIGKILL after a
      // grace period is for the case where it doesn't.
      try { child.kill("SIGTERM"); } catch { /* already gone */ }
      const dead = new Promise((r) => child.once("close", r));
      const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* ignore */ } }, 2000);
      await dead;
      clearTimeout(timer);
    },
  };
}
