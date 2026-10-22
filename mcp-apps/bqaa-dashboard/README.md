# BQAA Dashboard — MCP App

Interactive Langfuse/Arize-style observability dashboard for the
[BigQuery Agent Analytics](https://github.com/GoogleCloudPlatform/BigQuery-Agent-Analytics-SDK)
`agent_events` table, rendered **inside MCP hosts** (Claude / Claude Desktop,
VS Code Copilot, Goose, …) via the
[MCP Apps extension](https://modelcontextprotocol.io/extensions/apps/overview).

Design/discussion: [GoogleCloudPlatform/BigQuery-Agent-Analytics-SDK#396](https://github.com/GoogleCloudPlatform/BigQuery-Agent-Analytics-SDK/issues/396)
· Detailed design & implementation: [DESIGN.md](./DESIGN.md)

Ask the host *"show me my agent dashboard"* — or open the URL in a browser —
and get nine views:

| View | Contents |
|---|---|
| **Overview** | stat tiles with period-over-period deltas and sparklines; events & errors over time; LLM p50/p95 latency over time |
| **Ask** | natural-language questions answered by BigQuery Conversational Analytics (answer + generated SQL + rows + follow-ups) |
| **Latency** | p95 by agent × model bars; avg / TTFT / p50 / p95 / p99 table |
| **Tokens** | prompt vs completion stacked columns; model comparison; top sessions by tokens with trace drill-down |
| **Tools** | succeeded/failed calls per tool; failure-rate and latency table |
| **Cost** | editable per-model price book × exact token sums; cost over time and by model |
| **Agents** | HITL requests/completions/wait times; agent delegation map |
| **Traces** | trace explorer: recent traces (errors-only toggle) with click-through to an expandable span waterfall |
| **Explore** | custom widget builder (measure × dimension × filters) with dry-run scan estimates |

Global filters (time-range presets + agent) re-query BigQuery through the
iframe → host `tools/call` bridge. Every chart has hover/keyboard tooltips and
an accessible "Show data" table; top sessions drill down to a trace
**waterfall** (spans as duration bars, nested by parent/child, errors
highlighted) with the flat event log behind a disclosure (`get_trace`).
Light and dark themes are both first-class.

## Tools exposed

- `show_agent_dashboard(time_range_hours, agent?)` — renders the UI (declares
  `_meta.ui.resourceUri = ui://bqaa/dashboard.html`) and returns a text summary
  plus the full structured payload.
- `query_agent_metrics(time_range_hours, agent?)` — same payload, no UI; used by
  the dashboard for refresh/filtering and usable by the model for text answers.
- `query_widget` / `render_widget(measure, dimension, filters…, dry_run?)` — one
  custom widget as data, or rendered interactively in the host UI. The Explore
  tab's "Copy widget JSON" emits exactly this argument shape.
- `ask_data(question)` — open-ended questions via BigQuery Conversational
  Analytics (plans, writes and runs SQL; ~30–60 s).
- `get_trace(trace_id, time_range_hours)` — ordered trace reconstruction for
  drill-down; reports truncation when a trace exceeds 500 events.
- `render_trace(trace_id, time_range_hours)` — the same trace rendered
  interactively: the waterfall opens in the dashboard UI inside the host.
- `list_traces(time_range_hours, limit, errors_only, agent)` — recent trace
  summaries (duration, events, errors, agents) for the Traces explorer; click
  through with `render_trace`
- `list_error_traces(time_range_hours, limit)` — recent trace ids with errors,
  for evidence-cited root-cause analysis.

## Run it

```bash
npm install
npm run build            # bundles the UI into dist/mcp-app.html (single file)

# Mock mode — no GCP needed (also the default when BQAA_PROJECT is unset):
BQAA_MOCK=1 npm run serve

# Against BigQuery (uses Application Default Credentials):
BQAA_PROJECT=my-project BQAA_DATASET=agent_analytics BQAA_TABLE=agent_events npm run serve
```

The MCP endpoint is `http://localhost:3001/mcp` (override with `PORT`).

| Env var | Default | Meaning |
|---|---|---|
| `BQAA_PROJECT` | — | GCP project (unset ⇒ mock mode) |
| `BQAA_DATASET` | `agent_analytics` | Dataset containing agent_events |
| `BQAA_TABLE` | `agent_events` | Event table |
| `BQAA_MOCK` | — | `1` forces deterministic sample data |
| `BQAA_MAX_BYTES_BILLED` | `2000000000` | Bytes-billed budget for **one dashboard refresh** (split across its queries; also caps Conversational Analytics queries). Minimum = sections × 10 MiB (currently 11 × 10 MiB = 115,343,360 bytes) — BigQuery requires ≥10 MiB per query |
| `BQAA_DEFAULT_HOURS` | `168` | Default lookback window in hours (1–2160); validated at startup |
| `BQAA_QUERY_TIMEOUT_MS` | `90000` | Application deadline per BigQuery query; the job is cancelled and its slot released on expiry |
| `BQAA_AUTH_TOKEN` | — | If set, `/mcp` and `/api/*` require `Authorization: Bearer <token>`; browsers sign in via `POST /auth/login`, which sets an HttpOnly cookie (tokens are never accepted in URLs) |
| `BQAA_ALLOWED_ORIGINS` | — | Comma-separated Origin allowlist (or `*`). Trust is never derived from the Host header |
| `BQAA_CANONICAL_ORIGIN` | — | The service's own public origin (e.g. `https://app.run.app`) — granted the same-origin exemption; loopback origins are always allowed for local dev |
| `BQAA_CA_DISABLED` | — | `1` disables the Ask path for strict BigQuery-only deployments (Conversational Analytics processes questions/results inside Google Cloud but beyond BigQuery) |
| `PORT` | `3001` | HTTP port |
| `BQAA_HOST` | `127.0.0.1` (dev) / `0.0.0.0` (production builds) | Bind address — local live mode is loopback-only by default |

Guardrails: read-only parameterized `SELECT`s only, a mandatory `timestamp`
predicate so the partitioned table is never full-scanned, a per-refresh
`maximumBytesBilled` budget, a 60 s result cache with concurrent-request
coalescing, and partial-failure handling (one failed panel query is reported in
`meta.section_errors` instead of blanking the dashboard, and dependent KPIs
show an explicit unavailable state). A global cap bounds concurrent BigQuery
jobs and the result cache is a bounded LRU. The footer shows bytes scanned per
refresh. `GET /healthz` is liveness; `GET /api/health` is readiness and proves
BigQuery access with a cached dry run (503 when the backend is unreachable);
it is unauthenticated by design (load balancers) and redacted — backend detail
is logged, never returned. Requests are logged as structured JSON.

### Connect to Claude

```bash
npx cloudflared tunnel --url http://localhost:3001
```

Add the generated URL as a custom connector (Settings → Connectors → Add custom
connector), then ask Claude to show your agent dashboard.

### Deploy to Cloud Run

Private (IAM-authenticated) deployment is the default posture:

```bash
gcloud run deploy bqaa-dashboard --source . --region us-central1 \
  --no-allow-unauthenticated \
  --set-env-vars "BQAA_PROJECT=<project>,BQAA_DATASET=agent_analytics,BQAA_TABLE=agent_events"
```

Grant the runtime service account `roles/bigquery.jobUser` and
`roles/bigquery.dataViewer` (or dataset-scoped read access). Reach a private
service through an identity-aware proxy / `gcloud run services proxy`, or grant
`roles/run.invoker` to specific members.

**After the first deploy**, set the canonical origin so browser POSTs from the
deployed page itself are trusted (Origin checks never trust the Host header):

```bash
gcloud run services update bqaa-dashboard --region us-central1 \
  --set-env-vars "BQAA_CANONICAL_ORIGIN=https://<your-service>.run.app"
```

For a **demo on a test dataset only**, you can expose it publicly — combine
`--allow-unauthenticated` with the app-level guards:

```bash
gcloud run deploy bqaa-dashboard --source . --region us-central1 \
  --allow-unauthenticated \
  --set-env-vars "BQAA_PROJECT=<project>,BQAA_DATASET=<demo_dataset>,BQAA_TABLE=agent_events,BQAA_AUTH_TOKEN=<random-token>,BQAA_ALLOWED_ORIGINS=*"
```

The `https://….run.app/mcp` URL can then be added as a custom connector in any
MCP host (send the token as an `Authorization: Bearer` header); browsers sign
in once via the token prompt.
Anyone with the URL + token can query the configured table's aggregates and
traces — never point a public deployment at production telemetry.

### Test without a host

- `ext-apps` basic-host: `SERVERS='["http://localhost:3001/mcp"]' npm start`
  from `ext-apps/examples/basic-host`.
- Standalone preview: open `dist/mcp-app.html` directly in a browser — it
  detects it has no host and renders the sample dataset (`#latency`, `#tokens`,
  `#tools` hashes select the initial tab).

## Tests

```bash
npm test
```

Runs the SQL contract tests (schema aliases for both producers, `LLM_ERROR` /
`TOOL_ERROR` inclusion, partition predicates, parameterization) and an
integration suite that boots the server in mock mode and exercises `/healthz`,
`/`, `/api/dashboard`, `/api/trace`, the MCP JSON-RPC surface, invalid
arguments, bearer auth, the Origin allowlist, and startup config validation.

## Layout

```
server.ts        MCP server: tools + ui:// resource + auth/origin/budget guards
src/queries.ts   SQL contract (pure builders — unit-testable, shareable)
mcp-app.html     UI shell (design system in src/styles.css)
src/mcp-app.ts   Charts (inline SVG), tooltips, filters, drill-down, host bridge
src/mock.ts      Deterministic sample data (server mock mode + file:// preview)
src/types.ts     Shared payload types
tests/           Contract + integration tests (`npm test`)
```

## Credits

UI type: [Space Grotesk](https://fonts.google.com/specimen/Space+Grotesk) (OFL), embedded in the bundle so it renders under the MCP-app CSP.
