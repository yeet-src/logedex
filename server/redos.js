// Is this regex safe to run on the event loop? Answered by running it somewhere killable.
//
// The problem this solves, and the wrong answer that comes first: you cannot time a regex on the
// thread you care about. There is no step limit, no interrupt, and no timeout in JS regex — once
// `test()` starts backtracking, that thread is gone until it finishes. So the obvious canary
// ("run the pattern, measure it, refuse it if it was slow") is itself the denial of service it
// was written to prevent. `(a+)+$` against forty `a`s and a `!` is 2^40 steps: the check that was
// supposed to protect the server hangs it instead, at rule-creation time, on purpose, by an
// operator who was trying to be careful.
//
// A worker thread CAN be terminated mid-regex — V8 can kill an isolate that is inside the regex
// engine, which is exactly the escape hatch the main thread doesn't have. So the pattern runs
// there, against the adversarial probes from shared/alertrule.js, and if the worker hasn't
// reported back inside the budget it is terminated and the pattern is refused.
//
// Cost: one worker per save, tens of milliseconds. Saving a rule is a thing an operator does by
// hand, occasionally — this is the cheapest place in the whole app to spend 30ms.
//
// WHAT IT DOESN'T PROVE. That the pattern is fast on every input, only that it is fast on inputs
// built to break the common backtracking shapes. Matching still happens on the event loop, with
// lines truncated to `MATCH_MAX`. See the note at the top of shared/alertrule.js for the residual
// risk and what fixing it properly would cost.

import { Worker } from "node:worker_threads";
import { CANARY_INPUTS } from "../shared/alertrule.js";

/* Per-probe budget. A healthy pattern finishes every probe in microseconds, and a pathological one
 * doesn't finish at all, so anything in between is noise — the number only has to sit above
 * "scheduling a worker on a loaded box" and below "an operator notices". */
const BUDGET_MS = 250;

/* The worker's whole program, as a string. Inline rather than a fourth file on disk because it is
 * six lines and it must stay welded to the checker that spawns it: a separate file could be
 * missing, stale, or excluded from a docker COPY, and the failure would be "no rule can ever be
 * saved". `eval: true` takes it as source.
 *
 * It reports the SLOWEST probe rather than a pass/fail, so a refusal can quote a real number back
 * to the operator. */
const PROGRAM = `
  const { parentPort, workerData } = require("node:worker_threads");
  /* Wrapped in a function purely so the early exits can be \`return\`. A worker's source is module
   * top level, where \`return\` is a syntax error — and the failure mode is instructive: every
   * pattern gets refused with "Illegal return statement", so the checker fails CLOSED and no rule
   * can be saved at all. Worth the four characters of indentation to not have that. */
  (() => {
    const { pattern, flags, probes } = workerData;
    let re;
    try { re = new RegExp(pattern, flags); }
    catch (err) { parentPort.postMessage({ error: "not a valid regex: " + err.message }); return; }
    let worst = 0, worstLen = 0;
    for (const probe of probes) {
      const t0 = Date.now();
      try { re.test(probe); }
      catch (err) { parentPort.postMessage({ error: "pattern failed to run: " + err.message }); return; }
      const took = Date.now() - t0;
      if (took >= worst) { worst = took; worstLen = probe.length; }
    }
    parentPort.postMessage({ ok: true, worst, worstLen });
  })();
`;

/**
 * Run the canary.
 *
 * @param {string} pattern
 * @param {string} [flags]
 * @param {number} [budgetMs]
 * @returns {Promise<{ok:true, worstMs:number} | {error:string}>}
 */
export function checkPattern(pattern, flags = "i", budgetMs = BUDGET_MS) {
  return new Promise((resolve) => {
    let worker;
    try {
      worker = new Worker(PROGRAM, {
        eval: true,
        workerData: { pattern: String(pattern ?? ""), flags: String(flags ?? ""), probes: CANARY_INPUTS },
        /* No stdio, no env, no resource limits beyond the default. It compiles one regex against
         * five short strings; it has no business reading anything. */
        stdout: true,
        stderr: true,
      });
    } catch (err) {
      /* A worker that won't start is not evidence about the pattern. Fail OPEN with a clear reason
       * rather than refusing every rule on a box where worker_threads is unavailable — the length
       * and flag limits still apply, and MATCH_MAX still bounds the input. */
      resolve({ ok: true, worstMs: -1, unchecked: `could not start the checker: ${err.message}` });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      /* Terminate unconditionally: on the timeout path the worker is wedged inside the regex, and
       * on the happy path it has already posted and is idle. Either way nothing is left behind. */
      worker.terminate().catch(() => {});
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        error: `pattern backtracks too heavily — it did not finish ${CANARY_INPUTS[0].length} `
          + `characters in ${budgetMs}ms, so a long log line would stall the server. `
          + "Anchor it, or avoid a quantifier inside a quantifier like (a+)+.",
      });
    }, budgetMs);
    /* Unref'd so a checker still running can never hold up a shutdown. */
    timer.unref?.();

    worker.on("message", (msg) => {
      if (msg?.error) return finish({ error: msg.error });
      finish({ ok: true, worstMs: msg?.worst ?? 0 });
    });
    worker.on("error", (err) => finish({ error: `pattern check failed: ${err.message}` }));
    worker.on("exit", () => finish({ error: "pattern check exited without an answer" }));
  });
}
