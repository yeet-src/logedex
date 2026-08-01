#!/usr/bin/env python3
"""A container that logs like a real service, for exercising the dashboard.

The point of a demo log is to be *awkward* in the ways real logs are awkward, because
that's what the UI has to survive. A `while true; do echo; done` looks fine in every
viewer ever written and tells you nothing. This one is built to break things:

  - Varied lines, so the filter boxes have something to narrow and the eye can't
    pattern-match its way past a wall of identical text.
  - Lots of `/health`, deliberately. It's the canonical noise — high rate, zero
    interest — and it's what the "hide lines with…" box exists for.
  - Bursty timing. Quiet stretches, normal traffic, and occasional floods, so the
    time scrubber has real shape instead of a flat rate.
  - Real Python tracebacks on stderr. This is the interesting case for a log viewer:
    docker delivers a traceback as N separate lines with N separate timestamps, so it
    is not one event to anything downstream. In a combined pane two hosts' tracebacks
    can interleave line-by-line into unreadable mush — correctly, by timestamp — and
    that's worth being able to see.
  - stdout and stderr both, since they're styled differently and mixing them is the
    normal case, not an edge one.
  - ANSI colour, because a great many things emit it whether or not a terminal is
    attached, and a viewer that renders `\x1b[32m` as literal text is both ugly and
    misaligned. `--no-colour` turns it off to see the difference.

Stdlib only, no arguments required:

    python3 -u noisy.py [--name web-01] [--rate 3]

`-u` matters. Python block-buffers stdout when it isn't a tty, so without it the
lines arrive at docker in 8KB clumps — which looks like a broken log pipeline and
would make every timestamp in a clump nearly identical.
"""

import argparse
import os
import random
import sys
import time
import traceback

# ── colour ──────────────────────────────────────────────────────────────────
# Written the way an application writes it: a level is coloured, the rest of the line
# isn't, and nothing bothers to check whether anyone is watching. That last part is
# the point — this is what lands in `docker logs` from most tools by default.
RESET = "\x1b[0m"
DIM = "\x1b[2m"
LEVEL = {
    "DEBUG": "\x1b[2;37m",     # dim white
    "INFO": "\x1b[32m",        # green
    "WARN": "\x1b[33m",        # yellow
    "ERROR": "\x1b[1;31m",     # bold red
}
COLOUR = True


def line(level: str, body: str) -> str:
    """`LEVEL body`, with the level coloured if colour is on."""
    if not COLOUR:
        return f"{level} {body}"
    return f"{LEVEL[level]}{level}{RESET} {body}"

# ── the vocabulary ──────────────────────────────────────────────────────────
# Weighted so the mix looks like traffic rather than a uniform sample of the list.
# `/health` is heavy on purpose: see the note up top.
ROUTES = (
    [("GET", "/health", 200)] * 26
    + [("GET", "/healthz", 200)] * 8
    + [("GET", "/metrics", 200)] * 6
    + [
        ("GET", "/api/orders", 200),
        ("GET", "/api/orders/{id}", 200),
        ("POST", "/api/orders", 201),
        ("GET", "/api/customers/{id}", 200),
        ("PATCH", "/api/customers/{id}", 200),
        ("GET", "/api/inventory", 200),
        ("POST", "/api/checkout", 200),
        ("GET", "/api/search", 200),
        ("DELETE", "/api/sessions/{id}", 204),
        ("GET", "/api/orders/{id}", 404),
        ("POST", "/api/checkout", 402),
        ("GET", "/api/reports/daily", 200),
        ("POST", "/api/webhooks/stripe", 200),
    ]
)

WORKER_JOBS = [
    "reconcile.orders", "email.receipt", "index.products", "purge.sessions",
    "sync.inventory", "rollup.metrics", "warm.cache",
]

CHATTER = [
    "cache hit ratio {pct}% over last {n} requests",
    "pool: {a}/{b} connections in use",
    "flushed {n} events to the buffer",
    "config reload: no changes",
    "gc: freed {n}MB in {ms}ms",
    "heartbeat ok, peers={n}",
]

WARNINGS = [
    "slow query took {ms}ms: SELECT * FROM orders WHERE customer_id = ?",
    "retrying upstream inventory-svc (attempt {n}/3)",
    "connection pool at {pct}% capacity",
    "dropping stale message, age {ms}ms",
    "rate limit near threshold for tenant {id}",
]


def rid() -> str:
    """A request id, so there's something worth searching for."""
    return f"req-{random.randbytes(4).hex()}"


