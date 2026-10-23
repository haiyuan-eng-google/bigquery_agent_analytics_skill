# BigQuery Agent Analytics Tracing User Guide

This guide covers how users get the tracing plugin, configure BigQuery, and
start emitting rows for each supported producer.

## Supported Channels

| Channel | Distribution | Runtime integration |
| --- | --- | --- |
| Claude Code | Claude plugin marketplace in this repo | Native Claude hook plugin |
| Claude Agent SDK (Python) | Same Claude plugin in this repo, loaded via `ClaudeAgentOptions` | Native Claude hook plugin in the SDK-spawned `claude` subprocess |
| Codex CLI | Wrapper command in this repo | `codex exec --json` JSONL stream |
| OpenAI Agents SDK | Python module in this repo | `TracingProcessor` via `add_trace_processor()` |
| Other Python agents | Python SDK module in this repo | Direct logger calls |

## 1. Prepare BigQuery

Use an existing ADK BigQuery Agent Analytics table, or let the logger create
the table on first write.

Required:

```bash
export BQAA_PROJECT_ID="your-gcp-project"
export BQAA_DATASET="agent_analytics"
export BQAA_TABLE="agent_events"
export BQAA_LOCATION="US"
```

Authentication:

```bash
gcloud auth application-default login
```

Or use a service account:

```bash
export GOOGLE_APPLICATION_CREDENTIALS="/path/to/service-account.json"
```

The identity needs dataset write access. For auto-create behavior, it also
needs permission to create tables, and optionally datasets if
`BQAA_AUTO_CREATE_DATASET=true`.

### Easiest path: `/bigquery-agent-analytics-tracing:bqaa-setup` in Claude Code

