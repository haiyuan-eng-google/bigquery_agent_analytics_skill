// SQL layer for the BQAA dashboard — pure string builders, no I/O.
// Kept separate from server.ts so contract tests can assert the SQL without
// touching BigQuery, and so the metric contract can eventually be shared with
// the Looker block (see upstream issue #396).

import type { Granularity, WidgetSpec } from "./types.js";

// The agent_events schema varies by producer. Canonical ADK plugins write
// `model_version` / `*_token_count` and emit LLM_ERROR / TOOL_ERROR events;
// the Claude Code tracing plugin writes `model` / `prompt_tokens` /
// `completion_tokens` and marks completed events with status='ERROR'.
// Every query reads both spellings and both failure encodings.
export const MODEL_EXPR =
  "COALESCE(JSON_VALUE(attributes, '$.model'), JSON_VALUE(attributes, '$.model_version'))";
export const PROMPT_TOK_EXPR =
  "COALESCE(JSON_VALUE(attributes, '$.usage_metadata.prompt_tokens'), JSON_VALUE(attributes, '$.usage_metadata.prompt_token_count'))";
export const COMPLETION_TOK_EXPR =
  "COALESCE(JSON_VALUE(attributes, '$.usage_metadata.completion_tokens'), JSON_VALUE(attributes, '$.usage_metadata.candidates_token_count'))";
export const TOTAL_TOK_EXPR =
  "COALESCE(JSON_VALUE(attributes, '$.usage_metadata.total_tokens'), JSON_VALUE(attributes, '$.usage_metadata.total_token_count'))";

export const SECTIONS = [
  "overview",
  "prev_overview",
  "timeseries",
  "latency",
  "tools",
  "models",
  "sessions",
  "hitl",
  "delegation",
  "agents",
  "cost_buckets",
] as const;
export type Section = (typeof SECTIONS)[number];

const LATENCY_EXPR = "CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64)";
// #1(r17): the producer can emit LLM_RESPONSE rows with status='ERROR' or an
// error_message — those are FAILED attempts, not successful responses.
// Success metrics (response counts, latency populations) use this null-safe
// predicate; token SUMS deliberately stay over ALL response rows because
// billed tokens are billed whether or not the response succeeded.
export const SUCCESSFUL_LLM_RESPONSE_EXPR =
  "(event_type = 'LLM_RESPONSE' AND COALESCE(status, 'OK') != 'ERROR' AND error_message IS NULL)";
const LLM_LATENCY_EXPR = `IF(${SUCCESSFUL_LLM_RESPONSE_EXPR}, ${LATENCY_EXPR}, NULL)`;

// Canonical error predicate (SDK contract): an event is an error if its type
// is *_ERROR, its status says so, or it carries an error message. Every
// surface (overview, timeseries, tools, models, widgets, error traces) must
// use this one definition so metrics cannot drift.
export const ERROR_EXPR =
  "(status = 'ERROR' OR ENDS_WITH(event_type, '_ERROR') OR error_message IS NOT NULL)";

// BigQuery rejects maximumBytesBilled below 10 MiB, so a valid refresh budget
// must give every query at least that much. The split is exact — no padding —
// so the aggregate can never exceed the configured budget, and budgets too
// small to satisfy the per-query minimum are rejected outright.
export const BQ_MIN_BYTES_PER_QUERY = 10_485_760; // 10 MiB, BigQuery's floor

export function splitBudget(totalBytes: number, parts: number): number {
  if (parts <= 0) throw new Error("parts must be positive");
  const per = Math.floor(totalBytes / parts);
  if (per < BQ_MIN_BYTES_PER_QUERY) {
    throw new Error(
      `Budget ${totalBytes} splits to ${per} bytes/query across ${parts} queries — below BigQuery's ${BQ_MIN_BYTES_PER_QUERY}-byte minimum for maximumBytesBilled`,
    );
  }
  return per;
}

// ------------------------------------------------------------ widget contract
// The Langfuse-style widget model: measure × dimension × filters. Every entry
// is a whitelisted SQL fragment — specs select by KEY, so user/model input is
// never interpolated into SQL (filters bind as query parameters).