# ── the failures ────────────────────────────────────────────────────────────
# Raised for real rather than printed as text: a fabricated "traceback" is a string
# with no frames in it, and the whole point is to produce the genuine multi-line shape
# docker will chop into separate log lines.


def _load_customer(customer_id):
    record = {"id": customer_id}
    return record["email"]                       # KeyError


def _parse_amount(raw):
    return int(raw) / 0                          # ZeroDivisionError


def _decode_payload(blob):
    import json
    return json.loads(blob)                      # JSONDecodeError


def _call_upstream(host):
    raise TimeoutError(f"upstream {host} did not respond within 5.0s")


def _apply_discount(order):
    pct = order.get("discount")
    return order["total"] * (1 - pct)            # TypeError: None


FAILURES = [
    (_load_customer, "cus_8f31a0"),
    (_parse_amount, "1499"),
    (_decode_payload, '{"amount": 12,}'),
    (_call_upstream, "inventory-svc.internal"),
    (_apply_discount, {"total": 40.0, "discount": None}),
]


def raise_one(name: str) -> None:
    """Emit a real traceback on stderr, framed the way an app would frame it."""
    fn, arg = random.choice(FAILURES)
    request = rid()
    print(line("ERROR", f"{name} unhandled exception while handling {request}"), file=sys.stderr)
    try:
        fn(arg)
    except Exception:
        traceback.print_exc(file=sys.stderr)
    print(line("ERROR", f"{name} {request} failed, returning 500"), file=sys.stderr)


# ── the traffic shape ───────────────────────────────────────────────────────
# Three regimes with different rates, picked at random and held for a while. A log
# that arrives at a constant rate gives the scrubber nothing to show; this gives it
# quiet stretches and spikes to actually have a shape between.
PHASES = [
    ("quiet", 0.20, (4.0, 12.0)),    # name, share of the line rate, how long to hold
    ("normal", 1.00, (20.0, 60.0)),
    ("burst", 6.00, (2.0, 8.0)),
]


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--name", default=os.environ.get("NAME", "web-01"))
    ap.add_argument("--rate", type=float, default=float(os.environ.get("RATE", "3")),
                    help="lines per second in the normal phase")
    ap.add_argument("--no-colour", action="store_true", help="emit plain text instead")
    # Seeded from the name so two containers differ from each other but each stays
    # recognisable across restarts — useful when comparing two panes side by side.
    args = ap.parse_args()
    global COLOUR
    COLOUR = not args.no_colour
    random.seed(args.name)
    name = args.name

    print(line("INFO", f"{name} starting up, pid={os.getpid()}"))
    print(line("INFO", f"{name} listening on 0.0.0.0:8000"))

    phase, mult, until = "normal", 1.0, time.time() + 30
    while True:
        now = time.time()
        if now >= until:
            phase, mult, hold = random.choice(PHASES)
            until = now + random.uniform(*hold)
            print(line("DEBUG", f"{name} traffic now {phase}"))

        roll = random.random()
        if roll < 0.010:
            raise_one(name)
        elif roll < 0.055:
            tmpl = random.choice(WARNINGS)
            print(line("WARN", f"{name} " + tmpl.format(
                ms=random.randint(250, 4000), n=random.randint(1, 3),
                pct=random.randint(70, 98), id=f"t_{random.randbytes(3).hex()}",
            )), file=sys.stderr)
        elif roll < 0.130:
            job = random.choice(WORKER_JOBS)
            print(line("INFO", f"{name} worker job={job} status=done in {random.randint(4, 900)}ms"))
        elif roll < 0.200:
            tmpl = random.choice(CHATTER)
            print(line("DEBUG", f"{name} " + tmpl.format(
                pct=random.randint(40, 99), n=random.randint(1, 400),
                a=random.randint(1, 20), b=20, ms=random.randint(1, 90),
            )))
        else:
            method, path, status = random.choice(ROUTES)
            path = path.replace("{id}", str(random.randint(1000, 9999)))
            # Health checks are fast and boring; real endpoints are neither.
            ms = round(random.uniform(0.2, 2.0) if status == 200 and "health" in path
                       else random.uniform(3, 400), 1)
            code = str(status) if not COLOUR else (
                f"\x1b[32m{status}{RESET}" if status < 300
                else f"\x1b[33m{status}{RESET}" if status < 500
                else f"\x1b[31m{status}{RESET}")
            print(line("INFO", f"{name} {method} {path} {code} {DIM}{ms}ms{RESET} {rid()}"))

        time.sleep(max(0.002, random.expovariate(args.rate * mult)))


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
