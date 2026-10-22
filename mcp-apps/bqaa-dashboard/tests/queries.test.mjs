// SQL contract tests — assert the metric contract without touching BigQuery.
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  buildDashboardSql,
  buildTraceSql,
  MODEL_EXPR,
  PROMPT_TOK_EXPR,
  COMPLETION_TOK_EXPR,
  SECTIONS,
} from "../src/queries.js";

const sql = buildDashboardSql({ table: "`p.d.t`", granularity: "day", agentFilter: false });

test("every section has a query", () => {
  for (const s of SECTIONS) assert.ok(sql[s]?.length > 0, `missing sql for ${s}`);
});

test("every query carries the mandatory partition predicate", () => {
  for (const s of SECTIONS) {
    assert.match(sql[s], /timestamp BETWEEN @start AND @end/, `${s} lacks time predicate`);
  }
});

test("agent filter is parameterized, never interpolated", () => {
  const filtered = buildDashboardSql({ table: "`p.d.t`", granularity: "hour", agentFilter: true });
  // "agents" (the filter's own option list) intentionally ignores the filter
  for (const s of SECTIONS.filter((s) => s !== "agents")) {
    assert.match(filtered[s], /agent = @agent/, `${s} lacks agent param`);
  }
});

test("delegation filters edges by the requested agent after resolution (#8-r5)", () => {
  const filtered = buildDashboardSql({ table: "`p.d.t`", granularity: "day", agentFilter: true });
  assert.match(filtered.delegation, /WHERE parent_agent = @agent OR child_agent = @agent/);
  assert.ok(!sql.delegation.includes("@agent"), "unfiltered delegation must not reference @agent");
});

test("sessions exclude null session ids (#7-r5)", () => {
  assert.match(sql.sessions, /session_id IS NOT NULL/);
});