// #1(r19): every measure declares the dimensions and filters its event
// POPULATION can answer — the Cartesian product was advertising combinations
// (p95 LLM latency × tool × status=ERROR) that scan real bytes and return
// only nulls, because LLM latency lives on successful LLM_RESPONSE rows that
// carry no tool and no error status. The shared validator rejects
// incompatible specs BEFORE any dry run or execution, on every surface.
const ALL_DIMS = ["time", "agent", "model", "tool", "user", "status", "event_type"];
const ALL_FILTERS = ["agent", "model", "tool", "status"];
const LLM_DIMS = ["time", "agent", "model", "user", "status", "event_type"];
const LLM_FILTERS = ["agent", "model", "status"];
const OK_LLM_DIMS = ["time", "agent", "model", "user"]; // successful responses: one status, one event type
const OK_LLM_FILTERS = ["agent", "model"];
const TOOL_DIMS = ["time", "agent", "tool", "user", "status", "event_type"];
const TOOL_FILTERS = ["agent", "tool", "status"];

export interface WidgetMeasure {
  label: string;
  sql: string;
  unit: "count" | "pct" | "ms" | "tokens";
  dimensions: string[];
  filters: string[];
}

export function widgetSpecError(spec: { measure: string; dimension: string; filters?: object }): string | null {
  const m = WIDGET_MEASURES[spec.measure];
  if (!m) return `Unknown measure: ${spec.measure}`;
  if (!m.dimensions.includes(spec.dimension)) {
    return `Measure "${spec.measure}" cannot be grouped by "${spec.dimension}" — its event population supports: ${m.dimensions.join(", ")}`;
  }
  for (const [key, value] of Object.entries(spec.filters ?? {})) {
    if (value == null || value === "") continue;
    if (!m.filters.includes(key)) {
      return `Measure "${spec.measure}" cannot be filtered by "${key}" — its event population supports: ${m.filters.join(", ") || "(no filters)"}`;
    }
  }
  return null;
}

