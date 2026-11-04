# BigQuery Agent Analytics Skill

A lightweight, LLM-discoverable skill for analyzing [Google ADK BigQuery Agent Analytics](https://adk.dev/integrations/bigquery-agent-analytics/) data. Built to the [Agent Skills specification](https://agentskills.io/specification).

No server, no MCP — just a prompt skill with pre-built CTEs, query templates, and a structured analysis methodology that any AI coding assistant can use.

## Quick Start

### 1. Set up your environment

```bash
export GCP_PROJECT_ID="your-project-id"
export BQ_DATASET="your-dataset-id"
export BQ_TABLE="agent_events"          # optional, defaults to agent_events
pip install google-cloud-bigquery
```

## Tracing Plugin

This repo also includes `plugins/bigquery-agent-analytics-tracing`, a Claude
Code/Codex-oriented tracing bridge that emits rows in the same BigQuery Agent
Analytics `agent_events` format analyzed by this skill.

- Claude Code: install from the repo-local `.claude-plugin/marketplace.json`.
- Codex/other agents: use the `.codex-plugin` package metadata and the Python
  SDK at `plugins/bigquery-agent-analytics-tracing/sdk/python/bqaa_tracing.py`.
- The plugin maps coding-agent hooks to BQAA events such as `LLM_REQUEST`,
  `LLM_RESPONSE`, `TOOL_STARTING`, and `TOOL_COMPLETED`.

See
`plugins/bigquery-agent-analytics-tracing/README.md` for setup and SDK examples.

## Tracing Mod (coding-agent CLI with mod support, v2.1.287+)

`bigquery-agent-analytics-mod` writes the same `agent_events` rows from
inside the host coding-agent CLI as a mod (a JavaScript/TypeScript hooks
module) instead of settings-hook scripts. Its hooks never wait on BigQuery:
they queue rows in memory and a background writer streams them with
`insertAll`, with retries, a local dead-letter directory and `/bqaa-backfill`.
It also records each model request with its token usage and latency, and
subagents with their own spans. Use it or the tracing plugin against a table,
not both.

Active releases and marketplace distribution are maintained in the official repository:
[`GoogleCloudPlatform/BigQuery-Agent-Analytics-Plugins`](https://github.com/GoogleCloudPlatform/BigQuery-Agent-Analytics-Plugins).

Install from the official `bqaa-tracing` marketplace:

```bash
claude plugin marketplace add GoogleCloudPlatform/BigQuery-Agent-Analytics-Plugins
claude plugin install bigquery-agent-analytics-mod@bqaa-tracing \
  --config project=my-gcp-project --config dataset=agent_analytics
```

Alternatively, install directly via `--marketplace`:

```bash
claude plugin install bigquery-agent-analytics-mod \
  --marketplace GoogleCloudPlatform/BigQuery-Agent-Analytics-Plugins \
  --config project=my-gcp-project --config dataset=agent_analytics
```

See the [BigQuery-Agent-Analytics-Plugins repository](https://github.com/GoogleCloudPlatform/BigQuery-Agent-Analytics-Plugins)
for quickstart walkthroughs, configuration reference, and setup scripts.

### 2. Install in your AI assistant

**Claude Code** — add to `CLAUDE.md` or copy to `.claude/skills/`:
```
For agent analytics, use the skill at: bigquery-agent-analytics-skill/SKILL.md
```

**Cursor** — reference in `.cursorrules`:
```
@bigquery-agent-analytics-skill/SKILL.md
```

**Clients without progressive disclosure** — compile first:
```bash
python bigquery-agent-analytics-skill/scripts/compile.py
```
Then reference `bigquery-agent-analytics-skill/compiled_skill.md`.

### 3. Ask questions

```
"What's the error rate for my agents this week?"
"Which tool has the highest failure rate?"
"Compare latency across models for the last 30 days"
"Show me the delegation flow for trace abc123"
```

## Skill Structure

```
bigquery-agent-analytics-skill/           # Skill directory (matches name field)
├── SKILL.md                              # Core instructions (<100 lines)
├── references/                           # Loaded on demand by the LLM
│   ├── schema.md                         # Full table schema + nested paths
│   ├── ctes.md                           # 5 mandatory base CTEs
│   ├── queries.md                        # 8 ready-to-run analytics queries
│   ├── failure-patterns.md               # 11 diagnostic signal/cause/action mappings
│   └── examples.md                       # 3 complete prompt-to-execution walkthroughs
├── assets/
│   └── mermaid-template.md               # Mermaid diagram template for delegation flows
└── scripts/
    ├── run_bq.py                         # Query executor with dry-run + auto env injection
    └── compile.py                        # Inlines everything into compiled_skill.md
```

## Progressive Disclosure

The skill is structured for efficient context usage per the [Agent Skills spec](https://agentskills.io/specification#progressive-disclosure):

| Layer | What loads | Token cost |
|-------|-----------|------------|
| **Metadata** | `name` + `description` from frontmatter | ~100 tokens |
| **Instructions** | Full `SKILL.md` body (gotchas, execution, methodology, output rules) | ~1,500 tokens |
| **References** | Individual files from `references/` — only when needed | On demand |

The LLM reads `SKILL.md` on activation and loads reference files only when it needs them (e.g., `references/ctes.md` when writing a query, `references/failure-patterns.md` when diagnosing results).

## Cost Safety

Every query goes through a mandatory dry-run before execution:

1. `run_bq.py --dry-run` estimates bytes scanned via the BigQuery API without running the job
2. `run_bq.py --max-gb` sets a hard billing limit (default 1 GB)
3. `SKILL.md` instructs the LLM to refuse execution if the dry-run exceeds the limit

## Configuration

| Environment Variable | Description | Required | Default |
|---------------------|-------------|----------|---------|
| `GCP_PROJECT_ID` | Your GCP project ID | Yes | — |
| `BQ_DATASET` | BigQuery dataset name | Yes | — |
| `BQ_TABLE` | Table name | No | `agent_events` |
| `GOOGLE_APPLICATION_CREDENTIALS` | Path to service account JSON (if not using ADC) | No | — |

`run_bq.py` auto-replaces `{PROJECT}`, `{DATASET}`, `{TABLE}` in SQL from these env vars. The LLM never needs to ask the user for their config.

## License

MIT
