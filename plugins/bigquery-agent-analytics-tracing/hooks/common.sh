#!/bin/bash
# Shared body of every hook script. The agent waits for the hook before it
# goes on (PreToolUse and PostToolUse wrap every tool call), so this must
# never block or fail. Python is the part that can stall: on macOS a hung
# syspolicyd blocks every launch of a non-Apple interpreter until launchd
# replaces the daemon. So the hook runs only bash and base utilities
# (dirname, cat, mkdir, rarely rm) and always exits 0 with no output:
#   1. It queues the event under the state dir, reading the payload under
#      the same deadline as the rest. A full queue gets one bounded Python
#      cleanup run first: entries past the TTL are pruned so queueing can
#      resume.
#   2. It starts the Python adapter detached from the hook's stdio. That run
#      applies all of the session's queued events, oldest first, so an event
#      whose own run starts late still lands before newer ones. Python reads
#      whose events they are (the top-level session_id) from the whole
#      payloads; the hook doesn't look inside them.
#   3. It waits for Python, at most BQAA_HOOK_WAIT_SECONDS (default 1) in
#      all. Whole seconds: macOS ships bash 3.2, whose read -t takes no less.

exec 2>/dev/null
# bash turns on the options an exported SHELLOPTS names. Under errexit or
# nounset the hook would stop part way with status 1 and lose the event.
set +e +u

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLUGIN_DIR="$(dirname "$SCRIPT_DIR")"
PYTHON_BIN="${BQAA_PYTHON:-python3}"
HOOK_NAME="${1:-}"

if [[ "${BQAA_TRACE_ENABLED:-true}" != "true" ]]; then
  exit 0
fi

# Without a project and dataset nothing can be written (dry-run aside), so
# don't start Python at all. Mirrors BQAAConfig.from_env() and _emit_row().
case "${BQAA_DRY_RUN:-false}" in
  [Tt][Rr][Uu][Ee]) ;;
  *)
    if [[ -z "${BQAA_PROJECT_ID:-${GCP_PROJECT_ID:-${GOOGLE_CLOUD_PROJECT:-}}}" ||
          -z "${BQAA_DATASET:-${BQ_DATASET:-}}" ]]; then
      exit 0
    fi
    ;;
esac

SECONDS=0
WAIT_SECONDS="${BQAA_HOOK_WAIT_SECONDS:-1}"
[[ "$WAIT_SECONDS" =~ ^[0-9]+$ ]] || WAIT_SECONDS=1
WAIT_SECONDS=$((10#$WAIT_SECONDS))

# --- 1. Queue the event ------------------------------------------------------
# One file per event, named by a 12-digit sequence number; the format is
# described next to QUEUE_END in bqaa_tracing.py. A number is never handed
# out twice: a run records an event's number in queue/last before it removes
# the event, and a hook keeps a number only if it's above queue/last once the
# hook holds the file. So a hook that starts after another has returned
# always gets a higher number than that one, and a run reading the queue in
# order can't come across a newer event under a number it has already passed.
STATE_DIR="${BQAA_STATE_DIR:-/tmp/bqaa-agent-tracing}"
case "$STATE_DIR" in \~ | \~/*) STATE_DIR="$HOME${STATE_DIR:1}" ;; esac
QUEUE_DIR="$STATE_DIR/queue"
# If adapter runs never get going, stop queueing well before /tmp fills up.
QUEUE_MAX=10000
CAT_BIN=/bin/cat
[[ -x "$CAT_BIN" ]] || CAT_BIN="cat"

# Run one detached Python job, waiting at most the rest of the hook's budget
# for it. The subshell keeps the pipe on fd 3 open until Python exits, so
# read returns as soon as it is done (the normal case) or when the time is
# up. Nothing left running holds the hook's own stdout or stderr, so the
# agent isn't kept waiting for EOF either.
launch_python() {
  local job="$1"
  if exec 3< <("$job"); then
    local wait_left=$((WAIT_SECONDS - SECONDS))
    if ((wait_left > 0)); then
      read -r -t "$wait_left" -u 3 _ || true
    fi
    exec 3<&-
  else
    ("$job" >/dev/null) &
  fi
}

# A full queue can be all-expired entries: adapter runs never got going, so
# the TTL cleanup they run never happened. Give Python one bounded shot at
# it (cleanup_stale_state records the pruned numbers before unlinking, so
# they stay used), then look again.
# shellcheck disable=SC2329  # invoked indirectly via launch_python
run_cleanup() {
  trap '' HUP INT
  exec </dev/null
  "$PYTHON_BIN" "$PLUGIN_DIR/scripts/bqaa_hook.py" --cleanup "$STATE_DIR" >/dev/null
}

# Payloads can hold prompts and tool output: only the queue dir itself needs
# to be private, its parents are shared with the state files.
# shellcheck disable=SC2174
[[ -d "$QUEUE_DIR" ]] || mkdir -p -m 700 "$QUEUE_DIR" || exit 0
shopt -s nullglob
QUEUED=("$QUEUE_DIR"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9])
if ((${#QUEUED[@]} >= QUEUE_MAX)); then
  launch_python run_cleanup
  QUEUED=("$QUEUE_DIR"/[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9])
  ((${#QUEUED[@]} < QUEUE_MAX)) || exit 0
fi

# Sets USED to the number in queue/last: no event gets it or a lower one.
read_used() {
  local raw=""
  read -r raw <"$QUEUE_DIR/last"
  if [[ "$raw" =~ ^[0-9]{1,12}$ ]]; then USED=$((10#$raw)); else USED=0; fi
}

LAST=0
# Not "${QUEUED[@]}": bash 3.2 calls an empty array unbound under nounset.
for entry in ${QUEUED[@]+"${QUEUED[@]}"}; do
  n=$((10#${entry##*/}))
  ((n > LAST)) && LAST=$n