export const WIDGET_MEASURES: Record<string, WidgetMeasure> = {
  events: { label: "Events", sql: "COUNT(*)", unit: "count", dimensions: ALL_DIMS, filters: ALL_FILTERS },
  errors: { label: "Errors", sql: `COUNTIF(${ERROR_EXPR})`, unit: "count", dimensions: ALL_DIMS, filters: ALL_FILTERS },
  error_rate_pct: {
    label: "Error rate %",
    sql: `ROUND(SAFE_DIVIDE(COUNTIF(${ERROR_EXPR}), COUNT(*)) * 100, 2)`,
    unit: "pct",
    dimensions: ALL_DIMS,
    filters: ALL_FILTERS,
  },
  sessions: { label: "Sessions", sql: "COUNT(DISTINCT session_id)", unit: "count", dimensions: ALL_DIMS, filters: ALL_FILTERS },
  users: { label: "Users", sql: "COUNT(DISTINCT user_id)", unit: "count", dimensions: ALL_DIMS, filters: ALL_FILTERS },
  // #3(r15): "LLM calls" means ATTEMPTS everywhere — responses + errors —
  // matching the model-comparison view. Token/latency averages keep their
  // response-only denominators (an errored call has neither).
  llm_calls: { label: "LLM calls", sql: "COUNTIF(event_type IN ('LLM_RESPONSE', 'LLM_ERROR'))", unit: "count", dimensions: LLM_DIMS, filters: LLM_FILTERS },
  avg_latency_ms: { label: "Avg LLM latency", sql: `ROUND(AVG(${LLM_LATENCY_EXPR}), 0)`, unit: "ms", dimensions: OK_LLM_DIMS, filters: OK_LLM_FILTERS },
  p50_latency_ms: {
    label: "p50 LLM latency",
    sql: `APPROX_QUANTILES(${LLM_LATENCY_EXPR}, 100)[OFFSET(50)]`,
    unit: "ms",
    dimensions: OK_LLM_DIMS,
    filters: OK_LLM_FILTERS,
  },
  p95_latency_ms: {
    label: "p95 LLM latency",
    sql: `APPROX_QUANTILES(${LLM_LATENCY_EXPR}, 100)[OFFSET(95)]`,
    unit: "ms",
    dimensions: OK_LLM_DIMS,
    filters: OK_LLM_FILTERS,
  },
  avg_ttft_ms: {
    label: "Avg time to first token",
    sql: `ROUND(AVG(IF(${SUCCESSFUL_LLM_RESPONSE_EXPR}, CAST(JSON_VALUE(latency_ms, '$.time_to_first_token_ms') AS FLOAT64), NULL)), 0)`,
    unit: "ms",
    dimensions: OK_LLM_DIMS,
    filters: OK_LLM_FILTERS,
  },
  prompt_tokens: {
    label: "Prompt tokens",
    sql: `SUM(IF(event_type = 'LLM_RESPONSE', COALESCE(CAST(${PROMPT_TOK_EXPR} AS INT64), 0), 0))`,
    unit: "tokens",
    dimensions: LLM_DIMS,
    filters: LLM_FILTERS,
  },
  completion_tokens: {
    label: "Completion tokens",
    sql: `SUM(IF(event_type = 'LLM_RESPONSE', COALESCE(CAST(${COMPLETION_TOK_EXPR} AS INT64), 0), 0))`,
    unit: "tokens",
    dimensions: LLM_DIMS,
    filters: LLM_FILTERS,
  },
  total_tokens: {
    label: "Total tokens",
    sql: `SUM(IF(event_type = 'LLM_RESPONSE', COALESCE(CAST(${PROMPT_TOK_EXPR} AS INT64), 0) + COALESCE(CAST(${COMPLETION_TOK_EXPR} AS INT64), 0), 0))`,
    unit: "tokens",
    dimensions: LLM_DIMS,
    filters: LLM_FILTERS,
  },
  tool_calls: { label: "Tool calls", sql: "COUNTIF(event_type IN ('TOOL_COMPLETED', 'TOOL_ERROR'))", unit: "count", dimensions: TOOL_DIMS, filters: TOOL_FILTERS },
  tool_failures: {
    label: "Tool failures",
    sql: `COUNTIF(event_type IN ('TOOL_COMPLETED', 'TOOL_ERROR') AND ${ERROR_EXPR})`,
    unit: "count",
    dimensions: TOOL_DIMS,
    filters: TOOL_FILTERS,
  },
  // #1(r19): REAL tool-latency measures — the advertised "p95 latency by tool
  // for errors" is answerable by the TOOL event population, which carries
  // latency on completions and errors alike
  tool_avg_latency_ms: {
    label: "Avg tool latency",
    sql: `ROUND(AVG(IF(event_type IN ('TOOL_COMPLETED', 'TOOL_ERROR'), ${LATENCY_EXPR}, NULL)), 0)`,
    unit: "ms",
    dimensions: TOOL_DIMS,
    filters: TOOL_FILTERS,
  },
  tool_p95_latency_ms: {
    label: "p95 tool latency",
    sql: `APPROX_QUANTILES(IF(event_type IN ('TOOL_COMPLETED', 'TOOL_ERROR'), ${LATENCY_EXPR}, NULL), 100)[OFFSET(95)]`,
    unit: "ms",
    dimensions: TOOL_DIMS,
    filters: TOOL_FILTERS,
  },
};

export const WIDGET_DIMENSIONS: Record<string, { label: string; sql: string; time?: boolean }> = {
  time: { label: "Time", sql: "", time: true }, // resolved with granularity
  agent: { label: "Agent", sql: "agent" },
  model: { label: "Model", sql: MODEL_EXPR },
  tool: { label: "Tool", sql: "JSON_VALUE(content, '$.tool')" },
  user: { label: "User", sql: "user_id" },
  status: { label: "Status", sql: "status" },
  event_type: { label: "Event type", sql: "event_type" },
};

const WIDGET_FILTER_SQL: Record<string, string> = {
  agent: "agent = @f_agent",
  model: `${MODEL_EXPR} = @f_model`,
  tool: "JSON_VALUE(content, '$.tool') = @f_tool",
  // #3(r20): "status" filtering means the CANONICAL error contract — a
  // TOOL_ERROR row with a NULL status column is an error and must match
  // status=ERROR. Raw column equality missed every such row.
  status: "__CANONICAL_STATUS__", // resolved in buildWidgetSql, no parameter
};

const STATUS_FILTER_SQL: Record<string, string> = {
  ERROR: `(${ERROR_EXPR})`,
  // #2(r21): GoogleSQL three-valued logic — NOT(NULL) is NULL, so a normal
  // event with a NULL status column matched NEITHER filter. COALESCE makes
  // OK the exact complement: OK + ERROR = the whole population.
  OK: `NOT COALESCE((${ERROR_EXPR}), FALSE)`,
};

export interface BuiltWidget {
  sql: string;
  filterParams: Record<string, string>; // @f_* params (start/end/agent bind separately)
}

