# Logédex — one image, run on every host you want logs from.
#
# Single stage: there is nothing to compile. The agent is one plain JS file the
# yeet daemon runs, and the server has no npm dependencies — so there's no
# toolchain, no BPF object, and no bundler in the build.
#
# The container needs the host's Docker socket (that's where the container list
# and the log streams come from) and nothing else — no BPF caps, no host PID
# namespace, no kernel BTF. See the Makefile for the run flags.

FROM node:22-bookworm-slim

# `source` is what ties the published package to this repository on GHCR — without it a
# pushed image arrives as an orphan package with no link back to the code, and the README
# and provenance shown beside it come from nowhere.
LABEL org.opencontainers.image.source="https://github.com/yeet-src/logedex" \
      org.opencontainers.image.description="Logédex — container logs from many hosts, side by side, read through the yeet system graph"

# yeetd + the yeet CLI come from the official installer (apt repo), which pulls
# yeetd's runtime deps itself. curl + ca-certificates are for the installer;
# gnupg lets apt verify the yeet repo signature on slim.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates gnupg \
  && curl -fsSL https://yeet.cx | sh \
  && apt-get purge -y --auto-remove gnupg \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY agent ./agent
COPY server ./server
# shared/ is not optional and not obvious: the server imports the window cap from it,
# the isolate imports the search matcher, and the browser is served both straight out
# of it (see SHARED in server/index.js). Its whole point is that one query and one cap
# mean the same thing in all three runtimes, which also means all three break without
# it — the server won't even start.
COPY shared ./shared
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# /data holds the host list, so it survives the container being recreated. Mount
# something there (the Makefile does) or the list goes with the writable layer.
VOLUME /data

# /edit is where the app actually runs from: the entrypoint seeds it from /app on first
# start and serves out of it, so the source can be rewritten while the container runs.
# Mount a host directory here to edit it from your machine (see the README); unmounted it
# still works, reachable with `docker exec`. /app above stays the pristine copy we seed
# and reset from, which is what makes a bad edit recoverable.
#
# Deliberately NOT declared a VOLUME: a VOLUME would hand every `docker run` an anonymous
# volume it never asked for, and one that then outlives the container holding stale source.
RUN mkdir -p /edit

ENV PORT=8080 \
    HOSTS_FILE=/data/hosts.json \
    ALERTS_FILE=/data/alerts.json \
    EDIT_DIR=/edit \
    NODE_ENV=production

# The server runs under `node --watch`, which survives the app crashing on purpose — it
# waits for the fix. That means a broken edit (or any fatal startup error) leaves this
# container Up with nothing answering, and docker's restart policy never fires because
# nothing exited. This is what makes that state visible instead of silent.
#
# start-period covers the real boot: yeetd has to come up and its socket appear before
# the server even starts listening.
HEALTHCHECK --interval=30s --timeout=5s --start-period=45s --retries=3 \
  CMD curl -fsS "http://127.0.0.1:${PORT:-8080}/healthz" >/dev/null || exit 1
EXPOSE 8080

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
