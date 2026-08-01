#!/usr/bin/env bash
# Start the in-container yeet daemon, wait for its socket, then start the node
# server. When either child exits (or we get a signal), tear both down.
#
# Much smaller than it would be for a BPF probe: nothing here mounts a bpffs or
# needs privileged capabilities. The daemon's job is to answer graph queries
# about docker, so the only thing it needs is the Docker socket bind-mounted in.

set -euo pipefail

server_pid=""
yeetd_pid=""

# One string standing for the contents of a source tree, so two of them can be compared.
# Content, not timestamps: a rebuild rewrites every mtime while usually changing nothing,
# and a fingerprint that changes on every build would cry wolf until it's ignored.
tree_fingerprint() {
  ( cd "$1" 2>/dev/null && find . -type f | LC_ALL=C sort | xargs md5sum 2>/dev/null | md5sum | cut -d" " -f1 ) || echo ""
}

# Hand a bind-mounted directory back to the human who mounted it.
#
# The server runs as root (yeetd needs to), so everything it writes into a mount lands
# root-owned — and then the files you mounted in to read or edit are files you can't
# touch. This undoes that.
#
# WHO to hand it to is worked out rather than required, because getting it wrong fails
# silently and the failure looks like something else entirely (a read-only editor, a
# permission error from a tool three layers up). In order:
#
#   1. STATE_UID/GID if passed — `make` knows exactly who invoked it.
#   2. Otherwise whoever owns the directory already. A bind mount arrives owned by the
#      user who created it on the host, which is the answer we want and is sitting
#      right there. This is what lets a plain `docker run` work with no id flags.
#
# Owner 0 means nobody to hand back to: either a docker named volume (correct, and
# nothing is wrong) or a directory docker created itself because it didn't exist, which
# for an editable mount is a problem worth naming — hence `warn_if_root`.
#   3. Or an owner captured earlier and passed in, for a directory whose ownership we
#      are about to overwrite ourselves — see the seeding step.
hand_back() {
  local dir="$1" warn_if_root="${2:-}" was_uid="${3:-}" was_gid="${4:-}" uid gid
  [ -d "$dir" ] || return 0
  if [ -n "${STATE_UID:-}" ]; then
    uid="$STATE_UID"; gid="${STATE_GID:-$STATE_UID}"
  elif [ -n "$was_uid" ] && [ "$was_uid" != "0" ]; then
    uid="$was_uid"; gid="${was_gid:-$was_uid}"
  else
    uid="$(stat -c %u "$dir" 2>/dev/null || echo 0)"
    gid="$(stat -c %g "$dir" 2>/dev/null || echo 0)"
  fi
  if [ "$uid" = "0" ]; then
    if [ -n "$warn_if_root" ]; then
      echo "[entrypoint] $dir is root-owned, so an agent running as you won't be able to write to it." >&2
      echo "[entrypoint] create the directory before mounting it (mkdir -p <dir>), or pass -e STATE_UID=\$(id -u)." >&2
    fi
    return 0
  fi
  # Recursive: the files inside are the point, not the directory around them.
  chown -R "$uid:$gid" "$dir" 2>/dev/null \
    && echo "[entrypoint] $dir owned by $uid:$gid" \
    || echo "[entrypoint] could not chown $dir (harmless for a docker volume)"
}

goodbye() {
  if [ -n "${YEET_AUTH_KEY:-}" ]; then
    yeet logout --delete-host 2>/dev/null || true
  fi
  [ -n "$server_pid" ] && kill -TERM "$server_pid" 2>/dev/null || true
  [ -n "$yeetd_pid" ] && kill -TERM "$yeetd_pid" 2>/dev/null || true
}
trap goodbye TERM INT

# 0. The host list lives in /data, and without this you could read it but not edit it —
#    which is half of what a plain-JSON state file is for. Silent when there's nobody to
#    hand it to (a named volume), because that case is fine.
#    The very first write still lands root-owned: it happens after this runs, and the
#    next start corrects it.
STATE_DIR="$(dirname "${HOSTS_FILE:-/data/hosts.json}")"
hand_back "$STATE_DIR"

# 1. Warn early if the Docker socket isn't there. Not fatal — the server comes up
#    and shows the error per host, which beats a container that won't start.
DOCKER_SOCK="${DOCKER_SOCK:-/var/run/docker.sock}"
if [ ! -S "$DOCKER_SOCK" ]; then
  echo "[entrypoint] warning: no docker socket at $DOCKER_SOCK" >&2
  echo "[entrypoint] run with -v /var/run/docker.sock:/var/run/docker.sock or this host will list no containers." >&2
