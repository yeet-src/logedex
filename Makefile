# Logédex — build + run (yeetd + server).
#
#   make run     build the image and run it in the FOREGROUND (Ctrl-C to stop).
#   make up      build and run DETACHED with --restart unless-stopped.
#   make down    stop and remove the detached container.
#   make logs    follow the detached container's logs.
#   make build   just build the image.
#   make dev     run the server straight from this checkout (no docker), against
#                the host's own yeetd — the fastest edit/reload loop.
#   make edit    the same as `make up`, and then prints where the running app's source
#                is on this host. Every run mounts it — the container serves its own
#                source out of a directory you can edit while it runs.
#   make demo    three containers that log like real services, to look at.
#
# Run this on EVERY host you want logs from. Each instance answers for its own
# box; the one you point your browser at is the one that fans out to the others.
# Add the rest through the UI, or declare them up front with HOSTS=… below.
#
# The container needs the Docker socket (the container list and the log streams
# both come from it) and a port. That's all — no --privileged, no BPF caps, no
# host PID namespace, no kernel BTF mount.
#
# Note: the socket is mounted read-write because that's the only mode Docker's
# API has. This app only ever reads (list containers, read logs), but anything
# that can reach that socket could do more — so treat granting it as equivalent
# to granting docker access on the host, and don't expose the port publicly
# without something in front of it.

.PHONY: run up down logs build dev state demo demo-stop edit push push-check
.DEFAULT_GOAL := run

IMAGE ?= logedex
NAME  ?= logedex
PORT  ?= 8080

# Optional passthroughs:
#   HOSTS="a.lan:8080 b.lan:8080"  hosts to add at startup, on top of the saved list
#   LOCAL_LABEL=web-01             what to call THIS box in the UI. Defaults to this
#                                  machine's hostname, passed in from here because
#                                  inside the container `hostname` is the container's
#                                  own id — which names the wrong thing and changes
#                                  every time the container is recreated
#   TAIL=500                       log lines buffered per attached container
#   MAX_WINDOW=86400               widest history one request may replay, in seconds.
#                                  Bounds what a single pane can make this box read
#                                  back through; 0 turns the cap off
#   REQUIRE_LOGIN=0                turn OFF the dashboard's yeet login gate. On by
#                                  default: the box you point a browser at asks you
#                                  to sign in to yeet before it shows anything. Only
#                                  that box needs it — the ones it fans out to are
#                                  reached over their own API, which the gate does
#                                  not cover. Not a security boundary; see
#                                  server/auth.js for what it is and isn't.
#   NET=host                       DEFAULT. Shares the host's network namespace, which
#                                  is what makes adding a host by name just work: the
#                                  container reads the host's own resolv.conf, so a
#                                  loopback resolver (systemd-resolved, MagicDNS)
#                                  resolves because loopback IS the host's. On a
#                                  bridge, Docker can't pass a loopback nameserver
#                                  through and substitutes one that has never heard
#                                  of your tailnet — see DNS= below for that route.
#                                  PORT becomes the host's port directly (-p is
#                                  dropped). `NET=` puts it back on a bridge.
#
#                                  This gives up network isolation, and that is a
#                                  smaller thing than it sounds here: the container
#                                  already has the Docker socket, which is
#                                  root-equivalent on the host.
#   DNS=100.100.100.100            a resolver for the container, when the names you
#                                  add hosts by are ones only THIS box can resolve.
#                                  Docker can't hand a container the host's resolver
#                                  if it listens on loopback (systemd-resolved,
#                                  dnsmasq), so it substitutes a public one — which
#                                  has never heard of your tailnet or your
#                                  /etc/hosts. 100.100.100.100 is Tailscale's.
#                                  Routing is fine either way; this is DNS only.
#   YEET_AUTH_KEY=...              register the host with the yeet control plane
#   EDIT_SRC=<path>                where the app's own source is mounted so you can edit
#                                  it while it runs — this is how it always runs, not an
#                                  option. Default: $(STATE)/src. Seeded from the image on
#                                  first start, then left alone, so your edits survive
#                                  restarts. EDIT_RESET=1 restores the image's version.
#
#                                  WORTH KNOWING WHAT THIS IS: that directory is code the
#                                  container executes, and the container holds the Docker
#                                  socket. Anything that can write to it has root on this
#                                  box. It's the same authority the socket already grants,
#                                  reached through the filesystem instead of the docker
#                                  API — so it's writable by anything running as you, not
#                                  only by things that speak to docker. Keep the port off
#                                  the public internet and the directory to yourself.
#   EDIT_RESET=1                   discard what's in EDIT_SRC and re-seed from the image.
#   STATE=<path|name>              where the host list is kept so it survives the
#                                  container being deleted and recreated. Default is
#                                  a real directory on the host, so hosts.json is a
#                                  file you can read, edit or back up:
#                                    ~/.local/state/logedex/hosts.json
#                                  A value containing `/` is a host path; a bare
#                                  name like `logedex-data` uses a docker named volume.
HOSTS         ?=
LOCAL_LABEL   ?= $(shell hostname -s 2>/dev/null || hostname 2>/dev/null)
TAIL          ?=
MAX_WINDOW    ?=
DNS           ?=
NET           ?= host
REQUIRE_LOGIN ?=
YEET_AUTH_KEY ?=
STATE         ?= $(HOME)/.local/state/logedex
DOCKER_SOCK   ?= /var/run/docker.sock
EDIT_RESET    ?=
EDIT_SRC      ?= $(STATE)/src

