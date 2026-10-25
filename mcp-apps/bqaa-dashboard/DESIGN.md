# BQAA Dashboard — Design & Implementation

Interactive observability for the BigQuery Agent Analytics `agent_events`
table, delivered as **one server with three surfaces**: a standalone webapp, an
MCP App (interactive UI inside MCP hosts), and a plain MCP tool server for any
MCP client. Upstream design discussion:
[GoogleCloudPlatform/BigQuery-Agent-Analytics-SDK#396](https://github.com/GoogleCloudPlatform/BigQuery-Agent-Analytics-SDK/issues/396).

- Prior art targeted for parity: [Langfuse custom dashboards](https://langfuse.com/docs/metrics/features/custom-dashboards)
  (widget = measure × dimension × filters), [Arize dashboards](https://arize.com/dashboards/)
  (widget → trace drill-down), and the
  [Looker Agent Analytics block](https://marketplace.looker.com/marketplace/detail/agent_analytics)
  (curated views over `agent_events`).
- Differentiators: in-chat rendering (MCP Apps), BigQuery-local data
  ownership — dashboards, widgets, and traces read `agent_events` in place and
  never copy telemetry to a third-party service. The one qualified exception
  is the optional Ask path: questions, schema context, and query results flow
  through Google's Gemini Data Analytics service (still inside Google Cloud's
  processing boundary, but beyond BigQuery itself); strict BigQuery-only
  deployments disable it with `BQAA_CA_DISABLED=1`. Plus dry-run cost
  previews, evidence-cited root cause, and a conversational layer that works
  without any AI host.

## 1. Architecture

```
                    ┌───────────────────────────────────────────────┐
                    │  server.ts (Node + Express, Cloud Run)        │
 Browser ── GET / ──►  static UI bundle (dist/mcp-app.html)         │
 Browser ── /api/* ─►  dashboard / widget / trace / ask JSON        │
 MCP host ─ /mcp ───►  buildMcpServer() per request                 │
                    │   ├─ 9 tools (zod schemas)                    │
                    │   └─ ui://bqaa/dashboard.html resource        │
                    │                                               │
                    │  src/queries.ts   SQL contract (pure)         │
                    │  src/ca.ts        BQCA bridge (REST)          │
                    │  src/mock.ts      deterministic sample data   │
                    │  src/fakebq.ts    injectable test client      │
                    └───────────┬───────────────────┬───────────────┘
                                │ @google-cloud/bigquery (ADC)
                                ▼                   ▼
                        agent_events table   geminidataanalytics API
```

One deployment ↔ one table (`BQAA_PROJECT` / `BQAA_DATASET` / `BQAA_TABLE`).
Multi-tenancy is by deployment, which keeps every org's telemetry inside its
own project — a deliberate trade against SaaS-style multi-tenant serving.

### 1.1 The three surfaces

| Surface | Entry | Data path | Interactive UI |
|---|---|---|---|
| Standalone webapp | `GET /` | `GET /api/dashboard·widget·trace`, `POST /api/ask` | full (browser) |
| MCP App host (Claude, Goose, …) | `POST /mcp` | tools via host bridge (`app.callServerTool`) | full (sandboxed iframe via `ui://` resource) |
| Plain MCP client (Codex, Gemini CLI, Gemini Enterprise) | `POST /mcp` | tools only | text + structured content |

The UI is a single self-contained HTML bundle (Vite + `vite-plugin-singlefile`;
fonts inlined as data URIs) because MCP-App iframes run under a
deny-by-default CSP — no external origins, ever. The same bundle detects its
context at runtime: embedded (ext-apps bridge present) → tool calls through the
host; served over HTTP → `/api/*`; opened from `file://` → sample data.

## 2. MCP server design (`server.ts`)

Built on `@modelcontextprotocol/sdk` + `@modelcontextprotocol/ext-apps`.

- **Request-local servers.** `buildMcpServer()` constructs a fresh `McpServer`
  per `/mcp` POST and connects it to a stateless
  `StreamableHTTPServerTransport`. A shared singleton re-binds its transport on
  `connect()` and corrupts concurrent RPCs (live-reproduced during review), so
  per-request construction is a correctness requirement, not style.
- **Tools** (all inputs are zod schemas; all results carry a model-readable
  `content` text plus `structuredContent.data`):
  - `show_agent_dashboard(time_range_hours, agent?)` — declares
    `_meta.ui.resourceUri = "ui://bqaa/dashboard.html"` so MCP-Apps hosts
    render the dashboard in-conversation; returns a text summary + full payload.
  - `query_agent_metrics(...)` — same payload, no UI; used by the iframe for
    refresh/filtering and by models for text answers.
  - `query_widget(measure, dimension, filters…, dry_run?)` /
    `render_widget(...)` — one custom widget as data, or pushed into the UI.
    `dry_run: true` returns a BigQuery dry-run byte estimate instead of rows.
  - `ask_data(question, history?)` — conversational analytics (§4).
  - `get_trace(trace_id, time_range_hours)` — ordered trace reconstruction,
    with explicit truncation reporting past 500 events.
  - `render_trace(trace_id, time_range_hours)` — the same trace rendered as an
    interactive waterfall in MCP-App hosts, carrying its requested window. The
    app renders the FOCUSED span view (waterfall only, not the dashboard);
    tabs or Close return to the full dashboard. Spans with children collapse
    and expand on click; leaf tool calls expand an inline detail row.
  - `list_traces(time_range_hours, limit, errors_only, agent)` — summary rows
    for recent traces (start, duration, event/error counts, agents), newest
    first: the Traces explorer tab's data source. Click a row to dive into
    that trace's waterfall.
  - `list_error_traces(time_range_hours, limit)` — recent trace ids containing
    errors with sample messages; pairs with `get_trace` for evidence-cited
    root-cause ("the timeout is real: trace `ac99…`, TOOL_ERROR, 'upstream
    timeout'").
- **Resource**: `ui://bqaa/dashboard.html`, mime `text/html;profile=mcp-app`,
  served from the built bundle.

### 2.1 HTTP surface

`GET /` (UI shell) · `GET /api/dashboard` · `GET /api/widget` · `GET /api/trace`
· `POST /api/ask` · `POST /auth/login` · `GET /healthz` (liveness) ·
`GET /api/health` (readiness). Requests log as structured JSON.

## 3. The SQL contract (`src/queries.ts`)

Pure string builders — no I/O — so the metric contract is unit-testable and
shareable (eventually with the Looker block, per #396).

- **Producer-schema tolerance.** `agent_events` differs by producer: canonical
  ADK plugins write `model_version` / `prompt_token_count` /
  `candidates_token_count` and emit `LLM_ERROR` / `TOOL_ERROR` events; the
  Claude Code tracing plugin writes `model` / `prompt_tokens` /
  `completion_tokens` and marks rows with `status='ERROR'`. Every reader is a
  `COALESCE` over both spellings (`MODEL_EXPR`, `*_TOK_EXPR`).
- **One canonical error predicate.** `ERROR_EXPR = status='ERROR' OR
  ENDS_WITH(event_type,'_ERROR') OR error_message IS NOT NULL`, used by every
  surface (overview, timeseries, tools, models, widgets, error traces, and the
  client's trace highlighting) so error metrics cannot drift between panels.
- **Dashboard sections.** One query per panel (`SECTIONS`, currently 10:
  overview, prev_overview, timeseries, latency, tools, models, sessions, hitl,
  delegation, agents). Notable semantics:
  - `models` counts *attempts* (`LLM_RESPONSE + LLM_ERROR`) with an explicit
    `(unknown)` bucket for error events lacking a model attribute, and returns
    **exact token sums** (cost must never be average × attempts).
  - `delegation` deduplicates spans (`GROUP BY trace_id, span_id`) before the
    parent-child self-join — one delegation = one unique child span.
  - `sessions` aggregates whole sessions (model as a `STRING_AGG` label) and
    exposes `trace_ids` for drill-down.
  - `hitl` pairs both event spellings (`HITL_*_REQUEST` →
    `HITL_*_REQUEST_COMPLETED` and ADK v1's `HITL_*_COMPLETED`).
- **Widget contract** (versioned, `v: 1`): 15 whitelisted measures × 7
  dimensions × 4 parameterized filters. Specs select SQL fragments **by key**;
  user/model input only ever binds as query parameters (`@f_agent`, …) — never
  interpolated. Categorical dimensions clamp `LIMIT` to 100. The Explore tab's
  "Copy widget JSON" emits exactly the `query_widget` argument shape, so a
  copied widget is directly replayable by any MCP client.
- **Partition safety.** Every query carries `timestamp BETWEEN @start AND
  @end` — the table is partitioned on `timestamp` and must never full-scan.

## 4. Conversational layer — BigQuery Conversational Analytics (`src/ca.ts`)

The Ask feature makes the app conversational **without any AI host**: the
server bridges to the Gemini Data Analytics **stateless chat** API.

```
POST https://geminidataanalytics.googleapis.com/v1beta/projects/{p}/locations/global:chat
{
  parent, messages: [ ...bounded history..., { userMessage: { text: question } } ],
  inlineContext: {
    systemInstruction,                                  // teaches the agent_events schema
    options: { datasource: { bigQueryMaxBilledBytes } },// same cost boundary as the app
    datasourceReferences: { bq: { tableReferences: [{ projectId, datasetId, tableId }] } }
  }
}
```

- **Auth**: `google-auth-library` ADC (`cloud-platform` scope). Requires
  `geminidataanalytics.googleapis.com` enabled and
  `roles/geminidataanalytics.dataAgentStatelessUser` + BigQuery read on the
  caller (Cloud Run runtime SA in production).
- **Stateless by design**: inline context means zero provisioning and per-env
  table config; the trade-off is history is passed manually — `ask_data`
  accepts a bounded `history` (≤3 exchanges, length-capped) and both the Ask
  tab and MCP hosts forward it. Upgrading to persistent `dataAgents` +
  `conversations` is a contained change if server-side state or curated
  example queries are wanted later.
- **Response parsing** (`parseMessages`): the API streams a JSON array of
  system messages folded into one `AskResult`:
  `FINAL_RESPONSE` text → `answer`; `THOUGHT` titles → `steps` (progress
  transparency); `FOLLOWUP_QUESTIONS` → suggestion chips;
  `data.generatedSql` → `sql`; `data.result` → `schema` + `rows` (≤100).
- **Guardrails**: one 150 s deadline covering ADC token acquisition and the
  request itself, a 3-concurrent admission cap, and `bigQueryMaxBilledBytes`
  as a **per-generated-query** cap (CA may write and retry several queries per
  question — aggregate spend control belongs to BigQuery project/user quotas).
  `BQAA_CA_DISABLED=1` turns the Ask path off entirely.
- **Three doors, one brain**: MCP tool `ask_data`, HTTP `POST /api/ask`
  (webapp Ask tab), and mock mode (`mockAsk`) for tests/preview.

The `systemInstruction` is load-bearing: it describes the polymorphic JSON
columns (`content.$.tool`, `attributes.$.usage_metadata`, `latency_ms`), both
producer spellings, and the partition constraint — this is what makes the
generated SQL correct on the first attempt (verified against real data: e.g.
per-tool failure-rate analysis with LAX_STRING extraction, self-written).

## 5. Cost, safety, and reliability guardrails

| Concern | Mechanism |
|---|---|
| Query spend | `BQAA_MAX_BYTES_BILLED` is the budget for one refresh, split **exactly** across the section queries. BigQuery rejects `maximumBytesBilled` < 10 MiB, so the accepted minimum is `SECTIONS × 10,485,760` (enforced at startup and in `splitBudget`). Widget/trace/CA queries are capped by the same budget. |
| Runaway work | Global cap of 20 concurrent BigQuery jobs (fail-fast), 3 concurrent Ask requests; one absolute deadline (`BQAA_QUERY_TIMEOUT_MS`, default 90 s) covers the whole query lifecycle — client/ADC setup, job creation, polling, metadata — with **awaited, bounded job cancellation** before the slot is released. Dry runs go through the same admission and deadline. Client disconnects propagate as aborts that cancel per-request jobs. |
| Caching | 60 s bounded LRU (50 entries) with promise coalescing; **degraded (partial-failure) results are evicted immediately** so recovery is fast; failures are never cached. |
| Partial failure | Sections run under `Promise.allSettled`; healthy panels render, failed ones surface per-panel (`meta.section_errors`), in dependent KPIs as explicit "unavailable" states (never authoritative zeros), and in the model-facing summary. |
| Injection | SQL identifiers validated by regex at startup; all values bind as parameters; widget measures/dimensions/filters are whitelist-keyed; CSV cells neutralize spreadsheet formulas; DOM writes use `textContent`. |
| AuthN | Optional `BQAA_AUTH_TOKEN`: MCP clients send `Authorization: Bearer`; browsers exchange the token once at `POST /auth/login` for an HttpOnly `SameSite=Strict` cookie. Tokens are **never accepted in URLs** (MCP auth spec). |
| Origin policy | Trust is never derived from the requester-controlled `Host` header. Allowed origins are: the `BQAA_ALLOWED_ORIGINS` allowlist, the operator-configured `BQAA_CANONICAL_ORIGIN` (the service's own URL), and loopback origins for local development. CORS reflects only those. |
| Health | `/healthz` liveness; `/api/health` readiness proves BigQuery access via a cached zero-cost dry run (503 on failure). Readiness is deliberately unauthenticated (for load balancers) but **redacted** — backend detail is logged, never returned. |
| Truthfulness | Live-data failures keep last-known data with an explicit error banner; sample data only ever backs `file://` preview or explicit mock mode. |

## 6. UI implementation (`src/mcp-app.ts`, `src/styles.css`)

No framework — DOM + inline SVG (~2k lines), because the bundle must be a
single CSP-safe file and the chart set is small and bespoke.

- **Design system**: light/dark token pairs (CSS custom properties responding
  to both `prefers-color-scheme` and a host `data-theme` stamp), an embedded
  display face (Space Grotesk, OFL, inlined — external fonts are CSP-blocked),
  a persistent "pulse strip" (event volume with above-normal-error-day
  markers), stat tiles with sparklines and period-over-period delta chips.
- **Charts**: line (crosshair + keyboard-navigable tooltip, optional area
  wash), stacked columns (surface-gap segments, rounded caps), horizontal
  bars, tables. Every chart has an accessible "Show data" disclosure and CSV
  export; legends whenever ≥2 series. Chart colors come from a
  CVD-validated palette; series identity is never color-alone.
- **Views** (8): Overview, Ask, Latency, Tokens, Tools, Cost (client-side
  price book in `localStorage` × exact token sums), Agents (HITL +
  delegation), Explore (widget builder with dry-run estimate). Trace
  drill-down renders a **waterfall** (`src/spans.ts` reconstructs spans from
  start/complete event pairs with completion-only latency fallback and
  parent-chain depth; unit-tested) plus the flat event log.
- **State discipline** (hardened across three review rounds):
  - every async path publishes through a guard — refresh generation +
    `AbortController` (dashboard), operation sequence + abort (Explore), trace
    generation + window invalidation + abort (drill-down); host-pushed results
    invalidate in-flight refreshes;
  - the **effective time window** is first-class state (`currentHours()`):
    non-preset windows from `render_widget` pushes stay in force until the
    user picks a preset;
  - re-render-safe state: open trace card, disclosure open/closed sets, Ask
    input draft, and the auth prompt all survive resize/refresh re-renders;
  - responsive containment: `viewBox` + `max-width` guards, `ResizeObserver`
    re-measure, internally-scrolling tab row and tables — zero document
    overflow verified at 320/375/768 px.
- **Shareable URLs**: `#view=…&range=…&agent=…` (state, not secrets).

## 7. Testing strategy (`tests/`, `npm test` — 146 tests)

- **SQL contract tests** (`queries.test.mjs`): section coverage, partition
  predicates, parameterization/injection resistance, producer-alias coverage,
  canonical `ERROR_EXPR` on every surface, delegation dedup, session
  aggregation, widget whitelisting + limit clamps, budget-split boundary at
  BigQuery's 10 MiB floor.
- **Integration tests** (`server.test.mjs`): spawn the real server —
  HTTP + MCP JSON-RPC surfaces, invalid arguments, bearer/cookie auth,
  URL-token rejection, Origin policy incl. same-origin POSTs, config
  validation fail-fast, concurrent MCP calls (request-local server proof),
  bundled-resource serving, ask history.
- **Production-branch tests** via `BQAA_FAKE_BQ` (`src/fakebq.ts`), an
  injectable BigQuery fake (test-only: refused in production builds, and every
  payload it produces is labeled as synthetic in `meta.source`) with scenarios `ok` / `fail_one` / `stall`:
  executes the real query pipeline — byte accounting + caching, partial-result
  eviction, deadline → job cancellation → slot release, and billed-byte
  validation at job creation.
- `pretest` builds `dist/` so the resource test asserts the **bundled**
  artifact, not the dev shell. Known gap (accepted follow-up): no automated
  browser suite yet — narrow-width and race checks were verified with live
  headless runs.

## 8. Build & deployment

- Multi-stage `Dockerfile`: build stage bundles the UI and compiles the server
  (esbuild, deps external); runtime is `node:22-slim`, production deps only,
  non-root `USER node`. `.dockerignore` keeps the context minimal.
- Cloud Run: private (`--no-allow-unauthenticated`) is the documented default;
  public demo posture combines `--allow-unauthenticated` with app-level
  guards on a test dataset only. `/healthz` is GFE-intercepted on `run.app`,
  hence `/api/health`.
- Host registration: Claude/Cowork custom connector (renders the MCP App UI),
  Codex CLI (`[mcp_servers.bqaa] url = ".../mcp"`), Gemini CLI
  (`mcpServers.httpUrl`), Gemini Enterprise (custom MCP server data store —
  org-backed project required; auth options there are none / OAuth / GCP SA
  token, so a static bearer deployment doesn't fit GE).

## 9. Known follow-ups (deliberate, reviewed)

Typed MCP output schemas (today `z.unknown()`); per-identity rate limiting;
bounded client Ask transcript; automated browser/host test suite; OAuth
protected-resource discovery; saved multi-widget dashboards & layout
persistence; alerts/anomaly detection (BigQuery ML `AI.FORECAST` /
`ML.DETECT_ANOMALIES`); dropped-event (orphaned span) analysis; materialized
rollups for sub-second refreshes; context-graph integration; sharing one
versioned metric contract with the Looker block (#396).