fi

# 2. yeet daemon. It owns the graph, which is what both the container list and
#    the log subscriptions read.
echo "[entrypoint] starting yeetd..."
setsid /usr/sbin/yeetd &
yeetd_pid="$!"

# 3. Wait for a socket to appear (up to ~15s). Either will do: the server passes
#    both to the CLI and lets it choose.
SOCK="${YEET_SOCKET:-/run/yeet/yeetd.sock}"
USER_SOCK="${YEET_USER_SOCKET:-/run/yeet/yeetd.user.sock}"
echo "[entrypoint] waiting for yeetd at $SOCK ..."
for _ in $(seq 1 150); do
  { [ -S "$SOCK" ] || [ -S "$USER_SOCK" ]; } && break
  sleep 0.1
done
if [ ! -S "$SOCK" ] && [ ! -S "$USER_SOCK" ]; then
  echo "[entrypoint] yeetd socket never appeared at $SOCK" >&2
  goodbye
  exit 1
fi
echo "[entrypoint] yeetd is up."

# 4. Run from an editable copy of the source rather than from the image.
#
#    This is how it always runs, not a mode you turn on. The app serves its own source
#    out of /edit, so an agent — or you — can rewrite any part of it while it keeps
#    serving. Mount a host directory at /edit and that becomes a directory on your
#    machine; leave it unmounted and it still works, just only reachable with
#    `docker exec` and gone when the container is removed.
#
#    /app stays pristine: it's the reference we seed from and reset to, and it's why a
#    bad edit is never unrecoverable.
#
#    Seeded once, then never again: the copy in /edit is the source of truth from that
#    point on, because clobbering an agent's work on every restart is the one behaviour
#    that would make this useless. EDIT_RESET=1 asks for the image's version back.
#
#    SRC_DIR is where the image's pristine copy lives. A variable rather than a
#    hardcoded /app only so the seeding can be exercised outside a container.
SRC_DIR="${SRC_DIR:-/app}"
EDIT_DIR="${EDIT_DIR:-/edit}"
mkdir -p "$EDIT_DIR"
STAMP="$EDIT_DIR/.logedex-seeded"

# Who owns the mount, read BEFORE anything below touches it. A bind mount arrives
# owned by the user who created it on the host, and that is how we know who to hand
# the seeded files back to when no STATE_UID was passed. It has to be captured here
# because `cp -a` below overwrites this directory's own ownership with the image's
# (root) — reading it afterwards finds root every time and loses the one piece of
# information that makes a flag-free `docker run` work.
WAS_UID="$(stat -c %u "$EDIT_DIR" 2>/dev/null || echo 0)"
WAS_GID="$(stat -c %g "$EDIT_DIR" 2>/dev/null || echo 0)"

if [ "${EDIT_RESET:-0}" != "0" ]; then
  echo "[entrypoint] EDIT_RESET=1 — restoring the image's source into $EDIT_DIR"
  rm -rf "$EDIT_DIR/agent" "$EDIT_DIR/server" "$EDIT_DIR/shared" "$STAMP"
fi

if [ ! -f "$STAMP" ]; then
  echo "[entrypoint] seeding $EDIT_DIR from the image..."
  # `$SRC_DIR/.` not `$SRC_DIR`: copy the CONTENTS in, rather than nesting /edit/app.
  # --no-preserve=ownership because the image's files are root's and there is nothing
  # worth carrying over: everything gets handed to the human below anyway, and
  # preserving it would also stamp root onto the mount directory itself.
  cp -a --no-preserve=ownership "$SRC_DIR"/. "$EDIT_DIR"/
  { date -u +"seeded %Y-%m-%dT%H:%M:%SZ from image $SRC_DIR"
    echo "image=$(tree_fingerprint "$SRC_DIR")"; } > "$STAMP"