ifeq (,$(findstring /,$(STATE)))
STATE_MOUNT := $(STATE)
# STATE is a docker volume name, so it can't host the editable copy — that has to be a
# real directory the agent can open. Fall back to the default state path.
EDIT_SRC := $(if $(filter $(STATE)/src,$(EDIT_SRC)),$(HOME)/.local/state/logedex/src,$(EDIT_SRC))
else
STATE_MOUNT := $(abspath $(STATE))
endif
EDIT_MOUNT := $(abspath $(EDIT_SRC))

# The editable source, mounted every run. EDIT_SRC_HOST is passed so the UI can show an
# agent the path on THIS machine — inside the container it's /edit, which is not where
# the agent works and not a path it can open.
EDIT_FLAGS := \
	-v $(EDIT_MOUNT):/edit \
	-e EDIT_SRC_HOST=$(EDIT_MOUNT) \
	$(if $(EDIT_RESET),-e EDIT_RESET=1,)

# Use docker directly if the daemon is reachable, else fall back to sudo — so
# `make run` works whether or not you're in the `docker` group.
DOCKER := $(shell docker info >/dev/null 2>&1 && echo docker || echo sudo docker)

# `--network host` and `-p` are mutually exclusive in practice: docker keeps the flag
# but discards the mapping, with a warning. Dropping it here keeps the command honest
# about what it's doing rather than printing a warning every run.
ifeq ($(NET),host)
NET_FLAGS := --network host
else
NET_FLAGS := $(if $(NET),--network $(NET),) -p $(PORT):$(PORT)
endif

RUN_FLAGS := \
	$(NET_FLAGS) \
	$(if $(DNS),--dns $(DNS),) \
	-v $(DOCKER_SOCK):/var/run/docker.sock \
	-v $(STATE_MOUNT):/data \
	-e PORT=$(PORT) \
	-e HOSTS="$(HOSTS)" \
	-e LOCAL_LABEL="$(LOCAL_LABEL)" \
	-e TAIL=$(TAIL) \
	-e MAX_WINDOW=$(MAX_WINDOW) \
	-e REQUIRE_LOGIN="$(REQUIRE_LOGIN)" \
	-e YEET_AUTH_KEY=$(YEET_AUTH_KEY) \
	-e STATE_UID=$(shell id -u) \
	-e STATE_GID=$(shell id -g) \
	$(EDIT_FLAGS)

build:
	$(DOCKER) build . -t $(IMAGE)