test("schema aliases cover both producers (canonical ADK + tracing plugin)", () => {
  assert.match(MODEL_EXPR, /\$\.model'/);
  assert.match(MODEL_EXPR, /\$\.model_version/);
  assert.match(PROMPT_TOK_EXPR, /prompt_tokens/);
  assert.match(PROMPT_TOK_EXPR, /prompt_token_count/);
  assert.match(COMPLETION_TOK_EXPR, /completion_tokens/);
  assert.match(COMPLETION_TOK_EXPR, /candidates_token_count/);
});

test("tool stats include separate TOOL_ERROR failure events", () => {
  assert.match(sql.tools, /'TOOL_COMPLETED', 'TOOL_ERROR'/);
  assert.ok(sql.tools.includes(ERROR_EXPR), "tools must use the canonical error predicate");
});

test("model comparison includes canonical LLM_ERROR events and exact sums", () => {
  assert.match(sql.models, /'LLM_RESPONSE', 'LLM_ERROR'/);
  assert.ok(sql.models.includes(ERROR_EXPR), "models must use the canonical error predicate");
  // latency/token averages must come from successful responses only
  assert.match(sql.models, /IF\(event_type = 'LLM_RESPONSE'/);
  // cost needs exact sums, never average × attempts
  assert.match(sql.models, /SUM\(prompt_tokens\)/);
  assert.match(sql.models, /SUM\(completion_tokens\)/);
});

test("top sessions expose drillable trace ids", () => {
  assert.match(sql.sessions, /ARRAY_AGG\(DISTINCT trace_id IGNORE NULLS LIMIT 3\)/);
});

test("granularity switches the bucket truncation", () => {
  const hourly = buildDashboardSql({ table: "`p.d.t`", granularity: "hour", agentFilter: false });
  assert.match(hourly.timeseries, /TIMESTAMP_TRUNC\(timestamp, HOUR\)/);
  assert.match(sql.timeseries, /TIMESTAMP_TRUNC\(timestamp, DAY\)/);
});

test("trace query is parameterized and time-bounded", () => {
  const t = buildTraceSql("`p.d.t`");
  assert.match(t, /trace_id = @trace_id/);
  assert.match(t, /timestamp BETWEEN @start AND @end/);
});

// ---- widget contract (parity: measure × dimension × filters)

import { buildWidgetSql, buildErrorTracesSql, WIDGET_MEASURES, WIDGET_DIMENSIONS, widgetSpecError, COST_BUCKETS_ROW_LIMIT } from "../src/queries.js";

test("widget: unknown measure/dimension/filter is rejected", () => {
  assert.throws(() => buildWidgetSql("`p.d.t`", { measure: "nope", dimension: "time" }));
  assert.throws(() => buildWidgetSql("`p.d.t`", { measure: "events", dimension: "nope" }));
  assert.throws(() =>
    buildWidgetSql("`p.d.t`", { measure: "events", dimension: "time", filters: { evil: "x" } }),
  );
});

test("widget: filter values bind as parameters, never interpolated", () => {
  const evil = "x'; DROP TABLE users; --";
  // (r19: p95_latency_ms no longer accepts a status filter — use a measure
  // whose population supports both filters; the binding contract is the same)
  const w = buildWidgetSql("`p.d.t`", {
    measure: "events",
    dimension: "model",
    filters: { agent: evil, status: "ERROR" },
  });
  assert.ok(!w.sql.includes(evil), "filter value leaked into SQL");
  assert.match(w.sql, /agent = @f_agent/);
  // #3(r20): the status filter resolves to the canonical error predicate —
  // no parameter, no raw-column equality
  assert.match(w.sql, /ENDS_WITH\(event_type, '_ERROR'\)/);
  assert.equal(w.filterParams.f_agent, evil);
  assert.equal(w.filterParams.f_status, undefined, "status never becomes a raw parameter");
});

test("widget: time dimension buckets and orders by time; categorical clamps limit", () => {
  const t = buildWidgetSql("`p.d.t`", { measure: "events", dimension: "time", granularity: "hour" });
  assert.match(t.sql, /TIMESTAMP_TRUNC\(timestamp, HOUR\)/);
  assert.match(t.sql, /ORDER BY dim ASC/);
  const c = buildWidgetSql("`p.d.t`", { measure: "tool_calls", dimension: "tool", limit: 5000 });
  assert.match(c.sql, /ORDER BY value DESC/);
  assert.match(c.sql, /LIMIT 100/);
});

test("widget registries expose labels for every key", () => {
  for (const m of Object.values(WIDGET_MEASURES)) assert.ok(m.label && m.sql && m.unit);
  for (const d of Object.values(WIDGET_DIMENSIONS)) assert.ok(d.label);
});

test("dashboard includes parity sections: prev_overview, hitl, delegation", () => {
  assert.ok(SECTIONS.includes("prev_overview"));
  assert.ok(SECTIONS.includes("hitl"));
  assert.ok(SECTIONS.includes("delegation"));
  assert.match(sql.hitl, /HITL_%_REQUEST/);
  assert.match(sql.hitl, /HITL_%COMPLETED/);
  assert.match(sql.delegation, /parent_span_id = b\.span_id/);
  assert.match(sql.overview, /MAX\(timestamp\)/);
});

test("error-traces query is parameterized and errors-only", () => {
  const t = buildErrorTracesSql("`p.d.t`");
  assert.match(t, /status = 'ERROR'/);
  assert.match(t, /LIMIT @limit/);
  assert.match(t, /timestamp BETWEEN @start AND @end/);
});


// ---- fresh-review fixes: canonical errors, budget, delegation, sessions

import { ERROR_EXPR, splitBudget } from "../src/queries.js";

test("one canonical error predicate is used on every surface (#10)", () => {
  assert.match(ERROR_EXPR, /status = 'ERROR'/);
  assert.match(ERROR_EXPR, /ENDS_WITH\(event_type, '_ERROR'\)/);
  assert.match(ERROR_EXPR, /error_message IS NOT NULL/);
  for (const section of ["overview", "timeseries", "tools", "models"]) {
    assert.ok(sql[section].includes(ERROR_EXPR), `${section} must use ERROR_EXPR`);
  }
  assert.ok(buildErrorTracesSql("`p.d.t`").includes(ERROR_EXPR));
  assert.ok(WIDGET_MEASURES.errors.sql.includes(ERROR_EXPR));
  assert.ok(WIDGET_MEASURES.tool_failures.sql.includes(ERROR_EXPR));
});

test("refresh budget splits exactly and respects BigQuery's 10 MiB per-query floor", () => {
  assert.equal(splitBudget(2_000_000_000, 10), 200_000_000);
  assert.equal(splitBudget(2_000_000_000, 10) * 10 <= 2_000_000_000, true);
  // exact boundary: 10 x 10,485,760 is the smallest valid refresh budget
  assert.equal(splitBudget(10 * 10_485_760, 10), 10_485_760);
  assert.throws(() => splitBudget(10 * 10_485_760 - 1, 10), /minimum/);
  assert.throws(() => splitBudget(10_000_000, 10), /minimum/);
});

test("delegation deduplicates spans before joining (#11)", () => {
  assert.match(sql.delegation, /GROUP BY trace_id, span_id/);
  assert.match(sql.delegation, /ANY_VALUE\(agent\)/);
  assert.match(sql.delegation, /a\.parent_span_id = b\.span_id/);
});

test("top sessions aggregate whole sessions, models as a label (#28)", () => {
  assert.match(sql.sessions, /GROUP BY session_id\n/);
  assert.ok(!/GROUP BY session_id, model_id/.test(sql.sessions));
  assert.match(sql.sessions, /STRING_AGG\(DISTINCT model_id/);
});

test("trace query limit is parameterized for truncation detection (#23)", () => {
  assert.match(buildTraceSql("`p.d.t`"), /LIMIT @limit/);
});

import { buildTracesListSql } from "../src/queries.js";

test("agent filter selects traces by membership, never truncates them (#2-r13)", () => {
  const sql = buildTracesListSql("`p.d.t`", { agentFilter: true });
  assert.match(sql, /trace_id IN \(/, "membership is a subquery over whole traces");
  assert.match(sql, /SELECT DISTINCT trace_id FROM `p\.d\.t`/);
  // the OUTER aggregation must see every event of a qualifying trace
  const outerWhere = sql.slice(0, sql.indexOf("GROUP BY"));
  const outerTop = outerWhere.replace(/AND trace_id IN \([\s\S]*?\)/, "");
  assert.ok(!/AND agent = @agent/.test(outerTop), "no event-level agent filter outside the membership subquery");
  // errors_only evaluates over the whole scoped trace
  const errSql = buildTracesListSql("`p.d.t`", { agentFilter: true, errorsOnly: true });
  assert.match(errSql, /HAVING COUNTIF/);
  // both queries keep the partition predicate in every scan
  for (const q of [sql, errSql]) {
    const scans = q.split("FROM `p.d.t`").length - 1;
    const bounds = q.split("timestamp BETWEEN @start AND @end").length - 1;
    assert.equal(bounds, scans, "every table scan is partition-bounded");
  }
});


import { buildDashboardSql as buildAllSections } from "../src/queries.js";

test("LLM calls means attempts on every surface (#3-r15)", () => {
  assert.match(WIDGET_MEASURES.llm_calls.sql, /IN \('LLM_RESPONSE', 'LLM_ERROR'\)/, "Explore counts attempts");
  const sections = buildAllSections({ table: "`p.d.t`", granularity: "day", agentFilter: false });
  assert.match(sections.timeseries, /COUNTIF\(event_type IN \('LLM_RESPONSE', 'LLM_ERROR'\)\) AS llm_calls/, "overview timeseries counts attempts");
  assert.match(sections.models, /IN \('LLM_RESPONSE', 'LLM_ERROR'\)/, "model comparison already counts attempts");
  // averages keep response-only denominators — an errored call has no tokens
  assert.match(WIDGET_MEASURES.total_tokens.sql, /event_type = 'LLM_RESPONSE'/);
});

test("token denominators use responses, never attempts (#2-r16)", () => {
  const sections = buildAllSections({ table: "`p.d.t`", granularity: "day", agentFilter: false });
  assert.match(
    sections.timeseries,
    /AS llm_responses/,
    "the timeseries carries a distinct response count for token math",
  );
  // with the reviewer's 10-attempt/2-response fixture: 2000 tokens over 2
  // responses is 1000/response — the UI divides by llm_responses, and the
  // SQL proves the two populations are distinct columns
  assert.match(sections.timeseries, /IN \('LLM_RESPONSE', 'LLM_ERROR'\)\) AS llm_calls/);
});

import { SUCCESSFUL_LLM_RESPONSE_EXPR } from "../src/queries.js";

test("success metrics exclude errored LLM_RESPONSE rows (#1-r17)", () => {
  // null-safe: OK, NULL-status-without-error pass; ERROR status or an
  // error_message fail — the predicate is the single source of truth
  assert.match(SUCCESSFUL_LLM_RESPONSE_EXPR, /COALESCE\(status, 'OK'\) != 'ERROR'/);
  assert.match(SUCCESSFUL_LLM_RESPONSE_EXPR, /error_message IS NULL/);
  const sections = buildAllSections({ table: "`p.d.t`", granularity: "day", agentFilter: false });
  // the response count, latency quantiles, and latency population all use it
  assert.match(sections.timeseries, /COUNTIF\(\(event_type = 'LLM_RESPONSE' AND COALESCE\(status, 'OK'\) != 'ERROR' AND error_message IS NULL\)\) AS llm_responses/);
  assert.ok(!/WHERE event_type = 'LLM_RESPONSE' AND/.test(sections.latency), "latency population is successful-only");
  assert.match(sections.latency, /COALESCE\(status, 'OK'\) != 'ERROR'/);
  // token SUMS deliberately remain billed (all response rows) — cost truth
  assert.match(sections.timeseries, /IF\(event_type = 'LLM_RESPONSE',\n\s+COALESCE\(CAST/);
});

test("error samples aggregate only error rows (#2-r17)", () => {
  const sql = buildErrorTracesSql("`p.d.t`");
  const sampleAgg = sql.slice(sql.indexOf("sample_errors") - 400, sql.indexOf("sample_errors"));
  assert.match(sampleAgg, /STRING_AGG\(DISTINCT IF\(/, "the aggregate is gated per-row");
  assert.match(sampleAgg, /status = 'ERROR'/, "gated on the canonical error predicate");
  // agents/counts still aggregate over the WHOLE trace (membership subquery intact)
  assert.match(sql, /STRING_AGG\(DISTINCT agent LIMIT 5\)/);
});

test("token averages use successful numerators; sums stay billed (#1-r18)", () => {
  const sections = buildAllSections({ table: "`p.d.t`", granularity: "day", agentFilter: false });
  // the timeseries carries BOTH populations: billed sums for cost, ok sums
  // for the per-response average — on the review fixture (one OK response
  // with 1,100 tokens, one errored response with 950), the tile divides
  // 1,100 by 1 response, not 2,050 by 1
  assert.match(sections.timeseries, /AS ok_prompt_tokens/);
  assert.match(sections.timeseries, /AS ok_completion_tokens/);
  const okAgg = sections.timeseries.slice(sections.timeseries.indexOf("ok_prompt_tokens") - 300, sections.timeseries.indexOf("ok_prompt_tokens"));
  assert.match(okAgg, /COALESCE\(status, 'OK'\) != 'ERROR'/, "ok sums are gated on the success predicate");
  // model token AVERAGES read the ok columns; the billed SUMS remain
  assert.match(sections.models, /AVG\(ok_total_tokens\)/);
  assert.match(sections.models, /AVG\(ok_prompt_tokens\)/);
  assert.match(sections.models, /SUM\(prompt_tokens\)/, "cost totals keep billed truth");
  assert.ok(!/AVG\(total_tokens\)/.test(sections.models), "no average over the billed population remains");
});

// ---- nineteenth-review

test("incompatible widget specs are rejected before execution (#1-r19)", () => {
  // the EXACT live repro: p95 LLM latency grouped by tool, filtered to errors —
  // 3.9MB scanned for six all-null rows
  assert.throws(
    () => buildWidgetSql("`p.d.t`", { measure: "p95_latency_ms", dimension: "tool", filters: { status: "ERROR" } }),
    /cannot be grouped by "tool"/,
  );
  assert.throws(
    () => buildWidgetSql("`p.d.t`", { measure: "p95_latency_ms", dimension: "time", filters: { status: "ERROR" } }),
    /cannot be filtered by "status"/,
  );
  assert.throws(
    () => buildWidgetSql("`p.d.t`", { measure: "tool_calls", dimension: "model" }),
    /cannot be grouped by "model"/,
  );
  // the ADVERTISED question is answerable by the tool-latency population
  const w = buildWidgetSql("`p.d.t`", { measure: "tool_p95_latency_ms", dimension: "tool", filters: { status: "ERROR" } });
  assert.match(w.sql, /TOOL_COMPLETED', 'TOOL_ERROR'/);
  assert.match(w.sql, /ENDS_WITH\(event_type, '_ERROR'\)/, "errors filter by the CANONICAL predicate (#3-r20)");
  // validator is exported for every surface
  assert.equal(widgetSpecError({ measure: "events", dimension: "tool", filters: {} }), null);
  assert.match(widgetSpecError({ measure: "avg_ttft_ms", dimension: "status", filters: {} }) ?? "", /supports/);
});

test("latency and token metrics carry their own denominators (#2-r19)", () => {
  const sections = buildAllSections({ table: "`p.d.t`", granularity: "day", agentFilter: false });
  assert.match(sections.latency, /COUNT\(total_latency_ms\) AS latency_samples/);
  assert.match(sections.latency, /COUNT\(ttft_ms\) AS ttft_samples/);
  assert.match(sections.timeseries, /AS token_samples/);
});

test("cost buckets carry billed tokens per bucket AND model (#3-r19)", () => {
  const sections = buildAllSections({ table: "`p.d.t`", granularity: "day", agentFilter: true });
  assert.ok(sections.cost_buckets, "the section exists");
  assert.match(sections.cost_buckets, /GROUP BY ts, model_id/);
  assert.match(sections.cost_buckets, /timestamp BETWEEN @start AND @end/);
  assert.match(sections.cost_buckets, /agent = @agent/, "scope-aware like every section");
});

// ---- twentieth-review

test("status=ERROR matches canonical errors; status=OK excludes them (#3-r20)", () => {
  const err = buildWidgetSql("`p.d.t`", { measure: "tool_calls", dimension: "tool", filters: { status: "ERROR" } });
  // a TOOL_ERROR row with a NULL status column MUST match: the predicate
  // covers event type, status, and error_message — not the raw column
  assert.match(err.sql, /ENDS_WITH\(event_type, '_ERROR'\)/);
  assert.match(err.sql, /error_message IS NOT NULL/);
  const ok = buildWidgetSql("`p.d.t`", { measure: "tool_calls", dimension: "tool", filters: { status: "OK" } });
  // #2(r21): NOT(NULL) is NULL in GoogleSQL — OK must be the NULL-SAFE
  // complement so OK + ERROR covers the whole population
  assert.match(ok.sql, /NOT COALESCE\(/);
  assert.match(ok.sql, /, FALSE\)/);
  assert.throws(
    () => buildWidgetSql("`p.d.t`", { measure: "events", dimension: "time", filters: { status: "WEIRD" } }),
    /accepts OK or ERROR/,
  );
});

test("cost buckets keep real model identity with a detectable bound (#3-r21)", () => {
  const sections = buildAllSections({ table: "`p.d.t`", granularity: "day", agentFilter: false });
  // #3(r21): folding tail models discarded their configured price-book rates —
  // every model row survives to the client, and a hit row bound is DETECTED
  // (exactly COST_BUCKETS_ROW_LIMIT rows) so the trend goes unavailable
  // instead of publishing a partial series
  assert.ok(!sections.cost_buckets.includes("(other models)"), "no folding — identity survives to pricing");
  assert.match(sections.cost_buckets, /GROUP BY ts, model_id/);
  assert.match(sections.cost_buckets, new RegExp(`LIMIT ${COST_BUCKETS_ROW_LIMIT + 1}`), "cap+1 makes overflow observable (#1-r22)");
  assert.equal(typeof COST_BUCKETS_ROW_LIMIT, "number");
});

test("the refresh budget floor derives from the section count (#4-r20)", () => {
  // the boundary is SECTIONS.length x 10 MiB — never a hard-coded byte count
  assert.equal(SECTIONS.length, 11);
  assert.equal(splitBudget(SECTIONS.length * 10_485_760, SECTIONS.length), 10_485_760);
  assert.throws(() => splitBudget(SECTIONS.length * 10_485_760 - 1, SECTIONS.length), /minimum/);
});

import { applyCostBucketBound } from "../src/queries.js";

test("cost truncation is measured, not inferred (#1-r22)", () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ ts: `t${i}` }));
  // cap-1: complete, trusted
  const under = applyCostBucketBound(rows(COST_BUCKETS_ROW_LIMIT - 1));
  assert.equal(under.truncated, false);
  assert.equal(under.rows.length, COST_BUCKETS_ROW_LIMIT - 1);
  // exactly cap: COMPLETE — the r21 length sentinel wrongly rejected this
  const exact = applyCostBucketBound(rows(COST_BUCKETS_ROW_LIMIT));
  assert.equal(exact.truncated, false);
  assert.equal(exact.rows.length, COST_BUCKETS_ROW_LIMIT);
  // cap+1: overflow is a measured FACT, rows bounded to the cap
  const over = applyCostBucketBound(rows(COST_BUCKETS_ROW_LIMIT + 1));
  assert.equal(over.truncated, true);
  assert.equal(over.rows.length, COST_BUCKETS_ROW_LIMIT);
  // and the query fetches cap+1 so the overflow is observable
  const sections = buildAllSections({ table: "`p.d.t`", granularity: "day", agentFilter: false });
  assert.match(sections.cost_buckets, new RegExp(`LIMIT ${COST_BUCKETS_ROW_LIMIT + 1}`));
});

import { applyModelBound, MODELS_ROW_LIMIT } from "../src/queries.js";

test("model breakdown is bounded with measured overflow (#4-r24)", () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ model_id: `m${i}` }));
  assert.equal(applyModelBound(rows(MODELS_ROW_LIMIT)).truncated, false, "exactly cap is complete");
  const over = applyModelBound(rows(MODELS_ROW_LIMIT + 1));
  assert.equal(over.truncated, true);
  assert.equal(over.rows.length, MODELS_ROW_LIMIT);
  const sections = buildAllSections({ table: "`p.d.t`", granularity: "day", agentFilter: false });
  assert.match(sections.models, new RegExp(`LIMIT ${MODELS_ROW_LIMIT + 1}`), "cap+1 makes overflow observable");
});