else
  echo "[entrypoint] $EDIT_DIR already seeded — keeping what's there ($(head -1 "$STAMP"))"
  # Seeding once is what makes an agent's work survive a restart, and it's also how
  # you end up running last month's dashboard: pull a new image, and the copy in the
  # mount — which is what actually runs — is untouched. Nothing about the container
  # looks wrong, so this is worth saying out loud rather than leaving to be
  # discovered when a fix that shipped isn't there.
  #
  # Said, not acted on. Re-seeding would silently delete whatever was edited, and
  # that is a worse outcome than running old code, so the choice stays with the human.
  was="$(sed -n 's/^image=//p' "$STAMP")"
  now="$(tree_fingerprint "$SRC_DIR")"
  if [ -z "$was" ]; then
    # Seeded by a version that didn't record one. There is genuinely nothing to compare
    # against, and guessing would mean either a warning we can't justify or silence
    # forever — so record today's image and let the NEXT upgrade be the one that speaks.
    echo "image=$now" >> "$STAMP"
    echo "[entrypoint] $EDIT_DIR predates image tracking — recorded this image as its baseline."
  elif [ "$was" != "$now" ]; then
    echo "[entrypoint] NOTE: this image's source differs from what $EDIT_DIR was seeded from." >&2
    echo "[entrypoint]   You are running the copy in $EDIT_DIR, not the new image." >&2
    echo "[entrypoint]   EDIT_RESET=1 takes the image's version (discarding local edits)." >&2
    echo "[entrypoint]   Compare first with: diff -ru $SRC_DIR $EDIT_DIR" >&2
  fi
fi

# Where a crash goes, so a broken edit is a file the agent can read rather than a
# dashboard that just stopped answering. Created BEFORE the handover below so the one
# recursive chown covers it — handing back a directory we haven't made yet would
# leave the log root-owned and unreadable, which is the moment it matters most.
LOG_DIR="$EDIT_DIR/.logedex"
SERVER_LOG="$LOG_DIR/server.log"
mkdir -p "$LOG_DIR"
: > "$SERVER_LOG"   # fresh per container start, so the log is this run's story

# Everything we just seeded is root-owned, and an agent running as you could then read
# the code but not change a line of it — which is the entire feature. Loud if it can't
# be fixed, unlike /data above: here it's the difference between working and not.
hand_back "$EDIT_DIR" warn "$WAS_UID" "$WAS_GID"

RUN_FROM="$EDIT_DIR"
# The agent script is read from disk per stream, so it tracks the editable copy
# too — otherwise editing agent/logstream.js would silently do nothing.
export AGENT_DIR="$RUN_FROM/agent"
export EDIT_DIR

# 5. Node server: serves the dashboard, answers for this host, fans out to the
#    hosts in the list.
echo "[entrypoint] starting logedex on :${PORT:-8080}... (from $RUN_FROM)"
# --watch-path, not bare --watch. This is not a detail: bare `--watch` builds its
# watch set from the files the RUNNING process managed to load, so when a bad edit
# kills the process at import time that set is lost and only the entry file is
# still watched. Fixing the file you just broke then restarts nothing — the server
# stays down until something touches index.js. Explicit paths are watched whether
# the process is up or not, which is what makes "fix it and it comes back" true.
#
# public/ sits under server/ and so is watched as well. Harmless: the browser reads
# those files per request, so a frontend edit only ever needed a reload, and the
# extra restart costs a second that the page's SSE retry already covers.
#
# agent/ is watched even though this process never imports it. That script runs inside
# the yeet daemon's isolate, spawned per attach — so an edit to it is already picked up
# by the NEXT attach, and streams that are currently open go on running the old copy
# until something re-attaches them. Restarting is what re-attaches them: the isolates
# die with the server, the browser reconnects, and the new code is what comes back. One
# rule for the whole source then, instead of one file that needs a manual detach.
#
# --watch-preserve-output keeps node from clearing the screen on each restart,
# which would otherwise wipe the crash we're trying to leave in the log below.
echo "[entrypoint] watching $RUN_FROM/{server,shared,agent} · crash output → $SERVER_LOG"
# Process substitution rather than a pipe, so $! is node itself and not `tee` —
# the trap has to be able to signal the server.
node --watch --watch-preserve-output \
     --watch-path="$RUN_FROM/server" \
     --watch-path="$RUN_FROM/shared" \
     --watch-path="$RUN_FROM/agent" \
     "$RUN_FROM/server/index.js" > >(tee -a "$SERVER_LOG") 2>&1 &
server_pid="$!"

# 6. Exit as soon as either process does, then clean up the other.
#
#    Note what this does NOT catch. `node --watch` deliberately survives the server
#    crashing — it waits for the fix — so a broken edit keeps this script running and
#    the container Up while nothing answers on the port. That's the behaviour we want
#    for an edit, and it's also true of a crash nobody edited their way into (a port
#    already in use, say), where docker's restart policy would previously have kicked
#    in and now won't. The image's HEALTHCHECK is what makes that visible: the
#    container goes `unhealthy` rather than looking fine and serving nothing.
wait -n
goodbye