# ── publishing ──────────────────────────────────────────────────────────────
# `make push` builds for both architectures and pushes the manifest list to GHCR.
#
# Both at once, in one buildx invocation, because the thing being published is a manifest
# LIST — one tag that resolves to whichever architecture the puller is on. Building the two
# separately and pushing each to the same tag doesn't produce that; the second push simply
# replaces the first, and half your fleet pulls an image it can't run.
#
# arm64 here is emulated through qemu, which the daemon has to be set up for (docker's
# binfmt image, or a builder with an arm64 node). `make push-check` says whether it is
# before you wait on a build that can only fail.
#
# The build itself is arch-neutral — nothing is compiled, and yeet's apt repo serves both
# architectures — so this is a matter of asking for both rather than of porting anything.
REGISTRY  ?= ghcr.io
OWNER     ?= yeet-src
PLATFORMS ?= linux/amd64,linux/arm64
TAG       ?= latest
REMOTE    ?= $(REGISTRY)/$(OWNER)/$(IMAGE)

push-check:
	@$(DOCKER) buildx inspect --bootstrap 2>/dev/null | grep -q "linux/arm64" \
	  || { echo "this builder can't do arm64 — run: docker run --privileged --rm tonistiigi/binfmt --install all"; exit 1; }
	@echo "builder can build: $(PLATFORMS)"

push: push-check
	$(DOCKER) buildx build . \
	  --platform $(PLATFORMS) \
	  -t $(REMOTE):$(TAG) \
	  --push
	@echo ""
	@echo "pushed $(REMOTE):$(TAG)  ·  $(PLATFORMS)"
	@echo "NOTE: a package GHCR has just created is PRIVATE until you change it at"
	@echo "  https://github.com/orgs/$(OWNER)/packages"

# Create the state directory as the invoking user, so hosts.json ends up in a
# directory you own — docker would otherwise create it root-owned.
state:
	@case "$(STATE)" in \
	  */*) mkdir -p "$(STATE_MOUNT)" && echo "state: $(STATE_MOUNT)/hosts.json";; \
	  *)   echo "state: docker volume $(STATE)";; \
	esac
	@mkdir -p "$(EDIT_MOUNT)" && echo "src:   $(EDIT_MOUNT)  (editable while it runs)"

run: build state
	@$(DOCKER) run --rm -it --name $(NAME) $(RUN_FLAGS) $(IMAGE) || :

up: build state
	@$(DOCKER) rm -f $(NAME) >/dev/null 2>&1 || true
	@$(DOCKER) run -d --name $(NAME) --restart unless-stopped $(RUN_FLAGS) $(IMAGE)
	@echo "Logédex up on :$(PORT)  ·  make logs  |  make down"

# `make up` already mounts the source — every run does. This just says where it landed,
# for when that's the thing you came for.
edit: up
	@echo ""
	@echo "  the running app's source is at:"
	@echo "    $(EDIT_MOUNT)"
	@echo "  Point your agent at that directory, or click \"live edit\" in the UI for"
	@echo "  instructions you can paste. Saves under server/, shared/ or agent/ restart"
	@echo "  the server themselves; saves under server/public/ just need a browser reload."
	@echo "  Crash output: $(EDIT_MOUNT)/.logedex/server.log"
	@echo "  Start over:   make up EDIT_RESET=1"

down:
	@$(DOCKER) rm -f $(NAME) >/dev/null 2>&1 && echo "stopped $(NAME)" || echo "$(NAME) not running"

logs:
	@$(DOCKER) logs -f $(NAME)

# Demo containers that log like real services — varied lines, a flood of /health to
# filter out, and occasional real Python tracebacks. One `echo` in a loop exercises
# nothing; see demo/noisy.py for what it's trying to break.
demo:
	@demo/run.sh

demo-stop:
	@demo/run.sh --stop

# No container: run the server from this checkout against the yeetd already on
# this machine. `node --watch` restarts it on every save.
dev:
	cd server && HOSTS_FILE=$${HOSTS_FILE:-$(CURDIR)/server/hosts.json} \
		PORT=$(PORT) HOSTS="$(HOSTS)" LOCAL_LABEL="$(LOCAL_LABEL)" \
		MAX_WINDOW="$(MAX_WINDOW)" REQUIRE_LOGIN="$(REQUIRE_LOGIN)" \
		node --watch index.js