After the plugin is installed and Claude Code is restarted, just type
`/bigquery-agent-analytics-tracing:bqaa-setup` (or describe the goal in plain English: "set up BQAA
tracing", "why aren't my BQAA rows showing up", "configure agent
analytics for this project"). The plugin's `bqaa-setup` skill walks
Claude through the same dry-run → approval → execute → verify flow as
the manual script below, plus persists the `BQAA_*` env into
`.claude/settings.local.json` so the next session traces automatically.

The skill explicitly does **not** run `gcloud auth application-default
login` for the user (that's a browser OAuth flow no agent can
complete); it pauses and asks the user to run it, then resumes.

### Manual: dry-run first, --execute when the plan looks right

Automatic bootstrap, safe dry-run first.

For local Claude Code / SDK / Codex on a developer workstation, the
recommended principal is **the developer's own Google identity** — the BQAA
hooks read ADC, and ADC == that same identity, so the runtime "just works"
without service-account impersonation:

```bash
python -m pip install google-cloud-bigquery

python plugins/bigquery-agent-analytics-tracing/scripts/setup_gcp_prereqs.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --table "$BQAA_TABLE" \
  --location "$BQAA_LOCATION" \
  --principal "user:$(gcloud config get-value account)"
```

If the printed plan is correct, apply it by appending `--execute`.

A **service account** (`--service-account bqaa-writer`) is the right choice
for shared workstations, server-side / CI agents, or org policies that
centralize credentials. The script will create the SA and grant it IAM, but
**you must wire the runtime to actually use the SA** — creation alone does
not redirect the hooks. The BQAA hooks call `google-cloud-bigquery` directly
via ADC; they do not consult gcloud config. Whatever routes the SA into
runtime has to route it into **ADC**. Pick one:

```bash
# Option A — SA impersonation via ADC (recommended, no JSON key):
gcloud auth application-default login \
  --impersonate-service-account=bqaa-writer@${BQAA_PROJECT_ID}.iam.gserviceaccount.com
# The caller needs roles/iam.serviceAccountTokenCreator on the SA.

# Option B — service-account JSON key (least preferred; rotate on schedule):
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/bqaa-writer.json

# Option C — Workload Identity Federation (for CI / unattended; no key file):
#   https://cloud.google.com/iam/docs/workload-identity-federation
#   GOOGLE_APPLICATION_CREDENTIALS points at the WIF credential-config JSON.
```

Without one of those, the BQAA hooks will keep running under whoever is
logged in via ADC and the SA grants are dead weight.

> **Do not substitute `gcloud config set auth/impersonate_service_account`.**
> That setting only redirects gcloud / bq CLI commands you run yourself. It
> does **not** change which identity the BQAA Python hooks use. Setting it
> alone passes the bootstrap script's gcloud subcommands but leaves the
> hooks writing under the wrong identity. It's complementary to Option A,
> not a substitute.

The bootstrap command enables the required BigQuery APIs, creates the dataset
and `agent_events` table if missing, and grants the runtime principal the
narrow BigQuery roles below. Add `--runtime-auto-create-dataset` only when
the runtime itself will run with `BQAA_AUTO_CREATE_DATASET=true`.

### Preflight + unattended (agent) runs

Every invocation prints a one-screen preflight summary so an agent can see
what credentials it would use:

```
Preflight:
  ADC: OK — ADC token reachable
  gcloud CLI auth: OK — active account my-account@example.com
  gcloud config project: my-gcp-project (matches --project)
```

Three lines, three independent surfaces. ADC backs the
google-cloud-bigquery Python client (used by `--create-dataset` /
`--create-table`); gcloud CLI auth backs every `gcloud` and `bq`
subprocess (API enable, IAM grants, service-account create); the
project line is a sanity check against `--project`. On most local-dev
setups the ADC and CLI accounts are the same identity, but on agent
boxes / CI they often diverge — if these two emails don't match and
you intend to grant IAM to one of them, double-check before
`--execute`.

With `--execute`, the script hard-fails before touching anything when
any of these credential surfaces are missing for steps that need them:

- `gcloud` is not on `PATH`:

  ```text
  gcloud is required for --execute but is not available.
  Install the Google Cloud SDK and re-run.
  ```

- Application Default Credentials are not configured (only required
  when the plan calls google-cloud-bigquery directly — i.e.
  `--create-dataset` / `--create-table` is in the plan):

  ```text
  Application Default Credentials are not configured but this plan
  calls google-cloud-bigquery directly.
  Run: gcloud auth application-default login
  (or set GOOGLE_APPLICATION_CREDENTIALS to a service-account JSON
  key) and re-run.
  ```

- gcloud CLI auth is not configured (required when the plan shells
  out to `gcloud` or `bq` — i.e. API enable, IAM grants, service-
  account create):

  ```text
  gcloud CLI auth is not configured but this plan shells out to
  gcloud / bq.
  Run: gcloud auth login (and `gcloud config set account ACCOUNT`
  if multiple identities are listed) and re-run.
  ADC alone is not enough: gcloud subcommands ignore ADC and use
  the active CLI account.
  ```

In most local-dev setups the same human identity backs both ADC and
the gcloud CLI; on agent boxes and CI they are often separate, which
is why the script reports them independently. In dry-run, all three
conditions are reported but the plan is still printed so an agent
can pre-stage everything before the human runs the OAuth flow.

For unattended runs (Codex, Claude SDK, CI), pass `--non-interactive`. The
SA path is typical here — once the SA exists and its impersonation/key is
wired (see options A/B/C above), the runtime is identity-stable across
machines:

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/setup_gcp_prereqs.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --service-account bqaa-writer \
  --non-interactive --execute
```

`--non-interactive` injects `--quiet` into every `gcloud` and `bq`
subcommand so a confirmation prompt can never block the bootstrap.
`gcloud config get-value project` mismatches with `--project` are
warnings, not errors — every subcommand passes `--project` explicitly,
so the explicit flag wins.

Required APIs:

```bash
gcloud services enable bigquery.googleapis.com bigquerystorage.googleapis.com iam.googleapis.com \
  --project "$BQAA_PROJECT_ID"
```

`iam.googleapis.com` is only needed when the bootstrap command creates a
service account; the BigQuery APIs are needed for the tracing writer paths.

Recommended IAM by deployment mode:

| Mode | Required roles |
| --- | --- |
| Existing dataset and table | `roles/bigquery.dataEditor` on the dataset |
| Auto-create table in an existing dataset | `roles/bigquery.dataEditor` on the dataset |
| Auto-create dataset and table in the bootstrap script | bootstrap identity needs create permissions; runtime principal needs `roles/bigquery.dataEditor` on the dataset after creation |
| Runtime auto-creates dataset/table | `roles/bigquery.user` on the project plus `roles/bigquery.dataEditor` after the dataset exists, or `roles/bigquery.admin` for bootstrap-only setup |
| Run verification SQL or smoke scripts that query the table | `roles/bigquery.jobUser` on the project plus dataset read/write access |

Manual IAM equivalent:

```bash
SERVICE_ACCOUNT="bqaa-writer@${BQAA_PROJECT_ID}.iam.gserviceaccount.com"

# Existing dataset/table, or auto-create table inside an existing dataset:
bq add-iam-policy-binding \
  -d \
  "${BQAA_PROJECT_ID}:${BQAA_DATASET}" \
  --member "serviceAccount:${SERVICE_ACCOUNT}" \
  --role roles/bigquery.dataEditor

# Needed for `bq query` verification and smoke scripts that query BigQuery:
gcloud projects add-iam-policy-binding "$BQAA_PROJECT_ID" \
  --member "serviceAccount:${SERVICE_ACCOUNT}" \
  --role roles/bigquery.jobUser

# Only if BQAA_AUTO_CREATE_DATASET=true in the runtime:
gcloud projects add-iam-policy-binding "$BQAA_PROJECT_ID" \
  --member "serviceAccount:${SERVICE_ACCOUNT}" \
  --role roles/bigquery.user
```

Keep `roles/bigquery.admin` out of steady-state agent runtimes. It is useful
for first-time bootstrap in a dev project, but the runtime writer only needs
the narrower roles above.

## 2. Install Runtime Dependencies

Minimum:

```bash
pip install google-cloud-bigquery
```

Recommended for async Storage Write API draining:

```bash
pip install google-cloud-bigquery-storage pyarrow
```

Optional channel dependencies:

```bash
pip install openai-agents       # only for OpenAI Agents SDK tracing
```

If the agent host should use a specific Python:

```bash
export BQAA_PYTHON="/path/to/python"
```

## 3. Configure Common Tracing Options

```bash
export BQAA_WRITER_LABEL="bqaa-coding-agent-plugin/0.1.0/team-name"
export BQAA_USER_ID="$USER"
export BQAA_AUTO_CREATE_TABLE="true"
export BQAA_AUTO_CREATE_DATASET="false"
```

Default write mode is local spool plus async drainer. Use direct writes only
for one-process smoke tests or debugging:

```bash
export BQAA_DIRECT_WRITE="true"
```

Dry-run mode writes JSON rows to the local log file instead of BigQuery:

```bash
export BQAA_DRY_RUN="true"
export BQAA_LOG_FILE="/tmp/bqaa-agent-tracing.log"
```

## 4. Claude Code

Distribution channel: repo-local Claude plugin marketplace.

Install:

```bash
claude plugin marketplace add ./
claude plugin install bigquery-agent-analytics-tracing@bigquery-agent-analytics-plugin
```

Restart Claude Code after installation. Hooks load at session start.

Verify the hooks stay fast and fail open (no GCP access needed):

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/test_hook_nonblocking.py
```

Verify live:

1. Start a new Claude Code session.
2. Run a prompt that uses a tool.
3. Query BigQuery:

```sql
SELECT event_type, agent, JSON_VALUE(attributes, '$.writer.label') AS writer_label
FROM `your-project.agent_analytics.agent_events`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
  AND JSON_VALUE(attributes, '$.custom_tags.assistant') = 'claude_code'
ORDER BY timestamp DESC
LIMIT 20;
```

## 5. Claude Agent SDK (Python)

Distribution channel: same Claude plugin in this repo, loaded into the
`claude` subprocess that the Agent SDK spawns. This means SDK-driven
agents emit the same Claude Code BQAA rows (writer.agent =
`claude-code` by default, override via `BQAA_AGENT_NAME`) without any
new code paths to maintain.

Install:

```bash
pip install claude-agent-sdk
```

Load the plugin from this repo via `ClaudeAgentOptions.plugins`:

```python
import asyncio
import os
from pathlib import Path

from claude_agent_sdk import ClaudeAgentOptions, ClaudeSDKClient

PLUGIN_DIR = Path("/path/to/plugins/bigquery-agent-analytics-tracing").resolve()


async def main() -> None:
    options = ClaudeAgentOptions(
        cwd="/your/project/path",
        env={
            **os.environ,
            "BQAA_PROJECT_ID": "your-gcp-project",
            "BQAA_DATASET": "agent_analytics",
            "BQAA_TABLE": "agent_events",
            "BQAA_LOCATION": "US",
            # Distinguish SDK-driven traffic from Claude Code TUI traffic:
            "BQAA_AGENT_NAME": "claude-agent-sdk",
            "BQAA_WRITER_LABEL": "bqaa-coding-agent-plugin/0.1.0/sdk-app-name",
        },
        permission_mode="bypassPermissions",
        plugins=[{"type": "local", "path": str(PLUGIN_DIR)}],
    )
    async with ClaudeSDKClient(options=options) as client:
        await client.query("Read README.md and summarize it in one sentence.")
        async for _message in client.receive_response():
            pass


asyncio.run(main())
```

Either of these load mechanisms works. Pick `plugins=` for a typed,
declarative API; pick `extra_args=` if you're forwarding arbitrary
flags to the underlying `claude` binary already:

```python
# Equivalent — passes --plugin-dir to the spawned claude binary.
options = ClaudeAgentOptions(
    cwd="/your/project/path",
    env={...},  # same env block as above
    extra_args={"plugin-dir": str(PLUGIN_DIR)},
)
```

The plugin loads when the SDK spawns its `claude` subprocess, so
hooks fire from the very first turn of the SDK session — no restart
semantics to worry about.

Verify:

```sql
SELECT event_type, agent, JSON_VALUE(attributes, '$.writer.agent') AS writer_agent,
       JSON_VALUE(attributes, '$.writer.label') AS writer_label
FROM `your-project.agent_analytics.agent_events`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
  AND JSON_VALUE(attributes, '$.writer.agent') = 'claude-agent-sdk'
ORDER BY timestamp DESC
LIMIT 20;
```

Caveats:

- The SDK runs `claude` under the hood, so `claude` must be on `PATH`
  (or set via `ClaudeAgentOptions.cli_path`).
- `ClaudeAgentOptions.env` must include `BQAA_*` — the SDK does not
  inherit the parent process env unless you pass it through.
- For multi-turn SDK sessions, each turn produces its own
  `LLM_REQUEST` / `LLM_RESPONSE` row pair under the same Claude
  `session_id`, so trace continuity holds across turns.

## 6. Codex CLI

Distribution channel: wrapper command in this repo.

The wrapper supports `codex exec` only. Interactive `codex` TUI sessions are
not captured because Codex CLI does not currently expose a runtime hook surface
for those sessions. Codex plugin marketplace packages commands; it does not add
Claude-style runtime hooks.

Use:

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/bqaa_codex.py \
  --sandbox read-only \
  "list the files"
```

Alias:

```bash
alias bqaa-codex="python /path/to/plugins/bigquery-agent-analytics-tracing/scripts/bqaa_codex.py"
bqaa-codex --sandbox read-only "summarize this repo"
```

Stdin works:

```bash
printf 'summarize README.md\n' | bqaa-codex -
```

When argv and stdin are both present, the BQAA `LLM_REQUEST` prompt records:

```text
<argv prompt>
<stdin>
<stdin payload>
</stdin>
```

The BQAA prompt capture is capped at 1 MiB, but the wrapper still forwards the
full stdin payload to Codex.

Verify wrapper edge cases:

```bash
python plugins/bigquery-agent-analytics-tracing/scripts/test_codex_wrapper.py
```

Verify live:

```sql
SELECT
  event_type,
  JSON_VALUE(content, '$.tool') AS tool,
  JSON_VALUE(attributes, '$.source') AS source,
  JSON_VALUE(attributes, '$.codex.version') AS codex_version,
  JSON_VALUE(attributes, '$.codex.raw_event_type') AS raw_event_type,
  JSON_VALUE(attributes, '$.writer.label') AS writer_label
FROM `your-project.agent_analytics.agent_events`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 1 HOUR)
  AND JSON_VALUE(attributes, '$.source') = 'codex_cli'