done
# Start above queue/last too. (The check below is what keeps a number from
# being taken twice; this only saves trying numbers that are used up.)
read_used
((USED > LAST)) && LAST=$USED
# noclobber: the redirection creates the file or fails if another hook just
# took that number.
set -C
ENTRY=""
for ((tries = 0; tries < 64; tries++)); do
  LAST=$((LAST + 1))
  printf -v candidate '%s/%012d' "$QUEUE_DIR" "$LAST"
  exec 5>"$candidate" || continue
  # Since the listing, a later hook may have queued an event under this
  # number and a run applied and removed it. A run raises queue/last before
  # it removes an event, so if the number was used, queue/last shows it now.
  read_used
  if ((USED < LAST)); then
    ENTRY="$candidate"
    break
  fi
  exec 5>&-
  rm -f "$candidate"
  ((USED > LAST)) && LAST=$USED
done
set +C
[[ -n "$ENTRY" ]] || exit 0

printf '%s\n' "$HOOK_NAME" >&5
# cat copies the payload in the background and holds the write end of the
# pipe read on fd 4 until it's done. Don't wait for it past the deadline: a
# sender may write the payload and never close stdin.
exec 4< <(exec "$CAT_BIN" 3>&1 >&5) || exit 0
CAT_PID=$!
# The read gets what's left of the wait (a full queue's cleanup may have
# used some of it), but at least a second, even with nothing left: bash 3.2
# takes whole seconds only, and its read -t 0 returns at once without
# reading anything.
READ_SECONDS=$((WAIT_SECONDS - SECONDS))
((READ_SECONDS > 0)) || READ_SECONDS=1
read -r -t "$READ_SECONDS" -u 4 _ || true
if kill -0 "$CAT_PID"; then
  kill "$CAT_PID"
  # Until it's gone, so it can't write after the last line.
  read -r -t 1 -u 4 _ || true
fi
exec 4<&-

# The last line marks the entry complete. Its token tells this hook's run
# its event apart from a newer one with the same number, which can only
# happen if the queue dir was removed in between and the numbers started
# over.
TOKEN="$$-$RANDOM-$RANDOM"
printf '\n%s %s\n' "#bqaa-end" "$TOKEN" >&5
exec 5>&-

# --- 2. and 3. Run the adapter and wait for it ---------------------------------
# shellcheck disable=SC2329  # invoked indirectly via launch_python
run_adapter() {
  # Ignore HUP/INT so an event that outlives the wait still lands when the
  # session's terminal goes away.
  trap '' HUP INT
  exec </dev/null
  "$PYTHON_BIN" "$PLUGIN_DIR/scripts/bqaa_hook.py" --queue "$QUEUE_DIR" "${ENTRY##*/}" "$TOKEN" >/dev/null
}

launch_python run_adapter
exit 0