export function buildWidgetSql(table: string, spec: WidgetSpec): BuiltWidget {
  const compat = widgetSpecError(spec); // #1(r19): reject before ANY execution
  if (compat) throw new Error(compat);
  const measure = WIDGET_MEASURES[spec.measure];
  if (!measure) throw new Error(`Unknown measure: ${spec.measure}`);
  const dimension = WIDGET_DIMENSIONS[spec.dimension];
  if (!dimension) throw new Error(`Unknown dimension: ${spec.dimension}`);

  const where = ["timestamp BETWEEN @start AND @end"];
  const filterParams: Record<string, string> = {};
  for (const [key, value] of Object.entries(spec.filters ?? {})) {
    if (value == null || value === "") continue;
    const clause = WIDGET_FILTER_SQL[key];
    if (!clause) throw new Error(`Unknown filter: ${key}`);
    if (key === "status") {
      const canonical = STATUS_FILTER_SQL[String(value)];
      if (!canonical) throw new Error(`Status filter accepts OK or ERROR, got: ${String(value).slice(0, 40)}`);
      where.push(canonical);
      continue;
    }
    where.push(clause);
    filterParams[`f_${key}`] = String(value).slice(0, 200);
  }

  let dimSql: string;
  let orderBy: string;
  let limit: number;
  if (dimension.time) {
    const g = spec.granularity === "hour" ? "HOUR" : "DAY";
    dimSql = `FORMAT_TIMESTAMP('%FT%TZ', TIMESTAMP_TRUNC(timestamp, ${g}))`;
    orderBy = "dim ASC";
    limit = 2200; // ≥ 90 days of hourly buckets
  } else {
    dimSql = dimension.sql;
    orderBy = "value DESC";
    const requested = Number.isInteger(spec.limit) ? (spec.limit as number) : 20;
    limit = Math.min(100, Math.max(1, requested));
  }

  const sql = `
    SELECT ${dimSql} AS dim, ${measure.sql} AS value
    FROM ${table}
    WHERE ${where.join(" AND ")}
    GROUP BY dim
    ORDER BY ${orderBy}
    LIMIT ${limit}`;
  return { sql, filterParams };
}

export interface DashboardSqlOptions {
  table: string; // fully qualified, backtick-quoted
  granularity: Granularity;
  agentFilter: boolean;
}

function whereClause(agentFilter: boolean): string {
  // The time predicate is mandatory: the table is partitioned on `timestamp`.
  return `timestamp BETWEEN @start AND @end${agentFilter ? " AND agent = @agent" : ""}`;
}

// #1(r22): the query fetches CAP+1 rows so truncation is a FACT, not an
// inference — a complete result of exactly CAP rows stays trusted, and an
// overflowing one is flagged explicitly on every surface (UI, HTTP, MCP)
// via applyCostBucketBound.
export const COST_BUCKETS_ROW_LIMIT = 30000;

// #4(r24): the model breakdown is bounded the same way — producer-controlled
// model_id values must not be able to exhaust server or browser memory. The
// query fetches CAP+1 so overflow is MEASURED, and a truncated breakdown
// makes model comparison and the price book unavailable rather than silently
// dropping tail identity (which would misprice cost).
export const MODELS_ROW_LIMIT = 200;

export function applyModelBound<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  return rows.length > MODELS_ROW_LIMIT ? { rows: rows.slice(0, MODELS_ROW_LIMIT), truncated: true } : { rows, truncated: false };
}

export function applyCostBucketBound<T>(rows: T[]): { rows: T[]; truncated: boolean } {
  return rows.length > COST_BUCKETS_ROW_LIMIT
    ? { rows: rows.slice(0, COST_BUCKETS_ROW_LIMIT), truncated: true }
    : { rows, truncated: false };
}