ORDER BY timestamp DESC
LIMIT 20;
```

## 7. OpenAI Agents SDK

Distribution channel: Python module in this repo.

Add the SDK path:

```bash
export PYTHONPATH="/path/to/plugins/bigquery-agent-analytics-tracing/sdk/python:$PYTHONPATH"
```

Register the processor:

```python
from agents import Agent, Runner
from bqaa_openai_agents import add_bqaa_trace_processor

add_bqaa_trace_processor(agent_name="openai-agents")

agent = Agent(name="Assistant", instructions="Be concise.")
result = Runner.run_sync(agent, "Say hello")
```

`add_bqaa_trace_processor()` uses `agents.tracing.add_trace_processor()` so the
default OpenAI exporter remains installed. Use
`agents.tracing.set_trace_processors([processor])` only when you intentionally
want to replace the default processors.

Smoke test without a model call:

```bash
PYTHONPATH="/path/to/plugins/bigquery-agent-analytics-tracing/sdk/python:$PYTHONPATH" \
python plugins/bigquery-agent-analytics-tracing/scripts/e2e_openai_agents_smoke.py \
  --project "$BQAA_PROJECT_ID" \
  --dataset "$BQAA_DATASET" \
  --table "$BQAA_TABLE" \
  --location "$BQAA_LOCATION"
