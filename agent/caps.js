// Which integrations this yeet account has connected.
//
//   yeet run agent/caps.js
//
// `yeet.caps()` resolves to the account's OAuth credentials:
//
//   { credentials: [ { oauth_id, provider, provider_account_id, scope, token_type } ] }
//
// An empty array means nothing has been connected. This flattens it to the list of provider
// names, which is all the dashboard needs — it asks one question, "can this box send a Slack
// alert", and the answer is whether `slack` is in there.
//
// WHY THIS EXISTS AS A SEPARATE SCRIPT. The alternative is finding out by trying: fire the
// alert and show the operator whatever came back. That produces the worst version of this —
// you write a rule, wait for it to match something at 3am, and discover then that Slack was
// never paired. Asking first means the UI can say so while the rule is still being written.
//
// Nothing here is cached; server/alerts.js owns the caching, because it's the thing that knows
// how stale an answer is allowed to be.
//
// Protocol, one JSON object per line:
//   {"t":"caps","providers":["slack","linear"]}
//   {"t":"error","error":…}

function say(obj) {
  console.log(JSON.stringify(obj));
  // Deferred so the line flushes before teardown — see the same note in logstream.js.
  setTimeout(() => yeet.exit(), 50);
}

yeet.caps().then(
  (caps) => {
    const list = Array.isArray(caps?.credentials) ? caps.credentials : [];
    /* Lowercased and de-duplicated: an account can hold two credentials for one provider (two
     * Slack workspaces), and the caller is asking whether the provider is available at all,
     * not how many times. */
    const providers = [...new Set(
      list.map((c) => String(c?.provider ?? "").trim().toLowerCase()).filter(Boolean),
    )].sort();
    say({ t: "caps", providers });
  },
  (err) => say({ t: "error", error: String(err?.message ?? err) }),
);