export function buildDashboardSql(opts: DashboardSqlOptions): Record<Section, string> {
  const T = opts.table;
  const G = opts.granularity === "hour" ? "HOUR" : "DAY";
  const W = whereClause(opts.agentFilter);

  const overviewSql = `
    SELECT
      COUNT(*) AS total_events,
      COUNTIF(${ERROR_EXPR}) AS errors,
      ROUND(SAFE_DIVIDE(COUNTIF(${ERROR_EXPR}), COUNT(*)) * 100, 2) AS error_rate_pct,
      COUNT(DISTINCT session_id) AS sessions,
      COUNT(DISTINCT agent) AS agents,
      COUNT(DISTINCT user_id) AS users,
      APPROX_QUANTILES(CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64), 100)[OFFSET(95)] AS p95_latency_ms,
      FORMAT_TIMESTAMP('%FT%TZ', MAX(timestamp)) AS last_event_ts
    FROM ${T} WHERE ${W}`;

  return {
    overview: overviewSql,
    // identical shape over the preceding window (@start/@end bind differently)
    prev_overview: overviewSql,

    timeseries: `
    SELECT
      FORMAT_TIMESTAMP('%FT%TZ', TIMESTAMP_TRUNC(timestamp, ${G})) AS ts,
      COUNT(*) AS events,
      COUNTIF(${ERROR_EXPR}) AS errors,
      COUNTIF(event_type IN ('LLM_RESPONSE', 'LLM_ERROR')) AS llm_calls, -- attempts (#3-r15)
      COUNTIF(${SUCCESSFUL_LLM_RESPONSE_EXPR}) AS llm_responses, -- successful only (#1-r17)
      COALESCE(SUM(IF(event_type = 'LLM_RESPONSE',
        COALESCE(CAST(${PROMPT_TOK_EXPR} AS INT64), 0), 0)), 0) AS prompt_tokens,
      COALESCE(SUM(IF(event_type = 'LLM_RESPONSE',
        COALESCE(CAST(${COMPLETION_TOK_EXPR} AS INT64), 0), 0)), 0) AS completion_tokens,
      -- #1(r18): SUCCESSFUL-response token sums — the per-response average's
      -- numerator. The billed sums above keep cost truth; a failed response
      -- may bill tokens but contributes to no success average.
      COALESCE(SUM(IF(${SUCCESSFUL_LLM_RESPONSE_EXPR},
        COALESCE(CAST(${PROMPT_TOK_EXPR} AS INT64), 0), 0)), 0) AS ok_prompt_tokens,
      COALESCE(SUM(IF(${SUCCESSFUL_LLM_RESPONSE_EXPR},
        COALESCE(CAST(${COMPLETION_TOK_EXPR} AS INT64), 0), 0)), 0) AS ok_completion_tokens,
      -- #2(r19): the average's denominator counts responses that actually
      -- REPORTED token usage — a producer omitting usage metadata must not
      -- deflate the average
      COUNTIF(${SUCCESSFUL_LLM_RESPONSE_EXPR}
        AND COALESCE(CAST(${PROMPT_TOK_EXPR} AS INT64), CAST(${COMPLETION_TOK_EXPR} AS INT64)) IS NOT NULL) AS token_samples,
      APPROX_QUANTILES(IF(${SUCCESSFUL_LLM_RESPONSE_EXPR},
        CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64), NULL), 100)[OFFSET(50)] AS p50_latency_ms,
      APPROX_QUANTILES(IF(${SUCCESSFUL_LLM_RESPONSE_EXPR},
        CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64), NULL), 100)[OFFSET(95)] AS p95_latency_ms
    FROM ${T} WHERE ${W}
    GROUP BY ts ORDER BY ts ASC`,

    latency: `
    WITH llm_responses AS (
      SELECT
        agent,
        ${MODEL_EXPR} AS model_id,
        CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64) AS total_latency_ms,
        CAST(JSON_VALUE(latency_ms, '$.time_to_first_token_ms') AS FLOAT64) AS ttft_ms
      FROM ${T}
      WHERE ${SUCCESSFUL_LLM_RESPONSE_EXPR} AND ${W}
    )
    SELECT
      agent, model_id,
      COUNT(*) AS calls,
      -- #2(r19): AVG ignores NULLs, so aggregate weighting must use the
      -- populations the averages actually describe, not the row count
      COUNT(total_latency_ms) AS latency_samples,
      COUNT(ttft_ms) AS ttft_samples,
      ROUND(AVG(total_latency_ms), 0) AS avg_total_ms,
      ROUND(AVG(ttft_ms), 0) AS avg_ttft_ms,
      APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(50)] AS p50_total_ms,
      APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(95)] AS p95_total_ms,
      APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(99)] AS p99_total_ms
    FROM llm_responses
    GROUP BY agent, model_id
    ORDER BY p95_total_ms DESC
    LIMIT 30`,

    tools: `
    WITH tool_calls AS (
      SELECT
        JSON_VALUE(content, '$.tool') AS tool_name,
        JSON_VALUE(content, '$.tool_origin') AS tool_origin,
        CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64) AS tool_latency_ms,
        ${ERROR_EXPR} AS failed
      FROM ${T}
      WHERE event_type IN ('TOOL_COMPLETED', 'TOOL_ERROR') AND ${W}
    )
    SELECT
      tool_name, tool_origin,
      COUNT(*) AS total_calls,
      COUNTIF(failed) AS failures,
      ROUND(SAFE_DIVIDE(COUNTIF(failed), COUNT(*)) * 100, 2) AS fail_rate_pct,
      ROUND(AVG(tool_latency_ms), 0) AS avg_latency_ms,
      APPROX_QUANTILES(tool_latency_ms, 100)[OFFSET(95)] AS p95_latency_ms
    FROM tool_calls
    GROUP BY tool_name, tool_origin
    ORDER BY total_calls DESC
    LIMIT 30`,

    // Failed model calls are separate LLM_ERROR events in the canonical ADK
    // schema; the call population is attempts = responses + errors, and
    // latency/token averages come from successful responses only (their
    // columns are NULL on error rows, which AVG ignores).
    models: `
    WITH llm_events AS (
      SELECT
        ${MODEL_EXPR} AS model_id,
        ${ERROR_EXPR} AS failed,
        IF(event_type = 'LLM_RESPONSE', CAST(${PROMPT_TOK_EXPR} AS INT64), NULL) AS prompt_tokens,
        IF(event_type = 'LLM_RESPONSE', CAST(${COMPLETION_TOK_EXPR} AS INT64), NULL) AS completion_tokens,
        -- #1(r18): averages describe SUCCESSFUL responses; sums stay billed
        IF(${SUCCESSFUL_LLM_RESPONSE_EXPR}, CAST(${PROMPT_TOK_EXPR} AS INT64), NULL) AS ok_prompt_tokens,
        IF(${SUCCESSFUL_LLM_RESPONSE_EXPR}, CAST(${COMPLETION_TOK_EXPR} AS INT64), NULL) AS ok_completion_tokens,
        IF(${SUCCESSFUL_LLM_RESPONSE_EXPR}, CAST(${TOTAL_TOK_EXPR} AS INT64), NULL) AS ok_total_tokens,
        IF(${SUCCESSFUL_LLM_RESPONSE_EXPR},
          CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64), NULL) AS total_latency_ms,
        IF(${SUCCESSFUL_LLM_RESPONSE_EXPR},
          CAST(JSON_VALUE(latency_ms, '$.time_to_first_token_ms') AS FLOAT64), NULL) AS ttft_ms
      FROM ${T}
      WHERE event_type IN ('LLM_RESPONSE', 'LLM_ERROR') AND ${W}
    )
    SELECT
      COALESCE(model_id, '(unknown)') AS model_id,
      COUNT(*) AS calls,
      ROUND(SAFE_DIVIDE(COUNTIF(failed), COUNT(*)) * 100, 2) AS error_rate_pct,
      COALESCE(SUM(prompt_tokens), 0) AS total_prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS total_completion_tokens,
      ROUND(AVG(ok_total_tokens), 0) AS avg_total_tokens,
      ROUND(AVG(ok_prompt_tokens), 0) AS avg_prompt_tokens,
      ROUND(AVG(ok_completion_tokens), 0) AS avg_completion_tokens,
      ROUND(AVG(total_latency_ms), 0) AS avg_latency_ms,
      APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(50)] AS p50_latency_ms,
      APPROX_QUANTILES(total_latency_ms, 100)[OFFSET(95)] AS p95_latency_ms,
      ROUND(AVG(ttft_ms), 0) AS avg_ttft_ms
    FROM llm_events
    GROUP BY model_id
    ORDER BY calls DESC
    LIMIT ${MODELS_ROW_LIMIT + 1}`,

    // #3(r19): EXACT cost buckets — billed tokens per (bucket, model), so the
    // client prices each bucket with its own model mix instead of smearing
    // the window total by token volume (which reversed day-to-day
    // comparisons when the mix shifted).
    // #3(r21): REAL model identity survives to the client, where the local
    // price book prices each (bucket, model) pair exactly — folding tail
    // models discarded their configured rates. The row bound stays; the
    // client detects a hit bound (COST_BUCKETS_ROW_LIMIT rows returned) and
    // marks the trend unavailable rather than publish an inexact series.
    cost_buckets: `
    SELECT
      FORMAT_TIMESTAMP('%FT%TZ', TIMESTAMP_TRUNC(timestamp, ${G})) AS ts,
      COALESCE(${MODEL_EXPR}, '(unknown)') AS model_id,
      COALESCE(SUM(COALESCE(CAST(${PROMPT_TOK_EXPR} AS INT64), 0)), 0) AS prompt_tokens,
      COALESCE(SUM(COALESCE(CAST(${COMPLETION_TOK_EXPR} AS INT64), 0)), 0) AS completion_tokens
    FROM ${T}
    WHERE event_type = 'LLM_RESPONSE' AND ${W}
    GROUP BY ts, model_id
    ORDER BY ts ASC
    LIMIT ${COST_BUCKETS_ROW_LIMIT + 1}`,

    // Sessions rank as whole sessions; models are a breakdown label, so a
    // multi-model session is one row, not several competing partial rows.
    sessions: `
    WITH llm_responses AS (
      SELECT
        session_id,
        trace_id,
        ${MODEL_EXPR} AS model_id,
        COALESCE(CAST(${PROMPT_TOK_EXPR} AS INT64), 0) AS prompt_tokens,
        COALESCE(CAST(${COMPLETION_TOK_EXPR} AS INT64), 0) AS completion_tokens
      FROM ${T}
      -- attempts, so the sessions Calls column matches the global contract;
      -- LLM_ERROR rows carry no tokens, so the token sums are unchanged
      WHERE event_type IN ('LLM_RESPONSE', 'LLM_ERROR') AND session_id IS NOT NULL AND ${W}
    )
    SELECT
      session_id,
      STRING_AGG(DISTINCT model_id ORDER BY model_id LIMIT 2) AS model_id,
      COUNT(*) AS llm_calls,
      SUM(prompt_tokens) AS total_prompt_tokens,
      SUM(completion_tokens) AS total_completion_tokens,
      SUM(prompt_tokens) + SUM(completion_tokens) AS total_tokens,
      ARRAY_AGG(DISTINCT trace_id IGNORE NULLS LIMIT 3) AS trace_ids
    FROM llm_responses
    GROUP BY session_id
    ORDER BY total_tokens DESC
    LIMIT 15`,

    // HITL pairing handles both event spellings: canonical
    // HITL_*_REQUEST → HITL_*_REQUEST_COMPLETED and the ADK v1 fixture's
    // HITL_*_REQUEST → HITL_*_COMPLETED.
    hitl: `
    WITH requests AS (
      SELECT
        session_id, invocation_id, agent,
        REGEXP_EXTRACT(event_type, r'^HITL_([A-Z]+)_') AS request_type,
        timestamp AS request_time
      FROM ${T}
      WHERE event_type LIKE 'HITL_%_REQUEST' AND ${W}
    ),
    completions AS (
      SELECT
        session_id, invocation_id,
        REGEXP_EXTRACT(event_type, r'^HITL_([A-Z]+)_') AS request_type,
        timestamp AS completion_time
      FROM ${T}
      WHERE event_type LIKE 'HITL_%COMPLETED' AND ${W}
    )
    SELECT
      r.agent,
      r.request_type,
      COUNT(*) AS total_requests,
      COUNTIF(c.completion_time IS NOT NULL) AS completed,
      ROUND(AVG(TIMESTAMP_DIFF(c.completion_time, r.request_time, SECOND)), 1) AS avg_wait_sec,
      MAX(TIMESTAMP_DIFF(c.completion_time, r.request_time, SECOND)) AS max_wait_sec
    FROM requests r
    LEFT JOIN completions c
      ON r.session_id = c.session_id
      AND r.invocation_id = c.invocation_id
      AND r.request_type = c.request_type
    GROUP BY r.agent, r.request_type
    ORDER BY total_requests DESC
    LIMIT 30`,

    // Producers emit several events per span, so spans are deduplicated
    // before the parent join: one delegation = one unique child span.
    delegation: `
    WITH spans AS (
      SELECT
        trace_id,
        span_id,
        ANY_VALUE(agent) AS agent,
        ANY_VALUE(parent_span_id) AS parent_span_id
      FROM ${T}
      WHERE timestamp BETWEEN @start AND @end
        AND span_id IS NOT NULL
      GROUP BY trace_id, span_id
    ),
    agent_tree AS (
      SELECT
        a.trace_id,
        a.agent AS child_agent,
        b.agent AS parent_agent
      FROM spans a
      INNER JOIN spans b
        ON a.parent_span_id = b.span_id
        AND a.trace_id = b.trace_id
      WHERE a.agent IS NOT NULL
        AND b.agent IS NOT NULL
        AND a.agent != b.agent
    )
    SELECT
      parent_agent, child_agent,
      COUNT(*) AS delegation_count,
      COUNT(DISTINCT trace_id) AS unique_traces
    FROM agent_tree
    ${opts.agentFilter ? "WHERE parent_agent = @agent OR child_agent = @agent" : ""}
    GROUP BY parent_agent, child_agent
    ORDER BY delegation_count DESC
    LIMIT 30`,

    agents: `
    SELECT DISTINCT agent FROM ${T}
    WHERE timestamp BETWEEN @start AND @end AND agent IS NOT NULL
    ORDER BY agent LIMIT 100`,
  };
}