```

## 8. Other Python Agents

Distribution channel: direct Python SDK module in this repo.

```python
from bqaa_tracing import BigQueryAgentAnalyticsLogger

logger = BigQueryAgentAnalyticsLogger()
logger.log_llm_request(
    prompt="Inspect this repo",
    session_id="session-1",
    invocation_id="turn-1",
    trace_id="0" * 32,
    span_id="1" * 16,
    agent="custom-agent",
)
logger.log_llm_response(
    response="Done",
    session_id="session-1",
    invocation_id="turn-1",
    trace_id="0" * 32,
    span_id="1" * 16,
    agent="custom-agent",
    model="custom-model",
    usage_metadata={"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15},
    total_ms=1200,
)
```

## 9. Adoption Query

Use this query to see all supported producers in one table:

```sql
SELECT
  JSON_VALUE(attributes, '$.writer.agent') AS agent,
  JSON_VALUE(attributes, '$.source') AS source,
  JSON_VALUE(attributes, '$.writer.label') AS writer_label,
  COUNT(DISTINCT session_id) AS sessions,
  COUNT(DISTINCT user_id) AS users,
  COUNT(*) AS events
FROM `your-project.agent_analytics.agent_events`
WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 30 DAY)
  AND JSON_VALUE(attributes, '$.writer.plugin') = 'bqaa-coding-agent-plugin'
