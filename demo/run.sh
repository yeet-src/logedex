#!/usr/bin/env bash
# Start (or restart) the demo containers that noisy.py feeds.
#
#   demo/run.sh                 three services at different rates
#   demo/run.sh web-01 api-02   just these
#   demo/run.sh --stop          remove them all
#
# Three by default, because one container demonstrates almost nothing about this
# dashboard: the point of it is reading several streams side by side, and the `+`
# button needs something to combine with. They run at different rates so a combined
# pane is visibly interleaved rather than alternating politely.
#
# The script is mounted rather than baked into an image, so editing noisy.py and
# re-running this is the whole loop — no build step.
set -euo pipefail

IMAGE="${IMAGE:-python:3.12-alpine}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DOCKER="$(docker info >/dev/null 2>&1 && echo docker || echo "sudo docker")"

# name:rate — the rates differ so the panes don't look like copies of each other,
# and so the scrubber's span differs per container.
DEFAULT_SERVICES=("web-01:4" "api-02:2" "worker-03:0.7")

if [[ "${1:-}" == "--stop" ]]; then
  for svc in "${DEFAULT_SERVICES[@]}"; do
    $DOCKER rm -f "${svc%%:*}" >/dev/null 2>&1 || true
  done
  echo "removed demo containers"
  exit 0
fi

if [[ $# -gt 0 ]]; then
  SERVICES=()
  for name in "$@"; do SERVICES+=("$name:3"); done
else
  SERVICES=("${DEFAULT_SERVICES[@]}")
fi

for svc in "${SERVICES[@]}"; do
  name="${svc%%:*}"
  rate="${svc##*:}"
  $DOCKER rm -f "$name" >/dev/null 2>&1 || true
  # `-u` is not optional: python block-buffers stdout when it isn't a tty, and the
  # lines would reach docker in 8KB clumps sharing near-identical timestamps.
  $DOCKER run -d --name "$name" \
    -v "$HERE/noisy.py:/noisy.py:ro" \
    "$IMAGE" python3 -u /noisy.py --name "$name" --rate "$rate" >/dev/null
  echo "started $name at ~${rate} lines/s"
done

echo
echo "open the dashboard and attach them. things worth trying:"
echo "  · put /health in the 'hide lines with…' box — it's most of the traffic"
echo "  · filter for ERROR to find the tracebacks (they arrive as separate lines)"
echo "  · attach two, then + to combine, and watch a traceback interleave"