// Recent traces containing errors — lets the model (or UI) cite exact
// evidence when explaining a failure pattern.
export function buildErrorTracesSql(table: string): string {
  return `
    SELECT
      trace_id,
      FORMAT_TIMESTAMP('%FT%TZ', MAX(timestamp)) AS last_ts,
      STRING_AGG(DISTINCT agent LIMIT 5) AS agents,
      COUNTIF(${ERROR_EXPR}) AS error_events,
      STRING_AGG(DISTINCT IF(${ERROR_EXPR},
        SUBSTR(COALESCE(error_message, event_type), 1, 160), NULL) LIMIT 3) AS sample_errors -- error rows only (#2-r17)
    FROM ${table}
    WHERE timestamp BETWEEN @start AND @end
      AND trace_id IS NOT NULL
      AND trace_id IN (
        SELECT DISTINCT trace_id FROM ${table}
        WHERE ${ERROR_EXPR} AND trace_id IS NOT NULL
          AND timestamp BETWEEN @start AND @end
      )
    GROUP BY trace_id
    ORDER BY last_ts DESC
    LIMIT @limit`;
}

// Trace explorer: one summary row per trace in the window, newest first.
// errors_only narrows to traces containing at least one canonical error.
export function buildTracesListSql(table: string, opts: { errorsOnly?: boolean; agentFilter?: boolean } = {}): string {
  return `
    SELECT
      trace_id,
      FORMAT_TIMESTAMP('%FT%TZ', MIN(timestamp)) AS start_ts,
      FORMAT_TIMESTAMP('%FT%TZ', MAX(timestamp)) AS last_ts,
      TIMESTAMP_DIFF(MAX(timestamp), MIN(timestamp), MILLISECOND) AS duration_ms,
      COUNT(*) AS events,
      COUNTIF(${ERROR_EXPR}) AS error_events,
      STRING_AGG(DISTINCT agent LIMIT 5) AS agents
    FROM ${table}
    WHERE timestamp BETWEEN @start AND @end
      AND trace_id IS NOT NULL
      ${
        // #2(r13): the agent filter selects WHICH traces qualify (the agent
        // participated), but the summary aggregates the WHOLE trace — filtering
        // events first would misreport duration, counts, agents, and errors,
        // and errors_only would miss traces where another agent owns the error
        opts.agentFilter
          ? `AND trace_id IN (
        SELECT DISTINCT trace_id FROM ${table}
        WHERE timestamp BETWEEN @start AND @end
          AND trace_id IS NOT NULL AND agent = @agent
      )`
          : ""
      }
    GROUP BY trace_id
    ${opts.errorsOnly ? `HAVING COUNTIF(${ERROR_EXPR}) > 0` : ""}
    ORDER BY last_ts DESC
    LIMIT @limit`;
}

export function buildTraceSql(table: string): string {
  return `
    SELECT
      FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%E6SZ', timestamp) AS timestamp,
      event_type, agent, invocation_id, span_id, parent_span_id,
      JSON_VALUE(content, '$.response') AS llm_response,
      JSON_VALUE(content, '$.tool') AS tool_name,
      JSON_VALUE(content, '$.tool_origin') AS tool_origin,
      CAST(JSON_VALUE(latency_ms, '$.total_ms') AS FLOAT64) AS latency_ms,
      status, error_message
    FROM ${table}
    WHERE trace_id = @trace_id AND timestamp BETWEEN @start AND @end
    ORDER BY timestamp ASC
    LIMIT @limit`;
}