GROUP BY agent, source, writer_label
ORDER BY events DESC;
```

## 10. Troubleshooting

- No rows: check `BQAA_PROJECT_ID`, `BQAA_DATASET`, credentials, and
  `BQAA_DRY_RUN`. Without a project and dataset (and outside dry-run) the
  hooks exit without starting Python, so nothing is logged either.
- Tool calls stall: each hook returns within about
  `BQAA_HOOK_WAIT_SECONDS` (default 1) no matter what Python, auth or
  BigQuery are doing. Multi-minute stalls on every tool call mean an older
  copy of the plugin is installed; update it and start a new session.
- Rows arrive late: while Python can't start, events wait in
  `BQAA_STATE_DIR/queue/`. The session's next hook whose Python gets going
  writes them, in order and with the times their hooks ran.
- Rows stuck in spool: check `BQAA_SPOOL_DIR/dead-letter/` and
  `BQAA_LOG_FILE`.
- Claude Code rows missing: restart Claude Code after installing the
  plugin.
- Claude Agent SDK rows missing: confirm `BQAA_*` env vars are passed
  via `ClaudeAgentOptions.env` (the SDK does not inherit parent env)
  and that `plugins=[{"type":"local","path":...}]` (or
  `extra_args={"plugin-dir":...}`) points at this repo's plugin
  directory.
- Codex TUI missing: use the `bqaa_codex.py` wrapper with
  `codex exec`; the TUI is outside this integration.
- OpenAI Agents rows missing: confirm `openai-agents` is installed
  and `add_bqaa_trace_processor()` runs before `Runner.run*()`.
