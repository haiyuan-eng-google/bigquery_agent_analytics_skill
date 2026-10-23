# BigQuery Agent Analytics Tracing Plugin

Logs Claude Code (and other coding-agent) hook traces into a Google ADK
BigQuery Agent Analytics `agent_events` table.

This is the operational counterpart to the
[`bigquery-agent-analytics-skill`](../../bigquery-agent-analytics-skill) in
this repo: the skill teaches Claude how to query BQAA data; this plugin is
what produces that data from your local Claude Code sessions.

For installation and first-use instructions across all supported channels, see
[USER_GUIDE.md](USER_GUIDE.md). This README focuses on implementation details
and per-channel reference snippets.

## How it works

```
Agent hook (bash, <= BQAA_HOOK_WAIT_SECONDS in all, always exits 0)
        |
        +-> queue/<seq>   (the event, in hook order)
        |
        +-> bqaa_hook.py (background)  ->  spool/event-*.json   (~1 ms)
              applies the session's            |
              queued events, oldest first      +-> spawn detached drainer
                                                       |
                                                       v
                              bqaa_drain.py  ->  BigQuery Storage Write API
                                                  (async, batched, retried,
                                                   dead-lettered on failure)
```

The hook script the agent waits on runs only bash and base utilities
(`dirname`, `cat`, `mkdir`, rarely `rm`). It writes the event to a
numbered file under `BQAA_STATE_DIR/queue`, starts `bqaa_hook.py` detached
from the hook's stdio and waits for it. The whole hook, reading the
payload included, is bounded by `BQAA_HOOK_WAIT_SECONDS` (default 1; see
Reliability for the exact bound). So the agent never waits on Python startup, file locks, auth
or BigQuery, nor on a sender that doesn't close stdin. Each `bqaa_hook.py`
run applies all of its session's queued events,
oldest first, each as of the time its hook ran. An event's session is the
top-level `session_id` of its payload, which `bqaa_hook.py` reads from the
whole payload, wherever the field sits in it. When one run starts late,
another applies its event in turn, so a late `UserPromptSubmit` still opens
the trace before its `Stop` reads the reply, and timestamps and latencies
come out as if nothing was late. Without `BQAA_PROJECT_ID`/`BQAA_DATASET`
(and outside dry-run) the hook exits without starting Python at all.

The drainer is a single-instance background process (enforced by
`fcntl.flock`) that batches spooled rows and writes them via the
`BigQueryWriteAsyncClient` Storage Write API. If the Storage Write client
or PyArrow are not importable, it falls back to legacy
`insert_rows_json` automatically.

## Configuration

Required:

```bash
export BQAA_PROJECT_ID="your-project-id"      # also reads GCP_PROJECT_ID / GOOGLE_CLOUD_PROJECT
export BQAA_DATASET="your_dataset"            # also reads BQ_DATASET
```

Common optional:

```bash
export BQAA_TABLE="agent_events"
export BQAA_LOCATION="US"
export BQAA_AGENT_NAME="claude-code"
export BQAA_USER_ID="$USER"
export BQAA_DRY_RUN="false"                   # if true, writes to BQAA_LOG_FILE only
export BQAA_DIRECT_WRITE="false"              # if true, hook writes inline (legacy)
export BQAA_AUTO_CREATE_TABLE="true"
export BQAA_AUTO_CREATE_DATASET="false"
```

Spool / drainer tuning:

```bash
export BQAA_SPOOL_DIR="/tmp/bqaa-agent-tracing/spool"
export BQAA_STATE_DIR="/tmp/bqaa-agent-tracing"
export BQAA_DRAIN_BATCH_SIZE="50"
export BQAA_DRAIN_IDLE_SECONDS="8"
export BQAA_DRAIN_POLL_SECONDS="0.5"
export BQAA_TRANSCRIPT_MAX_BYTES="262144"     # 256 KB cap for SubagentStop transcripts
export BQAA_STATE_TTL_HOURS="24"              # purge orphaned state and queue files older than this
export BQAA_WRITER_LABEL="bqaa-coding-agent-plugin/0.1.0"   # see "Writer attribution" below
export BQAA_HOOK_WAIT_SECONDS="1"             # whole seconds a hook may take in all; 0 = don't wait for bqaa_hook.py
export BQAA_NETWORK_TIMEOUT_SECONDS="30"      # hard timeout on each ADC lookup / BigQuery call
```

### Authentication

The plugin uses the standard Google Cloud auth chain. Either of these works:

- **Application Default Credentials** (recommended for local dev):
  `gcloud auth application-default login`. No env var needed.
- **Service account JSON**:
  `export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"`.

The service account or user identity needs:

- `roles/bigquery.dataEditor` on the dataset for inserts and table
  create-on-first-use inside an existing dataset.
- `roles/bigquery.jobUser` on the project for verification queries and smoke
  scripts that run `SELECT` statements.
- `roles/bigquery.user` on the project only if
  `BQAA_AUTO_CREATE_DATASET=true`.

Enable `bigquery.googleapis.com` for all write paths. Enable
`bigquerystorage.googleapis.com` for the recommended async Storage Write API
drainer path. Enable `iam.googleapis.com` only when the bootstrap command
creates a service account.

### Easiest path: ask Claude Code to do it

After installing the plugin and restarting Claude Code, type
**`/bigquery-agent-analytics-tracing:bqaa-setup`** (or just say "set up BQAA tracing for this project").
The plugin ships a `bqaa-setup` skill and slash command that walk through:

1. Confirming project / dataset / location / service-account choices.
2. Checking that Application Default Credentials are configured
   (Claude will pause and ask you to run
   `gcloud auth application-default login` yourself if ADC is missing —
   it's an interactive browser flow no agent can complete).
3. Dry-run of `setup_gcp_prereqs.py`, with the full plan shown before
   anything mutates.
4. Explicit approval gate, then `--execute --non-interactive`.
5. End-to-end verification via `e2e_bigquery_smoke.py`.
6. Writing the BQAA env block into `.claude/settings.local.json` so
   the next Claude Code session in this directory auto-traces.

The skill is auto-discovered when you mention setup ("set up BQAA",
"why aren't my BQAA rows landing", "fix BQAA permissions", etc.); the
slash command
`/bigquery-agent-analytics-tracing:bqaa-setup [args]` triggers it
deterministically. Claude Code namespaces plugin commands as
`<plugin-name>:<command>`, so the full path is verbose — for daily
use the natural-language path is shorter; the slash form is best for
docs, runbooks, and unattended runs where the trigger needs to be
deterministic.

### Manual: run the script yourself

To do it without Claude in the loop, run the
bootstrap script in dry-run mode first:

For local Claude Code / SDK / Codex on a workstation, grant your own Google
identity (no impersonation, ADC works directly):

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/setup_gcp_prereqs.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --table "$BQAA_TABLE" \
  --location "$BQAA_LOCATION" \
  --principal "user:$(gcloud config get-value account)"
```

For shared workstations / unattended agents / CI, swap in
`--service-account bqaa-writer` and wire impersonation per
[USER_GUIDE.md → Service-account path](./USER_GUIDE.md#1-prepare-bigquery)
(creating the SA does not redirect runtime traffic on its own).

Then append `--execute` to apply the plan. The script can create the SA,
create the BigQuery dataset/table, enable APIs, and grant runtime IAM. See
[USER_GUIDE.md](./USER_GUIDE.md#1-prepare-bigquery) for the full IAM matrix,
manual commands, and runtime auto-create options. Dataset IAM bindings are
emitted with explicit `bq add-iam-policy-binding -d`.

Every run begins with a preflight that prints the active gcloud ADC and
project so an agent can see what credentials will be used. With
`--execute`, missing ADC hard-fails before any API call, with a clear
"run `gcloud auth application-default login`" message instead of an
opaque 401 mid-bootstrap. Add `--non-interactive` to inject `--quiet`
into every gcloud and bq subcommand so unattended Codex / Claude / CI
runs never block on a confirmation prompt.

### Python runtime

```bash
pip install google-cloud-bigquery
# Recommended for the async Storage Write API path used by the drainer:
pip install google-cloud-bigquery-storage pyarrow
```

If Claude Code should use a specific interpreter:

```bash
export BQAA_PYTHON="/path/to/python"
```

The drainer is spawned with `BQAA_PYTHON` (or `sys.executable`) and
inherits the hook's environment, so it sees the same auth + config.

## Claude Code

From this repository:

```bash
claude plugin marketplace add ./
claude plugin install bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin
```

Hooks load at session start, so restart Claude Code after install.

For the Claude Agent SDK:

```python
from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

options = ClaudeAgentOptions(
    plugins=[{"type": "local", "path": "./plugins/bigquery-agent-analytics-tracing"}],
    settings="./settings.local.json",
)
```

The plugin records these BQAA events:

| Claude hook | BQAA event |
| --- | --- |
| `UserPromptSubmit` | `LLM_REQUEST` |
| `Stop` | `LLM_RESPONSE` |
| `PreToolUse` | `TOOL_STARTING` |
| `PostToolUse` | `TOOL_COMPLETED` |
| `PermissionRequest` | `HITL_CONFIRMATION_REQUEST` |
| `Notification`, `SessionEnd` | `STATE_DELTA` |
| `SubagentStop` | child-agent `LLM_RESPONSE` |

## Codex CLI (codex exec only)

Codex CLI doesn't ship a hook system, but `codex exec --json` emits a
JSONL event stream. The `bqaa-codex` wrapper at
`scripts/bqaa_codex.py` runs `codex exec --json` as a subprocess,
maps each event to a BQAA row via the same spool/drainer pipeline as
the Claude Code hook adapter, and forwards Codex's agent text to your
stdout — so the wrapper is a drop-in for `codex exec`.

> **Scope:** this wrapper instruments `codex exec` (the non-interactive
> entrypoint). Interactive `codex` TUI sessions are **not** captured —
> there is no equivalent JSONL or hook surface in the TUI today. If
> Codex grows a runtime tracing callback, swap the wrapper for that.
> Codex plugins (`codex plugin marketplace`) package commands, not
> hooks, so they aren't a fit either.

```bash
# Where you used to run:
codex exec --skip-git-repo-check --sandbox read-only "list the files"

# Run instead:
python plugins/bigquery-agent-analytics-tracing/scripts/bqaa_codex.py \
  --skip-git-repo-check --sandbox read-only "list the files"

# Or alias it:
alias bqaa-codex="python /path/to/scripts/bqaa_codex.py"
bqaa-codex --skip-git-repo-check --sandbox read-only "list the files"
```

Event mapping:

| Codex event | BQAA event |
| --- | --- |
| `thread.started` | captured as `session_id` |
| `turn.started` | `LLM_REQUEST` (with the wrapper-captured prompt) |
| `item.started` (non-message) | `TOOL_STARTING` |
| `item.completed` (non-message) | `TOOL_COMPLETED` |
| `item.completed` (`agent_message`) | accumulated, echoed to stdout |
| `turn.completed` | `LLM_RESPONSE` (with `usage`) |

Rows are tagged `attributes.source = "codex_cli"` and
`attributes.writer.agent = "codex-cli"` (override `BQAA_AGENT_NAME`
to change). All other BQAA env vars work unchanged.

For schema-drift debugging, every row also carries an
`attributes.codex` block:

- `codex.version` — `codex --version` captured at wrapper init.
- `codex.raw_event_type` — the source event type (`turn.started`,
  `turn.completed`, `item.started`, `item.completed`).
- `codex.raw_item_type` — the underlying Codex item type for tool
  rows (`command_execution`, `agent_message`, `mcp_tool_call`, etc.).

### Prompt capture

The wrapper combines argv and stdin so `attributes.content.prompt`
matches what Codex actually sees:

- The trailing positional in argv is the argv prompt. The parser
  knows Codex's value-flags (`-c`, `-m`, `-s`, `-o`,
  `--output-last-message`, `--output-schema`, etc.) so it doesn't
  mistake a flag value for the prompt.
- If stdin is piped (non-TTY), the wrapper captures the first 1 MiB
  for the BQAA row but still passes the full stdin payload to Codex.
  When both argv and stdin are present, the wrapper records the
  prompt as `<argv>\n<stdin>...stdin payload...</stdin>` to mirror
  Codex's own `<stdin>` block convention.
- `BQAA_CODEX_PROMPT` is a final fallback when neither argv nor
  stdin yields a prompt.

### Other env vars

`BQAA_CODEX_BIN` lets you point at a non-`PATH` Codex install (the
wrapper invokes `codex --version` and `codex exec --json` against
this binary).

## Other Agents (direct SDK)

Codex packaging is in `.codex-plugin/plugin.json`, with an example
marketplace entry in `codex-marketplace.example.json`.

Codex runtimes without Claude-style hooks should call the SDK directly:

```python
from bqaa_tracing import BigQueryAgentAnalyticsLogger

logger = BigQueryAgentAnalyticsLogger()
logger.log_llm_request(
    prompt="Inspect this repo",
    session_id="session-1",
    invocation_id="turn-1",
    trace_id="0" * 32,
    span_id="1" * 16,
    agent="codex",
)
logger.log_llm_response(
    response="Done",
    session_id="session-1",
    invocation_id="turn-1",
    trace_id="0" * 32,
    span_id="1" * 16,
    agent="codex",
    model="gpt-5",
    usage_metadata={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    total_ms=1200,
)
```

When called from a long-lived Codex process, you may prefer the inline
write path: `export BQAA_DIRECT_WRITE=true`. Otherwise the same spool +
drainer pipeline is used.

Add `plugins/bigquery-agent-analytics-tracing/sdk/python` to `PYTHONPATH`,
or vendor the two SDK modules (`bqaa_tracing.py`, `bqaa_drain.py`) into
your agent runtime.

## OpenAI Agents SDK

The OpenAI Agents SDK supports custom trace exporters through
`TracingProcessor`. Register this plugin with `add_trace_processor()` when you
want to keep OpenAI's default exporter and also write BQAA rows:

```bash
pip install openai-agents google-cloud-bigquery
```

```python
from agents import Agent, Runner
from bqaa_openai_agents import add_bqaa_trace_processor

add_bqaa_trace_processor(agent_name="openai-agents")

agent = Agent(name="Assistant", instructions="Be concise.")
result = Runner.run_sync(agent, "Say hello")
```

`generation` spans become paired `LLM_REQUEST` / `LLM_RESPONSE` rows, and
`function` spans become paired `TOOL_STARTING` / `TOOL_COMPLETED` rows. Use
`agents.tracing.set_trace_processors([processor])` only when you intentionally
want to replace the SDK's default processors.

To smoke-test the processor without making a model call:

```bash
PYTHONPATH="plugins/bigquery-agent-analytics-tracing/sdk/python:$PYTHONPATH" \
python plugins/bigquery-agent-analytics-tracing/scripts/e2e_openai_agents_smoke.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset agent_analytics \
  --table agent_events \
  --location US
```

## Table Shape

Rows are written to `{project}.{dataset}.{table}` with the same columns
used by ADK BQAA:

`timestamp`, `event_type`, `agent`, `session_id`, `invocation_id`,
`user_id`, `trace_id`, `span_id`, `parent_span_id`, `content`,
`content_parts`, `attributes`, `latency_ms`, `status`, `error_message`,
`is_truncated`.

The table is auto-created on first write (day-partitioned on `timestamp`,
clustered on `event_type, agent, user_id`). Dataset auto-creation is off
by default; set `BQAA_AUTO_CREATE_DATASET=true` only when the identity
is allowed to create datasets.

## Writer attribution & adoption tracking

Every write carries a writer label so a dataset operator can attribute traces
back to this plugin without inspecting the agent's environment. ADK does the
same thing with `google-adk-bq-logger/<version>`; this plugin uses
`bqaa-coding-agent-plugin/<version>` by default.

The label appears in two places:

1. **`attributes.writer` on every row.** Visible from the events table
   itself, on both the Storage Write and the `insert_rows_json` paths.
   This is the primary surface for self-service adoption queries.
   Fields: `plugin`, `version`, `label`, `agent`, `mode`
   (`spool` / `direct` / `dry_run`).
2. **`AppendRowsRequest.trace_id`** when writing via the Storage Write API.
   This is request-level metadata recorded server-side by Google for
   diagnostics; it isn't surfaced as a column in the
   `INFORMATION_SCHEMA.WRITE_API_TIMELINE_BY_*` views, but it lets
   Google Cloud support attribute traffic back to this plugin when
   investigating throughput / quota issues.

Override the label per deployment with `BQAA_WRITER_LABEL` (e.g.
`bqaa-coding-agent-plugin/0.1.0/team-foo`) so multiple teams sharing one
dataset stay distinguishable. The override flows through to both surfaces.

### Adoption / usage queries

**Plugin adoption broken down by agent + mode + version** (works for any
write path):

```sql
SELECT
  JSON_VALUE(attributes, '$.writer.label')   AS writer_label,
  JSON_VALUE(attributes, '$.writer.plugin')  AS plugin,
  JSON_VALUE(attributes, '$.writer.version') AS plugin_version,
  JSON_VALUE(attributes, '$.writer.agent')   AS agent,
  JSON_VALUE(attributes, '$.writer.mode')    AS mode,
  COUNT(DISTINCT session_id) AS sessions,
  COUNT(DISTINCT user_id)    AS users,
  COUNT(*)                   AS events
FROM `your-project.your_dataset.agent_events`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
GROUP BY writer_label, plugin, plugin_version, agent, mode
ORDER BY events DESC
```

**Storage Write API volume on this dataset** (no writer breakdown — the
Storage Write API timeline view doesn't expose the trace_id column —
useful for sanity-checking that writes are flowing and for capacity
planning):

```sql
SELECT
  table_id,
  stream_type,
  error_code,
  SUM(total_rows) AS rows_written,
  SUM(total_requests) AS requests,
  SUM(total_input_bytes) AS input_bytes
FROM `region-us`.INFORMATION_SCHEMA.WRITE_API_TIMELINE_BY_PROJECT
WHERE start_timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)
  AND project_id = 'your-project'
  AND dataset_id = 'your_dataset'
GROUP BY table_id, stream_type, error_code
ORDER BY rows_written DESC
```

## Reliability

- **Hooks never block the agent.** The hook script takes at most
  `BQAA_HOOK_WAIT_SECONDS`, plus under a second when the agent is slow to
  send the payload or never closes stdin, and always exits 0 with no
  output. Normally you see the queue + spool + Popen cost (~5–20 ms) plus
  Python startup. If Python can't start (on macOS a hung `syspolicyd` can
  block launching a non-Apple interpreter for many minutes) or anything
  else stalls, a tool call pays at most the wait. Every hook except
  `SessionEnd` also has a 10 s `timeout` in `plugin.json` as a backstop
  (the default is 600 s).
- **Events apply in hook order.** The hook queues its event before it
  returns, and whichever `bqaa_hook.py` run takes the session's lock first
  applies all of that session's queued events, oldest first. A late
  interpreter can't apply its event after a newer one, so a `Stop` never
  misses its `UserPromptSubmit` and a `PostToolUse` never misses its
  `PreToolUse`. Events are stamped with the time their hook ran. The
  session comes from each whole payload's top-level `session_id`, so every
  run reads all queued payloads (normally only a handful). The lock files
  (`queue/.lock-00` to `.lock-63`, picked by session) are never removed, so
  two runs can't both hold a session's lock. Queue numbers are never
  reused (`queue/last` holds the highest one removed so far), so a run
  reading the queue in order can't find a newer event under a number it
  has passed. A payload Python can't parse (cut off, nested too deeply, or
  holding an integer too long to convert) is dropped with a log line and
  holds up nothing else. If no
  `bqaa_hook.py` run gets going for a session again, its queued events
  stay put until `BQAA_STATE_TTL_HOURS` purges them; past 10,000 queued
  events in all, hooks stop queueing new ones.
- **Hard network timeouts.** Every ADC lookup and BigQuery call, in the
  drainer and in direct-write mode, gives up after
  `BQAA_NETWORK_TIMEOUT_SECONDS` (default 30).
- **Single-writer drainer.** Multiple hook fires can't double-write
  because the drainer is gated by `fcntl.flock` on a pidfile. The
  drainer exits after `BQAA_DRAIN_IDLE_SECONDS` of empty polling; the
  next event respawns it.
- **Retries.** Transient `ServiceUnavailable`, `TooManyRequests`,
  `InternalServerError`, and timeout errors are retried with
  exponential backoff (matches ADK's `RetryConfig` defaults: 3 retries,
  1 s initial, 2× multiplier, 10 s cap). `insert_rows_json` attempts all
  carry the same insertIds (each row's content hash), so BigQuery drops a
  resent row it already has. A timed-out insert is never resent while it
  may still land: the drainer waits out the backoff for its result instead,
  and if it's still running after that, the batch is dead-lettered.
- **Delivery isn't exactly-once.** BigQuery's insertId dedupe is best
  effort and only holds for a short window. A batch dead-lettered after a
  timed-out insert may be in the table already. The Storage Write default
  stream is at-least-once: an append that timed out may have landed, so its
  retry, or the `insert_rows_json` fallback after it, can write those rows
  twice. A written-twice row is an exact copy, so for exact counts dedupe
  on `event_type`, `span_id` and `timestamp` in queries.
- **Dead-letter.** Permanently-failed rows move to
  `BQAA_SPOOL_DIR/dead-letter/` for manual inspection and replay.
- **Race-free state.** The per-session state file is read-modify-written
  under `fcntl.flock`. Per-tool span IDs and start times live in their
  own files keyed by `tool_use_id`, so concurrent `PreToolUse` fires
  can't clobber each other.
- **Bounded transcript reads.** `Stop` and `SubagentStop` stream the
  transcript with a `BQAA_TRANSCRIPT_MAX_BYTES` cap so multi-MB
  subagent transcripts don't blow up memory.

## Dry Run

```bash
export BQAA_DRY_RUN=true
```

In dry-run, rows are appended as JSONL to `BQAA_LOG_FILE`
(`/tmp/bqaa-agent-tracing.log` by default) instead of being spooled or
inserted. The drainer is not spawned.

## End-to-End BigQuery Smoke Test

Inserts one trace with four events and queries it back:

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/e2e_bigquery_smoke.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset agent_analytics \
  --table agent_events \
  --location US
```

Expected `event_types`: `LLM_REQUEST`, `TOOL_STARTING`, `TOOL_COMPLETED`,
`LLM_RESPONSE`.

The smoke script uses `BQAA_DIRECT_WRITE` semantics (synchronous insert)
so it can verify the data round-trip in a single process. Soft dep: the
`bq` CLI is convenient but not required — the script queries BigQuery
through the Python client.
