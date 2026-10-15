// BQAA Dashboard MCP App — UI.
// Renders inside an MCP host iframe (Claude, Goose, basic-host, …) and talks to
// the server via the ext-apps bridge. Standalone (opened directly in a browser)
// it falls back to the deterministic mock dataset for preview/QA.

import "./styles.css";
import { App } from "@modelcontextprotocol/ext-apps";
import { mockAsk, mockDashboard, mockTrace, mockTracesList, mockWidget } from "./mock.js";
import { WIDGET_DIMENSIONS, WIDGET_MEASURES } from "./queries.js";
import { buildSpans } from "./spans.js";
import type {
  AskResult,
  DashboardData,
  OverviewStats,
  TimeBucket,
  TraceEvent,
  WidgetResult,
  WidgetSpec,
 TraceListRow,} from "./types.js";

// Shareable page state lives in the hash: #view=tokens&range=720&agent=coder
// (legacy #tokens-style hashes still work).
function parseHashState(): Record<string, string> {
  const raw = location.hash.replace(/^#/, "");
  if (!raw) return {};
  if (!raw.includes("=")) return { view: raw };
  return Object.fromEntries(new URLSearchParams(raw));
}
const HASH_STATE = parseHashState();

// Auth: never in URLs. Servers started with BQAA_AUTH_TOKEN issue an HttpOnly
// cookie via POST /auth/login; the page prompts for the token on a 401.
function authHeaders(): Record<string, string> {
  return {}; // the HttpOnly cookie rides along automatically
}

async function loginWithToken(token: string): Promise<boolean> {
  const res = await fetch("auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  return res.ok;
}

function isUnauthorized(message: string): boolean {
  return /unauthorized|401/i.test(message);
}

import {
  fmtInt, fmtCompact, fmtMs, fmtPct, fmtUSD, widgetValueFmt, toCSV, csvButton,
  bucketLabel, el, svgEl, showTooltip, hideTooltip, lineChart, stackedColumns,
  hBars, emptyNote, table, sparkline, deltaChip, tile, unavailableTile,
  sectionsFailed, tileRow, statefulDetails, dataTable, chartCard,
  setViewKeyProvider,
} from "./ui.js";
import type { HBarRow, Col, ChartData } from "./ui.js";
// ---------------------------------------------------------------- views (primitives live in ui.ts)

// ---------------------------------------------------------------- views

function renderOverview(d: DashboardData, main: HTMLElement): void {
  const o = d.overview;
  const p: Partial<OverviewStats> = d.prevOverview ?? {};
  const ts = d.timeseries;
  main.appendChild(
    tileRow(
      tile("Events", fmtCompact(o.total_events), undefined, ts.map((b) => b.events), {
        cur: o.total_events,
        prev: p.total_events,
        upIs: "neutral",
      }),
      tile("Sessions", fmtCompact(o.sessions), undefined, undefined, {
        cur: o.sessions,
        prev: p.sessions,
        upIs: "neutral",
      }),
      tile("Users", fmtCompact(o.users), undefined, undefined, { cur: o.users, prev: p.users, upIs: "neutral" }),
      tile("Error rate", fmtPct(o.error_rate_pct), `${fmtInt(o.errors)} errors`, ts.map((b) => b.errors), {
        cur: o.error_rate_pct,
        prev: p.error_rate_pct,
        upIs: "bad",
      }),
      tile("P95 latency", fmtMs(o.p95_latency_ms), "all events", ts.map((b) => b.p95_latency_ms), {
        cur: o.p95_latency_ms,
        prev: p.p95_latency_ms,
        upIs: "bad",
      }),
    ),
  );

  const events = chartCard("Events over time", null, [
    { name: "Events", cssVar: "--s1", kind: "line" },
    { name: "Errors", cssVar: "--s8", kind: "line" },
  ], "half");
  main.appendChild(events.card); // attach before measuring width
  lineChart(
    events.body,
    ts,
    [
      { name: "Events", cssVar: "--s1", values: ts.map((b) => b.events) },
      { name: "Errors", cssVar: "--s8", values: ts.map((b) => b.errors) },
    ],
    {
      yFmt: (v) => fmtInt(v),
      granularity: d.meta.granularity,
      ariaLabel: "Events and errors over time",
      areaFirst: true,
      sectionError: d.meta.section_errors?.timeseries,
    },
  );
  if (ts.length) {
    events.card.appendChild(
      dataTable({
        head: ["Bucket", "Events", "Errors"],
        rows: ts.map((b) => [bucketLabel(b.ts, d.meta.granularity), fmtInt(b.events), fmtInt(b.errors)]),
      }),
    );
  }

  const lat = chartCard("LLM latency over time", null, [
    { name: "p50", cssVar: "--s1", kind: "line" },
    { name: "p95", cssVar: "--s2", kind: "line" },
  ], "half");
  main.appendChild(lat.card);
  lineChart(
    lat.body,
    ts,
    [
      { name: "p50", cssVar: "--s1", values: ts.map((b) => b.p50_latency_ms) },
      { name: "p95", cssVar: "--s2", values: ts.map((b) => b.p95_latency_ms) },
    ],
    {
      yFmt: fmtMs,
      granularity: d.meta.granularity,
      ariaLabel: "LLM latency percentiles over time",
      sectionError: d.meta.section_errors?.timeseries,
    },
  );
  if (ts.length) {
    lat.card.appendChild(
      dataTable({
        head: ["Bucket", "p50", "p95"],
        rows: ts.map((b) => [bucketLabel(b.ts, d.meta.granularity), fmtMs(b.p50_latency_ms), fmtMs(b.p95_latency_ms)]),
      }),
    );
  }
}

function renderLatency(d: DashboardData, main: HTMLElement): void {
  const rows = d.latencyByAgent;
  const calls = rows.reduce((a, r) => a + r.calls, 0);
  // #2(r19): each group average describes only its MEASURED rows — weighting
  // by r.calls lets groups with missing measurements dilute the global tile
  // (100ms x 1-sample group with 99 unmeasured rows outweighed a 1000ms group)
  const wavg = (
    get: (r: (typeof rows)[0]) => number | null,
    samplesOf: (r: (typeof rows)[0]) => number,
  ): number | null => {
    let num = 0;
    let den = 0;
    for (const r of rows) {
      const v = get(r);
      const w = samplesOf(r);
      if (v != null && w > 0) {
        num += v * w;
        den += w;
      }
    }
    return den ? num / den : null;
  };
  const slowest = rows[0];
  const latErr = sectionsFailed(d, "latency");
  main.appendChild(
    latErr
      ? tileRow(
          unavailableTile("Successful responses"),
          unavailableTile("Avg latency"),
          unavailableTile("Avg TTFT"),
          unavailableTile("Slowest p95"),
        )
      : tileRow(
          // #1(r16): this counts the latency section's population — responses
          // with measured latency — not attempts; the label must not claim more
          tile("Successful responses", fmtCompact(calls)),
          tile("Avg latency", fmtMs(wavg((r) => r.avg_total_ms, (r) => r.latency_samples ?? r.calls))),
          tile("Avg TTFT", fmtMs(wavg((r) => r.avg_ttft_ms, (r) => r.ttft_samples ?? r.calls))),
          tile(
            "Slowest p95",
            fmtMs(slowest?.p95_total_ms),
            slowest ? `${slowest.agent} · ${slowest.model_id ?? "?"}` : undefined,
          ),
        ),
  );

  const bars = chartCard("p95 latency by agent and model", "LLM_RESPONSE events, sorted by p95", []);
  hBars(
    bars.body,
    rows.slice(0, 12).map((r) => ({
      label: `${r.agent} · ${r.model_id ?? "?"}`,
      segs: [{ cssVar: "--s1", value: r.p95_total_ms ?? 0 }],
      display: fmtMs(r.p95_total_ms),
      tooltipTitle: `${r.agent} · ${r.model_id ?? "?"}`,
      tooltipRows: [
        { name: "responses", value: fmtInt(r.calls) },
        { name: "p50", value: fmtMs(r.p50_total_ms), cssVar: "--s1" },
        { name: "p95", value: fmtMs(r.p95_total_ms), cssVar: "--s1" },
        { name: "p99", value: fmtMs(r.p99_total_ms), cssVar: "--s1" },
        { name: "avg TTFT", value: fmtMs(r.avg_ttft_ms) },
      ],
    })),
    d.meta.section_errors?.latency,
  );
  main.appendChild(bars.card);

  const tbl = chartCard("All agents", null, []);
  table(tbl.body, [
    { label: "Agent", get: (r) => `${r.agent} · ${r.model_id ?? "?"}` },
    { label: "Responses", get: (r) => fmtInt(r.calls) },
    { label: "Avg", get: (r) => fmtMs(r.avg_total_ms) },
    { label: "Avg TTFT", get: (r) => fmtMs(r.avg_ttft_ms) },
    { label: "p50", get: (r) => fmtMs(r.p50_total_ms) },
    { label: "p95", get: (r) => fmtMs(r.p95_total_ms) },
    { label: "p99", get: (r) => fmtMs(r.p99_total_ms) },
  ], rows, d.meta.section_errors?.latency);
  main.appendChild(tbl.card);
}

function renderTokens(d: DashboardData, main: HTMLElement): void {
  const prompt = d.timeseries.reduce((a, b) => a + b.prompt_tokens, 0);
  const completion = d.timeseries.reduce((a, b) => a + b.completion_tokens, 0);
  const llmCalls = d.timeseries.reduce((a, b) => a + b.llm_calls, 0);
  // #2(r16): tokens exist only on successful responses — dividing response
  // tokens by ATTEMPTS understates the average
  const llmResponses = d.timeseries.reduce((a, b) => a + (b.llm_responses ?? b.llm_calls), 0);
  // #1(r18): the average's NUMERATOR is successful-response tokens too — a
  // failed response can bill tokens, and mixing billed tokens over a
  // successful-only denominator overstates the average
  const okTokens = d.timeseries.reduce(
    (a, b) => a + (b.ok_prompt_tokens ?? b.prompt_tokens) + (b.ok_completion_tokens ?? b.completion_tokens),
    0,
  );
  // #2(r19): divide by responses that REPORTED tokens, matching the models
  // table's AVG-over-non-null semantics
  const tokenSamples = d.timeseries.reduce((a, b) => a + (b.token_samples ?? b.llm_responses ?? b.llm_calls), 0);
  const tsErr = sectionsFailed(d, "timeseries");
  main.appendChild(
    tsErr
      ? tileRow(
          unavailableTile("Total tokens"),
          unavailableTile("Prompt tokens"),
          unavailableTile("Completion tokens"),
          unavailableTile("Avg tokens / response"),
        )
      : tileRow(
          tile("Total tokens", fmtCompact(prompt + completion), undefined, d.timeseries.map((b) => b.prompt_tokens + b.completion_tokens)),
          tile("Prompt tokens", fmtCompact(prompt), undefined, d.timeseries.map((b) => b.prompt_tokens)),
          tile("Completion tokens", fmtCompact(completion), undefined, d.timeseries.map((b) => b.completion_tokens)),
          tile(
            "Avg tokens / response",
            tokenSamples ? fmtCompact(okTokens / tokenSamples) : "—",
            `${fmtCompact(tokenSamples)} measured of ${fmtCompact(llmResponses)} responses · ${fmtCompact(llmCalls)} attempts`,
          ),
        ),
  );

  const cols = chartCard("Token usage over time", null, [
    { name: "Prompt", cssVar: "--s1", kind: "rect" },
    { name: "Completion", cssVar: "--s2", kind: "rect" },
  ]);
  main.appendChild(cols.card);
  stackedColumns(
    cols.body,
    d.timeseries,
    [
      { name: "Prompt", cssVar: "--s1", values: d.timeseries.map((b) => b.prompt_tokens) },
      { name: "Completion", cssVar: "--s2", values: d.timeseries.map((b) => b.completion_tokens) },
    ],
    {
      yFmt: (v) => fmtCompact(v),
      granularity: d.meta.granularity,
      ariaLabel: "Prompt and completion tokens over time",
      sectionError: d.meta.section_errors?.timeseries,
    },
  );
  if (d.timeseries.length) {
    cols.card.appendChild(
      dataTable({
        head: ["Bucket", "Prompt", "Completion"],
        rows: d.timeseries.map((b) => [
          bucketLabel(b.ts, d.meta.granularity),
          fmtInt(b.prompt_tokens),
          fmtInt(b.completion_tokens),
        ]),
      }),
    );
  }

  const models = chartCard("Model comparison", "LLM_RESPONSE and LLM_ERROR events", [], "half");
  table(models.body, [
    { label: "Model", get: (r) => r.model_id ?? "?" },
    { label: "Calls", get: (r) => fmtInt(r.calls) },
    { label: "Err %", get: (r) => fmtPct(r.error_rate_pct) },
    { label: "Avg prompt", get: (r) => fmtCompact(r.avg_prompt_tokens) },
    { label: "Avg compl.", get: (r) => fmtCompact(r.avg_completion_tokens) },
    { label: "Avg latency", get: (r) => fmtMs(r.avg_latency_ms) },
    { label: "p95", get: (r) => fmtMs(r.p95_latency_ms) },
    { label: "Avg TTFT", get: (r) => fmtMs(r.avg_ttft_ms) },
  ], d.modelComparison, d.meta.section_errors?.models);
  main.appendChild(models.card);

  const sessions = chartCard("Top sessions by tokens", "cost estimation: multiply by your per-model prices", [], "half");
  table(sessions.body, [
    { label: "Session", get: (r) => r.session_id.length > 24 ? `${r.session_id.slice(0, 24)}…` : r.session_id },
    { label: "Model", get: (r) => r.model_id ?? "?" },
    { label: "Calls", get: (r) => fmtInt(r.llm_calls) },
    { label: "Prompt", get: (r) => fmtCompact(r.total_prompt_tokens) },
    { label: "Completion", get: (r) => fmtCompact(r.total_completion_tokens) },
    { label: "Total", get: (r) => fmtCompact(r.total_tokens) },
    {
      label: "Trace",
      get: (r) => r.trace_ids?.[0] ?? "—",
      cell: (r) => {
        const tid = r.trace_ids?.[0];
        if (!tid) return el("span", undefined, "—");
        const b = el("button", "link-btn", "View");
        b.setAttribute("aria-label", `View trace for session ${r.session_id}`);
        b.addEventListener("click", () => void showTrace(tid));
        return b;
      },
    },
  ], d.topSessions, d.meta.section_errors?.sessions);
  main.appendChild(sessions.card);
}

function renderTools(d: DashboardData, main: HTMLElement): void {
  const rows = d.toolStats;
  const calls = rows.reduce((a, r) => a + r.total_calls, 0);
  const failures = rows.reduce((a, r) => a + r.failures, 0);
  const slowest = [...rows].sort((a, b) => (b.p95_latency_ms ?? 0) - (a.p95_latency_ms ?? 0))[0];
  const toolsErr = sectionsFailed(d, "tools");
  main.appendChild(
    toolsErr
      ? tileRow(unavailableTile("Tool calls"), unavailableTile("Failures"), unavailableTile("Slowest tool p95"))
      : tileRow(
          tile("Tool calls", fmtCompact(calls)),
          tile("Failures", fmtCompact(failures), calls ? `${((failures / calls) * 100).toFixed(2)}% of calls` : undefined),
          tile("Slowest tool p95", fmtMs(slowest?.p95_latency_ms), slowest?.tool_name ?? undefined),
        ),
  );

  const bars = chartCard("Calls by tool", "TOOL_COMPLETED and TOOL_ERROR events", [
    { name: "Succeeded", cssVar: "--s1", kind: "rect" },
    { name: "Failed", cssVar: "--s8", kind: "rect" },
  ]);
  hBars(
    bars.body,
    rows.slice(0, 12).map((r) => ({
      label: `${r.tool_name ?? "?"}${r.tool_origin ? ` (${r.tool_origin})` : ""}`,
      segs: [
        { cssVar: "--s1", value: r.total_calls - r.failures },
        { cssVar: "--s8", value: r.failures },
      ],
      display: `${fmtCompact(r.total_calls)} · ${fmtPct(r.fail_rate_pct)} fail`,
      tooltipTitle: r.tool_name ?? "?",
      tooltipRows: [
        { name: "calls", value: fmtInt(r.total_calls) },
        { name: "succeeded", value: fmtInt(r.total_calls - r.failures), cssVar: "--s1" },
        { name: "failed", value: fmtInt(r.failures), cssVar: "--s8" },
        { name: "avg latency", value: fmtMs(r.avg_latency_ms) },
        { name: "p95 latency", value: fmtMs(r.p95_latency_ms) },
      ],
    })),
    d.meta.section_errors?.tools,
  );
  main.appendChild(bars.card);

  const tbl = chartCard("All tools", null, []);
  table(tbl.body, [
    { label: "Tool", get: (r) => r.tool_name ?? "?" },
    { label: "Origin", get: (r) => r.tool_origin ?? "—" },
    { label: "Calls", get: (r) => fmtInt(r.total_calls) },
    { label: "Failures", get: (r) => fmtInt(r.failures) },
    { label: "Fail %", get: (r) => fmtPct(r.fail_rate_pct) },
    { label: "Avg", get: (r) => fmtMs(r.avg_latency_ms) },
    { label: "p95", get: (r) => fmtMs(r.p95_latency_ms) },
  ], rows, d.meta.section_errors?.tools);
  main.appendChild(tbl.card);
}

// ---------------------------------------------------------------- cost view
// Cost = tokens × an editable price book. Prices are deliberately user-owned
// (per-token rates vary by contract/region); defaults are labeled estimates.

interface PriceBook {
  [model: string]: { in: number; out: number }; // $ per 1M tokens
}

const DEFAULT_PRICES: PriceBook = {
  "gemini-2.5-pro": { in: 1.25, out: 10 },
  "gemini-2.5-flash": { in: 0.3, out: 2.5 },
};

function loadPrices(): PriceBook {
  try {
    return { ...DEFAULT_PRICES, ...JSON.parse(localStorage.getItem("bqaa-price-book") ?? "{}") };
  } catch {
    return { ...DEFAULT_PRICES };
  }
}

function renderCost(d: DashboardData, main: HTMLElement): void {
  const prices = loadPrices();
  // #4(r24): a truncated model breakdown cannot price cost truthfully —
  // treat it exactly like a failed models section
  const modelsErr =
    sectionsFailed(d, "models") ??
    (d.models_truncated ? "model breakdown truncated (too many distinct models) — cost pricing would be incomplete" : null);
  // #2(r15)/#3(r19): the cost-over-time series depends on the timeseries
  // (axis) AND cost_buckets (values) sections — either failing suppresses
  // the chart's export instead of offering a false file
  const costTsErr = sectionsFailed(d, "timeseries", "cost_buckets");
  // exact token sums from the models section — never average × attempts
  const rows = d.modelComparison.map((m) => {
    const price = prices[m.model_id ?? ""] ?? { in: 0, out: 0 };
    const promptTot = m.total_prompt_tokens ?? 0;
    const completionTot = m.total_completion_tokens ?? 0;
    const costIn = (promptTot / 1e6) * price.in;
    const costOut = (completionTot / 1e6) * price.out;
    return { model: m.model_id ?? "?", calls: m.calls, promptTot, completionTot, price, costIn, costOut, cost: costIn + costOut };
  });
  const totalIn = rows.reduce((a, r) => a + r.costIn, 0);
  const totalOut = rows.reduce((a, r) => a + r.costOut, 0);
  const total = totalIn + totalOut;

  main.appendChild(
    modelsErr
      ? tileRow(
          unavailableTile("Est. total cost"),
          unavailableTile("Prompt cost"),
          unavailableTile("Completion cost"),
          unavailableTile("Cost / session"),
        )
      : tileRow(
          tile("Est. total cost", fmtUSD(total), "editable price book below"),
          tile("Prompt cost", fmtUSD(totalIn)),
          tile("Completion cost", fmtUSD(totalOut)),
          tile("Cost / session", d.overview.sessions ? fmtUSD(total / d.overview.sessions) : "—", `${fmtCompact(d.overview.sessions)} sessions`),
        ),
  );

  // #3(r19): EXACT per-bucket cost — each bucket's billed tokens are priced
  // with that bucket's own model mix. Proportional smearing of the window
  // total reversed day-to-day comparisons when the mix shifted.
  const costByTs = new Map<string, number>();
  for (const cb of d.costBuckets ?? []) {
    const price = prices[cb.model_id] ?? { in: 0, out: 0 };
    const c = (cb.prompt_tokens / 1e6) * price.in + (cb.completion_tokens / 1e6) * price.out;
    costByTs.set(cb.ts, (costByTs.get(cb.ts) ?? 0) + c);
  }
  const costSeries = d.timeseries.map((b) => costByTs.get(b.ts) ?? 0);
  // #11: a CSV of zeros computed from failed pricing data would be a false
  // export — the action only exists when the pricing inputs are available
  const trend = chartCard(
    "Estimated cost over time",
    "each bucket priced with its own model mix",
    [],
    "full",
    modelsErr || costTsErr || d.cost_buckets_truncated
      ? undefined
      : {
          filename: "cost-over-time.csv",
          get: () => ({
            head: ["Bucket", "Est. cost"],
            rows: d.timeseries.map((b, i) => [bucketLabel(b.ts, d.meta.granularity), costSeries[i].toFixed(4)]),
          }),
        },
  );
  main.appendChild(trend.card);
  if (modelsErr) {
    // #4: without model pricing data the trend would be a plausible $0 chart
    emptyNote(trend.body, modelsErr);
    return renderCostRest(d, main, rows, modelsErr);
  }
  if (costTsErr) {
    // #2(r20): missing buckets are UNKNOWN cost, not zero cost — suppress the
    // chart and table entirely, exactly like the CSV
    emptyNote(trend.body, costTsErr);
    return renderCostRest(d, main, rows, null);
  }
  if (d.cost_buckets_truncated) {
    // #1(r22): the server MEASURED the overflow (cap+1 fetch) — an exactly
    // cap-sized complete series stays trusted; a flagged one is unavailable
    emptyNote(trend.body, "cost series exceeds the transport bound for this window — narrow the time range");
    return renderCostRest(d, main, rows, null);
  }
  lineChart(
    trend.body,
    d.timeseries,
    [{ name: "Est. cost", cssVar: "--s1", values: costSeries }],
    {
      yFmt: (v) => fmtUSD(v),
      granularity: d.meta.granularity,
      ariaLabel: "Estimated cost over time",
      areaFirst: true,
      sectionError: d.meta.section_errors?.timeseries,
    },
  );
  if (d.timeseries.length) {
    trend.card.appendChild(
      dataTable({
        head: ["Bucket", "Est. cost"],
        rows: d.timeseries.map((b, i) => [bucketLabel(b.ts, d.meta.granularity), fmtUSD(costSeries[i])]),
      }),
    );
  }

  renderCostRest(d, main, rows, modelsErr);
}

function renderCostRest(
  d: DashboardData,
  main: HTMLElement,
  rows: Array<{ model: string; calls: number; promptTot: number; completionTot: number; price: { in: number; out: number }; costIn: number; costOut: number; cost: number }>,
  modelsErr: string | null,
): void {
  const unpriced = rows.filter((r) => r.price.in === 0 && r.price.out === 0 && (r.promptTot > 0 || r.completionTot > 0));
  const byModel = chartCard(
    "Cost by model",
    "estimates — tokens × your price book",
    [],
    "half",
    modelsErr
      ? undefined
      : {
          filename: "cost-by-model.csv",
          get: () => ({
            head: ["Model", "Calls", "Prompt tokens", "Completion tokens", "$/1M in", "$/1M out", "Est. cost"],
            rows: rows.map((r) => [r.model, String(r.calls), String(r.promptTot), String(r.completionTot), String(r.price.in), String(r.price.out), r.cost.toFixed(4)]),
          }),
        },
  );
  table(byModel.body, [
    { label: "Model", get: (r) => r.model },
    { label: "Calls", get: (r) => fmtInt(r.calls) },
    { label: "Prompt", get: (r) => fmtCompact(r.promptTot) },
    { label: "Completion", get: (r) => fmtCompact(r.completionTot) },
    { label: "Est. cost", get: (r) => fmtUSD(r.cost) },
  ], rows, d.meta.section_errors?.models);
  main.appendChild(byModel.card);

  const editor = chartCard("Price book", "$ per 1M tokens — edit to match your contract; stored locally", [], "half");
  const grid = el("div", "price-grid");
  grid.appendChild(el("span", "price-head", "Model"));
  grid.appendChild(el("span", "price-head", "$/1M prompt"));
  grid.appendChild(el("span", "price-head", "$/1M completion"));
  const inputs: Array<{ model: string; inEl: HTMLInputElement; outEl: HTMLInputElement }> = [];
  for (const r of rows) {
    grid.appendChild(el("span", "price-model", r.model));
    const inEl = el("input") as HTMLInputElement;
    inEl.type = "number";
    inEl.step = "0.01";
    inEl.min = "0";
    inEl.value = String(r.price.in);
    inEl.setAttribute("aria-label", `${r.model} prompt price per 1M tokens`);
    const outEl = el("input") as HTMLInputElement;
    outEl.type = "number";
    outEl.step = "0.01";
    outEl.min = "0";
    outEl.value = String(r.price.out);
    outEl.setAttribute("aria-label", `${r.model} completion price per 1M tokens`);
    grid.appendChild(inEl);
    grid.appendChild(outEl);
    inputs.push({ model: r.model, inEl, outEl });
  }
  editor.body.appendChild(grid);
  if (unpriced.length) {
    editor.body.appendChild(el("div", "sub", `No price set for: ${unpriced.map((r) => r.model).join(", ")} — their cost counts as $0.`));
  }
  const save = el("button", "trace-close", "Apply prices");
  save.addEventListener("click", () => {
    // merge visible edits into the existing book — filtered views must not
    // silently delete prices for models that are not on screen
    const book: PriceBook = loadPrices();
    for (const { model, inEl, outEl } of inputs) {
      book[model] = { in: Math.max(0, Number(inEl.value) || 0), out: Math.max(0, Number(outEl.value) || 0) };
    }
    localStorage.setItem("bqaa-price-book", JSON.stringify(book));
    renderView();
  });
  editor.body.appendChild(save);
  main.appendChild(editor.card);
}

// ---------------------------------------------------------------- agents view

function renderAgents(d: DashboardData, main: HTMLElement): void {
  const deleg = d.delegation ?? [];
  const hitl = d.hitl ?? [];
  const delegTotal = deleg.reduce((a, r) => a + r.delegation_count, 0);
  const hitlTotal = hitl.reduce((a, r) => a + r.total_requests, 0);
  const hitlDone = hitl.reduce((a, r) => a + r.completed, 0);
  const delegErr = sectionsFailed(d, "delegation");
  const hitlErr = sectionsFailed(d, "hitl");
  main.appendChild(
    tileRow(
      tile("Agents", fmtCompact(d.overview.agents)),
      delegErr
        ? unavailableTile("Delegations")
        : tile("Delegations", fmtCompact(delegTotal), `${deleg.length} parent→child pairs`),
      hitlErr ? unavailableTile("HITL requests") : tile("HITL requests", fmtCompact(hitlTotal)),
      hitlErr
        ? unavailableTile("HITL completion")
        : tile("HITL completion", hitlTotal ? fmtPct(Math.round((hitlDone / hitlTotal) * 1000) / 10) : "—", hitlTotal ? `${fmtInt(hitlDone)} answered` : undefined),
    ),
  );

  // #8(r7): a header-only CSV from a failed query looks like a real no-data
  // result — the export exists only when the section succeeded
  const bars = chartCard(
    "Delegation map",
    "parent → child span relationships",
    [],
    "full",
    delegErr
      ? undefined
      : {
          filename: "delegation.csv",
          get: () => ({
            head: ["Parent", "Child", "Delegations", "Unique traces"],
            rows: deleg.map((r) => [r.parent_agent, r.child_agent, String(r.delegation_count), String(r.unique_traces)]),
          }),
        },
  );
  hBars(
    bars.body,
    deleg.slice(0, 12).map((r) => ({
      label: `${r.parent_agent} → ${r.child_agent}`,
      segs: [{ cssVar: "--s1", value: r.delegation_count }],
      display: fmtCompact(r.delegation_count),
      tooltipTitle: `${r.parent_agent} → ${r.child_agent}`,
      tooltipRows: [
        { name: "delegations", value: fmtInt(r.delegation_count), cssVar: "--s1" },
        { name: "unique traces", value: fmtInt(r.unique_traces) },
      ],
    })),
    d.meta.section_errors?.delegation,
  );
  if (deleg.length) {
    bars.card.appendChild(
      dataTable({
        head: ["Parent", "Child", "Delegations", "Unique traces"],
        rows: deleg.map((r) => [r.parent_agent, r.child_agent, fmtInt(r.delegation_count), fmtInt(r.unique_traces)]),
      }),
    );
  }
  main.appendChild(bars.card);

  const tbl = chartCard(
    "Human-in-the-loop",
    "requests vs completions by type",
    [],
    "full",
    hitlErr
      ? undefined
      : {
          filename: "hitl.csv",
          get: () => ({
            head: ["Agent", "Type", "Requests", "Completed", "Avg wait s", "Max wait s"],
            rows: hitl.map((r) => [r.agent ?? "?", r.request_type ?? "?", String(r.total_requests), String(r.completed), String(r.avg_wait_sec ?? ""), String(r.max_wait_sec ?? "")]),
          }),
        },
  );
  table(tbl.body, [
    { label: "Agent", get: (r) => r.agent ?? "?" },
    { label: "Type", get: (r) => r.request_type ?? "?" },
    { label: "Requests", get: (r) => fmtInt(r.total_requests) },
    { label: "Completed", get: (r) => fmtInt(r.completed) },
    { label: "Completion %", get: (r) => (r.total_requests ? fmtPct(Math.round((r.completed / r.total_requests) * 1000) / 10) : "—") },
    { label: "Avg wait", get: (r) => (r.avg_wait_sec == null ? "—" : fmtMs(r.avg_wait_sec * 1000)) },
    { label: "Max wait", get: (r) => (r.max_wait_sec == null ? "—" : fmtMs(r.max_wait_sec * 1000)) },
  ], hitl, d.meta.section_errors?.hitl);
  main.appendChild(tbl.card);
}

// ---------------------------------------------------------------- explore view
// The Langfuse-style widget builder: measure × dimension × filters, with a
// BigQuery dry-run cost preview before executing.

interface ExploreState {
  spec: WidgetSpec;
  result: WidgetResult | null;
  estimate: number | null;
  note: string;
}

const explore: ExploreState = {
  spec: { v: 1, measure: "events", dimension: "time", filters: {} },
  result: null,
  estimate: null,
  note: "",
};

// #8: only the most recent Estimate/Run may publish into explore state — a
// slow older response must never overwrite a newer selection's results.
let exploreOpSeq = 0;

function exploreSpecChanged(): void {
  exploreOpSeq++; // cancels any in-flight op's right to publish
  widgetAbort?.abort(); // and stops its HTTP request outright (#15)
  embeddedWidgetQueued = null; // #4(r11): queued actions belong to the old intent
  explore.estimate = null;
  explore.result = null;
  explore.note = ""; // #6(r10): a superseded op must not leave "Running..." behind
}

// #9/#21: the effective window can differ from the preset control (e.g. a
// render_widget push or a non-preset host window) — queries must follow it.
let effectiveHours: number | null = null;

function currentHours(): number {
  return effectiveHours ?? Number(rangeEl.value);
}

// #1(r24): the ACTIVE agent scope — a pending share-link/host agent outranks
// the select while the refresh that will adopt it is still in flight. Every
// query surface (Ask, traces, scope labels) must resolve through this, never
// read agentEl.value directly.
// The agent the CURRENTLY RUNNING refresh queried with — refresh() consumes
// pendingAgent at start, so without this the pending scope would vanish for
// the whole in-flight window (the round-24 Ask repro).
let inflightAgent: string | undefined;

function currentAgent(): string {
  if (pendingAgent !== undefined) return pendingAgent; // queued, newest intent
  if (inflightAgent !== undefined) return inflightAgent; // running refresh's scope
  return agentEl.value; // published, authoritative
}

// #15: superseded standalone widget requests are aborted, not just ignored
let widgetAbort: AbortController | null = null;
// #13(r9): embedded widget calls are uncancellable — allow only one in flight.
// #7(r10): while one is in flight, the LATEST user action queues instead of
// failing; it dispatches when the dispatcher frees, so Estimate→Run publishes
// the Run, not an error.
let embeddedWidgetBusy = false;
// #4(r10/r11): the queued action remembers the intent epoch it was created
// under; any scope/spec change advances exploreOpSeq AND clears the queue, and
// the dequeue re-checks the epoch so captured work can never outlive intent.
let embeddedWidgetQueued: { action: () => Promise<void>; epoch: number } | null = null;

function dispatchWidgetAction(action: () => Promise<void>): void {
  if (embedded && embeddedWidgetBusy) {
    embeddedWidgetQueued = { action, epoch: exploreOpSeq }; // latest wins
    explore.note = "Waiting for the previous request to settle…";
    renderView();
    return;
  }
  void action();
}

async function runWidget(dryRun: boolean): Promise<WidgetResult> {
  const hours = currentHours();
  const s = explore.spec;
  const args: Record<string, unknown> = {
    measure: s.measure,
    dimension: s.dimension,
    time_range_hours: hours,
    ...(s.granularity ? { granularity: s.granularity } : {}),
    ...(s.filters?.agent ? { agent: s.filters.agent } : {}),
    ...(s.filters?.model ? { model: s.filters.model } : {}),
    ...(s.filters?.tool ? { tool: s.filters.tool } : {}),
    ...(s.filters?.status ? { status: s.filters.status } : {}),
    ...(s.limit ? { limit: s.limit } : {}),
    ...(dryRun ? { dry_run: true } : {}),
  };
  if (embedded && appBridge) {
    // #13(r9): host calls cannot be cancelled — bound them to one in flight
    if (embeddedWidgetBusy) throw new Error("A widget request is already running — wait for it to settle");
    embeddedWidgetBusy = true;
    try {
      const result: any = await appBridge.callServerTool({ name: "query_widget", arguments: args });
      const data = result?.structuredContent?.data;
      if (!data?.spec) throw new Error("no widget data in tool result");
      return data as WidgetResult;
    } finally {
      // #7(r10): hold the dispatcher until the queued LATEST action fires
      if (embeddedWidgetQueued) {
        const next = embeddedWidgetQueued;
        embeddedWidgetQueued = null;
        setTimeout(() => {
          embeddedWidgetBusy = false;
          const latest = embeddedWidgetQueued ?? next;
          embeddedWidgetQueued = null;
          if (latest.epoch !== exploreOpSeq) return; // #4(r11): intent moved on
          void latest.action();
        }, 0);
      } else {
        embeddedWidgetBusy = false;
      }
    }
  }
  if (location.protocol.startsWith("http")) {
    widgetAbort?.abort();
    const abort = new AbortController();
    widgetAbort = abort;
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(args)) q.set(k, k === "dry_run" ? "1" : String(v));
    const res = await fetch(`api/widget?${q}`, { headers: authHeaders(), signal: abort.signal });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return body.data as WidgetResult;
  }
  const end = new Date();
  const start = new Date(end.getTime() - hours * 3_600_000);
  const result = mockWidget({ ...s, granularity: s.granularity ?? (hours <= 72 ? "hour" : "day") }, start, end);
  return dryRun ? { ...result, rows: [], dry_run: true, estimated_bytes: 12_345_678 } : result;
}

function exploreSelect(
  label: string,
  options: Array<{ value: string; label: string }>,
  value: string,
  onChange: (v: string) => void,
): HTMLElement {
  const wrap = el("label", "explore-field");
  wrap.appendChild(el("span", undefined, label));
  const sel = el("select");
  for (const o of options) {
    const opt = el("option", undefined, o.label);
    opt.value = o.value;
    sel.appendChild(opt);
  }
  sel.value = value;
  sel.addEventListener("change", () => onChange(sel.value));
  wrap.appendChild(sel);
  return wrap;
}

function renderExplore(d: DashboardData | null, main: HTMLElement): void {
  const s = explore.spec;
  const form = chartCard("Custom widget", "measure × dimension × filters — every query is parameterized and budget-capped", []);
  const controls = el("div", "explore-form");

  controls.appendChild(
    exploreSelect("Measure", Object.entries(WIDGET_MEASURES).map(([value, m]) => ({ value, label: m.label })), s.measure, (v) => {
      s.measure = v;
      // #1(r19): the new measure's population may not support the current
      // dimension or filters — reset them instead of building a doomed spec
      const compat = WIDGET_MEASURES[v];
      if (compat && !compat.dimensions.includes(s.dimension)) s.dimension = compat.dimensions[0];
      if (compat && s.filters) {
        for (const key of Object.keys(s.filters)) {
          if (!compat.filters.includes(key)) delete (s.filters as Record<string, unknown>)[key];
        }
      }
      exploreSpecChanged();
      renderView();
    }),
  );
  const measureCompat = WIDGET_MEASURES[s.measure];
  controls.appendChild(
    exploreSelect(
      "Dimension",
      Object.entries(WIDGET_DIMENSIONS)
        .filter(([value]) => !measureCompat || measureCompat.dimensions.includes(value))
        .map(([value, m]) => ({ value, label: m.label })),
      s.dimension,
      (v) => {
        s.dimension = v;
        exploreSpecChanged();
        renderView();
      },
    ),
  );
  if (s.dimension === "time") {
    controls.appendChild(
      exploreSelect(
        "Granularity",
        [
          { value: "", label: "Auto" },
          { value: "hour", label: "Hourly" },
          { value: "day", label: "Daily" },
        ],
        s.granularity ?? "",
        (v) => {
          s.granularity = v === "hour" || v === "day" ? v : undefined;
          exploreSpecChanged();
          renderView();
        },
      ),
    );
  }
  const opt = (vals: Array<string | null | undefined>): Array<{ value: string; label: string }> => [
    { value: "", label: "Any" },
    ...[...new Set(vals.filter((v): v is string => !!v))].map((v) => ({ value: v, label: v })),
  ];
  // #5(r20): only the filters this measure's population supports are shown
  const filterAllowed = (k: string): boolean => !measureCompat || measureCompat.filters.includes(k);
  if (filterAllowed("agent"))
  controls.appendChild(
    exploreSelect("Agent", opt(d?.agentsList ?? []), s.filters?.agent ?? "", (v) => {
      s.filters = { ...s.filters, agent: v || undefined };
      exploreSpecChanged();
      renderView();
    }),
  );
  if (filterAllowed("model"))
  controls.appendChild(
    exploreSelect("Model", opt((d?.modelComparison ?? []).map((m) => m.model_id)), s.filters?.model ?? "", (v) => {
      s.filters = { ...s.filters, model: v || undefined };
      exploreSpecChanged();
      renderView();
    }),
  );
  if (filterAllowed("tool"))
  controls.appendChild(
    exploreSelect("Tool", opt((d?.toolStats ?? []).map((t) => t.tool_name)), s.filters?.tool ?? "", (v) => {
      s.filters = { ...s.filters, tool: v || undefined };
      exploreSpecChanged();
      renderView();
    }),
  );
  if (filterAllowed("status"))
  controls.appendChild(
    exploreSelect(
      "Status",
      [
        { value: "", label: "Any" },
        { value: "OK", label: "OK" },
        { value: "ERROR", label: "Error" },
      ],
      s.filters?.status ?? "",
      (v) => {
        s.filters = { ...s.filters, status: v === "OK" || v === "ERROR" ? v : undefined };
        exploreSpecChanged();
        renderView();
      },
    ),
  );
  form.body.appendChild(controls);

  const actions = el("div", "explore-actions");
  const estimateBtn = el("button", "trace-close", "Estimate scan");
  estimateBtn.addEventListener("click", () => dispatchWidgetAction(async () => {
    const op = ++exploreOpSeq;
    explore.note = "Estimating…";
    renderView();
    try {
      const r = await runWidget(true);
      if (op !== exploreOpSeq) return; // superseded
      explore.estimate = r.estimated_bytes ?? null;
      explore.note = "";
    } catch (e) {
      if (op !== exploreOpSeq) return;
      explore.note = `Estimate failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    renderView();
  }));
  const runBtn = el("button", "run-btn", "Run query");
  runBtn.addEventListener("click", () => dispatchWidgetAction(async () => {
    const op = ++exploreOpSeq;
    explore.note = "Running…";
    renderView();
    try {
      const result = await runWidget(false);
      if (op !== exploreOpSeq) return; // superseded
      explore.result = result;
      explore.note = "";
    } catch (e) {
      if (op !== exploreOpSeq) return;
      explore.note = `Query failed: ${e instanceof Error ? e.message : String(e)}`;
    }
    renderView();
  }));
  const copyBtn = el("button", "link-btn", "Copy widget JSON");
  copyBtn.addEventListener("click", () => {
    // the copied shape IS the query_widget / render_widget tool-argument shape,
    // so it can be replayed directly by any MCP client
    const args = {
      measure: s.measure,
      dimension: s.dimension,
      time_range_hours: currentHours(),
      ...(s.granularity ? { granularity: s.granularity } : {}),
      ...(s.filters?.agent ? { agent: s.filters.agent } : {}),
      ...(s.filters?.model ? { model: s.filters.model } : {}),
      ...(s.filters?.tool ? { tool: s.filters.tool } : {}),
      ...(s.filters?.status ? { status: s.filters.status } : {}),
      ...(s.limit ? { limit: s.limit } : {}),
    };
    void navigator.clipboard?.writeText(JSON.stringify(args, null, 2));
    explore.note = "Copied as query_widget tool arguments";
    renderView();
  });
  actions.appendChild(estimateBtn);
  actions.appendChild(runBtn);
  actions.appendChild(copyBtn);
  if (explore.estimate != null) {
    actions.appendChild(el("span", "sub", `~${(explore.estimate / 1e6).toFixed(1)} MB scan`));
  }
  if (explore.note) actions.appendChild(el("span", "sub", explore.note));
  form.body.appendChild(actions);
  main.appendChild(form.card);

  const r = explore.result;
  if (!r) return;
  const fmt = widgetValueFmt(r.spec.measure);
  const title = `${WIDGET_MEASURES[r.spec.measure]?.label ?? r.spec.measure} by ${WIDGET_DIMENSIONS[r.spec.dimension]?.label ?? r.spec.dimension}`;
  const gran: "hour" | "day" = r.spec.granularity ?? "day";
  const chart = chartCard(title, r.bytes_processed != null ? `${(r.bytes_processed / 1e6).toFixed(1)} MB scanned` : null, [], "full", {
    filename: "widget.csv",
    get: () => ({
      head: [r.spec.dimension, r.spec.measure],
      rows: r.rows.map((row) => [row.dim ?? "", String(row.value ?? "")]),
    }),
  });
  main.appendChild(chart.card);
  if (r.spec.dimension === "time") {
    lineChart(
      chart.body,
      r.rows.map((row) => ({ ts: row.dim ?? "" }) as TimeBucket),
      [{ name: title, cssVar: "--s1", values: r.rows.map((row) => row.value) }],
      { yFmt: fmt, granularity: gran, ariaLabel: title, areaFirst: true },
    );
  } else {
    const max = Math.max(1, ...r.rows.map((row) => row.value ?? 0));
    void max;
    hBars(
      chart.body,
      r.rows.slice(0, 20).map((row) => ({
        label: row.dim ?? "(null)",
        segs: [{ cssVar: "--s1", value: row.value ?? 0 }],
        display: fmt(row.value),
        tooltipTitle: row.dim ?? "(null)",
        tooltipRows: [{ name: r.spec.measure, value: fmt(row.value), cssVar: "--s1" }],
      })),
    );
  }
  chart.card.appendChild(
    dataTable({
      head: [WIDGET_DIMENSIONS[r.spec.dimension]?.label ?? r.spec.dimension, WIDGET_MEASURES[r.spec.measure]?.label ?? r.spec.measure],
      rows: r.rows.map((row) => [row.dim && r.spec.dimension === "time" ? bucketLabel(row.dim, gran) : (row.dim ?? "(null)"), fmt(row.value)]),
    }),
  );
}

// ---------------------------------------------------------------- ask view
// The conversation layer: natural-language questions answered by BigQuery
// Conversational Analytics server-side — works with no MCP host at all.

const askState: { exchanges: AskResult[]; pending: string | null; note: string; draft: string } = {
  exchanges: [],
  pending: null,
  note: "",
  draft: "", // survives re-renders so a background refresh never eats typing
};

// #5(r5/r6): an Ask answer computed under old filters must not publish under
// new ones — and the obsolete request itself is CANCELLED, so the input is
// never blocked waiting for work whose answer would be discarded anyway.
let askGen = 0;
let askOp = 0;
let askAbort: AbortController | null = null;
// #4(r7): host tool calls cannot be cancelled, so embedded Ask is
// single-flight — one in-flight question, and only the LATEST replacement
// queues. The server's 3 Ask slots can never be filled by one abandoned UI.
let embeddedAskBusy = false;
// #4(r11): queued questions carry the scope generation they were asked under
let embeddedAskQueued: { q: string; gen: number } | null = null;

function invalidateAskScope(): void {
  askGen++;
  askAbort?.abort(); // stop the obsolete HTTP request outright
  embeddedAskQueued = null; // #4(r11): a queued question belongs to the old scope
  if (askState.pending) {
    askState.pending = null; // unblock the input immediately
    askState.note = "Analysis cancelled — the filters changed.";
  }
}

// Minimal, injection-safe renderer for the API's markdown-ish answers:
// headings, bullets, **bold**, `code` — everything else is plain text.
function renderAnswer(text: string): HTMLElement {
  const wrap = el("div", "ans");
  for (const rawLine of text.split("\n")) {
    let line = rawLine.trimEnd();
    if (!line.trim()) continue;
    let cls = "ans-p";
    if (/^#{2,4} /.test(line)) {
      cls = "ans-h";
      line = line.replace(/^#{2,4} /, "");
    } else if (/^\s*[-*] /.test(line)) {
      cls = "ans-li";
      line = line.replace(/^\s*[-*] /, "");
    }
    const p = el("div", cls);
    for (const tok of line.split(/(\*\*[^*]+\*\*|`[^`]+`)/g)) {
      if (tok.startsWith("**") && tok.endsWith("**")) p.appendChild(el("strong", undefined, tok.slice(2, -2)));
      else if (tok.startsWith("`") && tok.endsWith("`")) p.appendChild(el("code", undefined, tok.slice(1, -1)));
      else if (tok) p.appendChild(document.createTextNode(tok));
    }
    wrap.appendChild(p);
  }
  return wrap;
}

async function submitQuestion(question: string): Promise<void> {
  const q = question.trim();
  if (!q) return;
  if (embedded && embeddedAskBusy) {
    embeddedAskQueued = { q, gen: askGen }; // latest replacement only
    askState.note = "Queued — will run when the current analysis settles (host calls cannot be cancelled).";
    renderView();
    return;
  }
  if (askState.pending) return;
  askState.pending = q;
  askState.note = "";
  renderView();
  // #5: the answer must match the filters on screen; stale completions are dropped
  const gen = askGen;
  const op = ++askOp;
  const abort = new AbortController();
  askAbort = abort;
  const activeAgent = currentAgent(); // #1(r24): pending share-link agent included
  const scope = { time_range_hours: currentHours(), ...(activeAgent ? { agent: activeAgent } : {}) };
  const scopeLabel = `last ${scope.time_range_hours}h${scope.agent ? ` · agent ${scope.agent}` : ""}`;
  try {
    let result: AskResult;
    const history = askState.exchanges.slice(-3).map((e) => ({ question: e.question, answer: e.answer }));
    if (embedded && appBridge) {
      embeddedAskBusy = true;
      try {
        const r: any = await appBridge.callServerTool({ name: "ask_data", arguments: { question: q, history, ...scope } });
        const d = r?.structuredContent?.data;
        if (!d?.answer) throw new Error("no answer in tool result");
        result = d as AskResult;
      } finally {
        if (embeddedAskQueued) {
          // #7(r8): keep the dispatcher reserved across the dequeue gap, and
          // dispatch whatever is LATEST at fire time — a question submitted in
          // the gap replaces the queued one instead of being overtaken by it
          const next = embeddedAskQueued;
          embeddedAskQueued = null;
          setTimeout(() => {
            embeddedAskBusy = false;
            const latest = embeddedAskQueued ?? next;
            embeddedAskQueued = null;
            if (latest.gen !== askGen) return; // #4(r11): scope moved on
            void submitQuestion(latest.q);
          }, 0);
        } else {
          embeddedAskBusy = false;
        }
      }
    } else if (location.protocol.startsWith("http")) {
      const res = await fetch("api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ question: q, history, ...scope }),
        signal: abort.signal,
      });
      const body: any = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      result = body.data as AskResult;
    } else {
      await new Promise((r) => setTimeout(r, 600));
      // #5(r8): the sample must reflect the labeled scope, even from file://
      const end = new Date();
      const start = new Date(end.getTime() - scope.time_range_hours * 3_600_000);
      result = mockAsk(q, {
        startIso: start.toISOString(),
        endIso: end.toISOString(),
        ...(scope.agent ? { agent: scope.agent } : {}),
      });
    }
    if (gen !== askGen) {
      askState.note = "Answer discarded — the filters changed while it was being computed.";
    } else {
      askState.exchanges.push({ ...result, question: `${result.question}  (${scopeLabel})` });
    }
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") return; // cancelled by a scope change
    if (gen === askGen) askState.note = `Ask failed: ${e instanceof Error ? e.message : String(e)}`;
  } finally {
    // #5(r6): only this operation may clear pending — a stale finally must
    // never clobber a newer question's state
    if (op === askOp && askState.pending === q) askState.pending = null;
    renderView();
  }
}

function fmtCell(v: unknown): string {
  if (v == null) return "—";
  if (typeof v === "number") {
    if (Number.isInteger(v)) return v.toLocaleString("en-US");
    return Math.abs(v) < 1 ? v.toFixed(4) : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return String(v);
}

function renderAsk(d: DashboardData | null, main: HTMLElement): void {
  void d;
  const form = chartCard(
    "Ask your agent data",
    "natural language → SQL → answer, via BigQuery Conversational Analytics (no MCP host needed)",
    [],
  );
  const row = el("div", "ask-row");
  const input = el("input", "ask-input") as HTMLInputElement;
  input.type = "text";
  input.placeholder = "e.g. Which tool has the highest failure rate, and is it getting worse week over week?";
  input.setAttribute("aria-label", "Question about the agent_events table");
  input.disabled = !!askState.pending;
  input.value = askState.draft;
  input.addEventListener("input", () => {
    askState.draft = input.value;
  });
  const btn = el("button", "run-btn", askState.pending ? "Analyzing…" : "Ask");
  btn.disabled = !!askState.pending;
  const go = (): void => {
    const q = input.value;
    askState.draft = "";
    input.value = "";
    void submitQuestion(q);
  };
  btn.addEventListener("click", go);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") go();
  });
  row.appendChild(input);
  row.appendChild(btn);
  form.body.appendChild(row);
  if (askState.pending) {
    form.body.appendChild(el("div", "sub", `Analyzing "${askState.pending}" — BQ Conversational Analytics plans and runs SQL, ~30–60 s…`));
  }
  if (askState.note) form.body.appendChild(el("div", "empty error", askState.note));
  if (!askState.exchanges.length && !askState.pending) {
    const hints = el("div", "ask-hints");
    for (const h of [
      "Which tool has the highest failure rate?",
      "How many tokens did each model use per day last month?",
      "Which agent is slowest at p95, and why?",
    ]) {
      const chip = el("button", "chip-btn", h);
      chip.addEventListener("click", () => void submitQuestion(h));
      hints.appendChild(chip);
    }
    form.body.appendChild(hints);
  }
  main.appendChild(form.card);

  for (const ex of [...askState.exchanges].reverse()) {
    const card = el("div", "card span-full ask-exchange");
    card.appendChild(el("div", "ask-q", ex.question));
    if (ex.steps.length) card.appendChild(el("div", "sub", `${ex.steps.length} analysis steps · ${ex.steps.slice(0, 3).join(" · ")}`));
    if (ex.scope && ex.scope.verified === false) {
      card.appendChild(el("div", "empty error", "Scope not verified — the generated SQL may cover a different slice than the label."));
    }
    card.appendChild(renderAnswer(ex.answer));
    if (ex.sql) {
      const det = statefulDetails("data-table", "Generated SQL", `ask-sql:${ex.question}`);
      const pre = el("pre", "ask-sql");
      pre.textContent = ex.sql;
      det.appendChild(pre);
      card.appendChild(det);
    }
    if (ex.rows.length) {
      const cols = ex.schema.length ? ex.schema : Object.keys(ex.rows[0]);
      card.appendChild(
        dataTable(
          {
            head: cols,
            rows: ex.rows.slice(0, 30).map((r) => cols.map((c) => fmtCell((r as Record<string, unknown>)[c]))),
          },
          `ask-data:${ex.question}`, // #22(r5): per-exchange, not per-column-shape
        ),
      );
    }
    if (ex.followups.length) {
      const chips = el("div", "ask-hints");
      for (const f of ex.followups) {
        const chip = el("button", "chip-btn", f);
        chip.addEventListener("click", () => void submitQuestion(f));
        chips.appendChild(chip);
      }
      card.appendChild(chips);
    }
    main.appendChild(card);
  }
}

// ---------------------------------------------------------------- app state

// ------------------------------------------------------------ trace explorer
// Recent traces in the current scope, newest first — click a row to dive into
// its waterfall. Same publication rules as everything else: a scope change
// revokes in-flight results, and embedded host calls are single-flight.
const tracesState: { rows: TraceListRow[] | null; loading: boolean; error: string | null; key: string; errorsOnly: boolean } = {
  rows: null,
  loading: false,
  error: null,
  key: "",
  errorsOnly: false,
};
let tracesGen = 0;
let tracesAbort: AbortController | null = null;
let embeddedTracesBusy = false;

function tracesKey(): string {
  return `${currentHours()}|${currentAgent()}|${tracesState.errorsOnly}`;
}

async function fetchTracesList(force = false): Promise<void> {
  const key = tracesKey();
  if (tracesState.loading || (tracesState.rows && tracesState.key === key)) return;
  // #1(r13): a failure for the CURRENT scope is terminal — no automatic
  // same-scope retry. Only an explicit Retry, a scope change, or a queued
  // key mismatch may issue another request.
  if (!force && tracesState.error && tracesState.key === key) return;
  if (embedded && embeddedTracesBusy) return; // the settle path re-checks the key
  const gen = ++tracesGen;
  tracesState.loading = true;
  tracesState.error = null;
  // P2(r19): NO synchronous renderView here — this function is called from
  // renderTraces DURING a render pass, and a nested render appended a second
  // explorer card before the first one mounted. Callers outside a render
  // pass repaint themselves; the settle path repaints on completion.
  try {
    let rows: TraceListRow[];
    const agent = currentAgent() || undefined; // #1(r24): pending scope included
    if (embedded && appBridge) {
      embeddedTracesBusy = true;
      try {
        const r: any = await appBridge.callServerTool({
          name: "list_traces",
          arguments: {
            time_range_hours: currentHours(),
            errors_only: tracesState.errorsOnly,
            ...(agent ? { agent } : {}),
          },
        });
        rows = (r?.structuredContent?.data as TraceListRow[]) ?? [];
      } finally {
        embeddedTracesBusy = false;
        // #2(r14): this settle is the ONLY wake-up there is — if the scope
        // moved while this uncancellable call was in flight, its generation
        // went stale and the outer refetch guard will never run, so dispatch
        // the CURRENT key from here. `loading` is true only when this
        // generation is still current (the outer finally owns that case),
        // and same-scope failures stay terminal because an error stamps its
        // own key into tracesState.key.
        if (!tracesState.loading || gen !== tracesGen) {
          if (currentView === "traces" && tracesKey() !== tracesState.key) {
            setTimeout(() => void fetchTracesList(), 0);
          }
        }
      }
    } else if (location.protocol.startsWith("http")) {
      tracesAbort?.abort();
      const abort = new AbortController();
      tracesAbort = abort;
      const q = new URLSearchParams({
        time_range_hours: String(currentHours()),
        ...(tracesState.errorsOnly ? { errors_only: "1" } : {}),
        ...(agent ? { agent } : {}),
      });
      const res = await fetch(`api/traces?${q}`, { headers: authHeaders(), signal: abort.signal });
      const body: any = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
      rows = body.data as TraceListRow[];
    } else {
      rows = mockTracesList(currentHours(), tracesState.errorsOnly, agent);
    }
    if (gen !== tracesGen) return; // superseded by a newer scope
    tracesState.rows = rows;
    tracesState.key = key;
  } catch (e) {
    if (gen !== tracesGen || (e instanceof DOMException && e.name === "AbortError")) return;
    tracesState.error = e instanceof Error ? e.message : String(e);
    tracesState.rows = null;
    tracesState.key = key; // #1(r13): the error ANSWERS this key — it must not refetch itself
  } finally {
    if (gen === tracesGen) {
      tracesState.loading = false;
      renderView();
      // an embedded fetch cannot be cancelled — refetch ONLY when the scope
      // moved while this request ran (#1-r13: never on a same-scope failure)
      if (tracesKey() !== key && currentView === "traces") void fetchTracesList();
    }
  }
}

function renderTraces(_d: DashboardData | null, main: HTMLElement): void {
  const { card, body } = chartCard(
    "Trace explorer",
    "recent traces in this scope, newest first — click one to open its waterfall, then click spans to expand",
    [],
  );
  card.classList.add("span-full");

  const controls = el("div", "explore-actions");
  const toggle = el("label", "wf-errors-toggle");
  const cb = el("input") as HTMLInputElement;
  cb.type = "checkbox";
  cb.checked = tracesState.errorsOnly;
  cb.addEventListener("change", () => {
    tracesState.errorsOnly = cb.checked;
    tracesState.rows = null; // different question — refetch
    void fetchTracesList();
    renderView(); // paint the loading state (event handler, not a render pass)
  });
  toggle.appendChild(cb);
  toggle.appendChild(document.createTextNode(" errors only"));
  controls.appendChild(toggle);
  body.appendChild(controls);

  if (tracesState.error && tracesState.key === tracesKey()) {
    const errBox = el("div", "empty error", `Trace list failed: ${tracesState.error} `);
    const retry = el("button", "trace-close", "Retry");
    retry.addEventListener("click", () => {
      tracesState.error = null;
      void fetchTracesList(true); // #1(r13): retry is EXPLICIT
      renderView(); // paint the loading state
    });
    errBox.appendChild(retry);
    body.appendChild(errBox);
  } else if (!tracesState.rows || tracesState.key !== tracesKey()) {
    body.appendChild(el("div", "empty", "Loading traces…"));
    void fetchTracesList();
  } else if (!tracesState.rows.length) {
    body.appendChild(el("div", "empty", tracesState.errorsOnly ? "No traces with errors in this window." : "No traces in this window."));
  } else {
    table(body, [
      {
        label: "Trace",
        get: (r: TraceListRow) => r.trace_id,
        cell: (r: TraceListRow) => {
          const b = el("button", "link-btn", r.trace_id.slice(0, 12) + (r.trace_id.length > 12 ? "…" : ""));
          b.title = r.trace_id;
          b.addEventListener("click", () => void showTrace(r.trace_id));
          return b;
        },
      },
      { label: "Started", get: (r: TraceListRow) => r.start_ts.replace("T", " ").replace(/\.\d+Z$|Z$/, "") },
      { label: "Duration", get: (r: TraceListRow) => fmtMs(r.duration_ms) },
      { label: "Events", get: (r: TraceListRow) => fmtInt(r.events) },
      {
        label: "Errors",
        get: (r: TraceListRow) => fmtInt(r.error_events),
        cell: (r: TraceListRow) => el("span", r.error_events > 0 ? "err-count" : undefined, fmtInt(r.error_events)),
      },
      { label: "Agents", get: (r: TraceListRow) => r.agents ?? "—" },
    ], tracesState.rows);
  }
  main.appendChild(card);
}

const VIEWS = [
  { id: "overview", label: "Overview", render: renderOverview },
  { id: "ask", label: "Ask", render: renderAsk as (d: DashboardData, main: HTMLElement) => void },
  { id: "latency", label: "Latency", render: renderLatency },
  { id: "tokens", label: "Tokens", render: renderTokens },
  { id: "tools", label: "Tools", render: renderTools },
  { id: "cost", label: "Cost", render: renderCost },
  { id: "agents", label: "Agents", render: renderAgents },
  { id: "traces", label: "Traces", render: renderTraces as (d: DashboardData, main: HTMLElement) => void },
  { id: "explore", label: "Explore", render: renderExplore as (d: DashboardData, main: HTMLElement) => void },
] as const;

const mainEl = document.getElementById("view") as HTMLElement;
const tabsEl = document.getElementById("tabs") as HTMLElement;
const scopeEl = document.getElementById("scope-note") as HTMLElement;
const statusEl = document.getElementById("status-note") as HTMLElement;
const rangeEl = document.getElementById("f-range") as HTMLSelectElement;
const agentEl = document.getElementById("f-agent") as HTMLSelectElement;
const pulseWrapEl = document.getElementById("pulse-wrap") as HTMLElement;
const pulseEl = document.getElementById("pulse") as HTMLElement;
const footEl = document.getElementById("foot-note") as HTMLElement;

// Signature element: a slim, always-visible pulse of event volume that keeps
// fleet context on screen whichever tab is open.
function renderPulse(d: DashboardData): void {
  pulseEl.replaceChildren();
  const ts = d.timeseries;
  if (ts.length < 2) {
    pulseWrapEl.hidden = true;
    return;
  }
  pulseWrapEl.hidden = false;
  const W = Math.max(280, pulseEl.clientWidth || 800);
  const H = 46;
  const top = 14;
  const bottom = 4;
  const ph = H - top - bottom;
  const n = ts.length;
  const max = Math.max(1, ...ts.map((b) => b.events));
  const x = (i: number) => (i / (n - 1)) * W;
  const y = (v: number) => top + ph - (v / max) * ph;
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Event volume over the selected window" });

  let d1 = "";
  ts.forEach((b, i) => {
    d1 += `${i ? "L" : "M"}${x(i).toFixed(1)},${y(b.events).toFixed(1)}`;
  });
  const wash = svgEl("path", { d: `${d1}L${W},${H - bottom}L0,${H - bottom}Z` });
  wash.style.fill = "var(--wash)";
  svg.appendChild(wash);
  const line = svgEl("path", { d: d1, fill: "none", "stroke-width": 1.5, "stroke-linejoin": "round" });
  line.style.stroke = "var(--s1)";
  svg.appendChild(line);
  // mark only buckets whose error rate is clearly above the window's norm
  const totalEv = ts.reduce((a, b) => a + b.events, 0);
  const avgRate = totalEv ? ts.reduce((a, b) => a + b.errors, 0) / totalEv : 0;
  const threshold = Math.max(0.01, avgRate * 1.5);
  ts.forEach((b, i) => {
    if (b.events > 0 && b.errors / b.events > threshold) {
      const dot = svgEl("circle", { cx: x(i), cy: y(b.events), r: 2.4 });
      dot.style.fill = "var(--s8)";
      svg.appendChild(dot);
    }
  });

  const overlay = svgEl("rect", { x: 0, y: 0, width: W, height: H, fill: "transparent" });
  overlay.addEventListener("pointermove", (e) => {
    const rect = svg.getBoundingClientRect();
    const i = Math.max(0, Math.min(n - 1, Math.round(((e.clientX - rect.left) / rect.width) * (n - 1))));
    showTooltip(
      bucketLabel(ts[i].ts, d.meta.granularity),
      [
        { name: "events", value: fmtInt(ts[i].events), cssVar: "--s1" },
        { name: "errors", value: fmtInt(ts[i].errors), cssVar: "--s8" },
      ],
      e.clientX,
      e.clientY,
    );
  });
  overlay.addEventListener("pointerleave", hideTooltip);
  svg.appendChild(overlay);
  pulseEl.appendChild(svg);
  const details = statefulDetails("data-table pulse-data", "Show data", "pulse:data");
  const scroll = el("div", "table-scroll");
  const t = el("table");
  const thead = el("thead");
  const hr = el("tr");
  ["Bucket", "Events", "Errors"].forEach((h) => hr.appendChild(el("th", undefined, h)));
  thead.appendChild(hr);
  t.appendChild(thead);
  const tbody = el("tbody");
  ts.forEach((b) => {
    const tr = el("tr");
    [bucketLabel(b.ts, d.meta.granularity), fmtInt(b.events), fmtInt(b.errors)].forEach((c) =>
      tr.appendChild(el("td", undefined, c)),
    );
    tbody.appendChild(tr);
  });
  t.appendChild(tbody);
  scroll.appendChild(t);
  details.appendChild(scroll);
  pulseEl.appendChild(details);
}

let data: DashboardData | null = null;
const initialView = VIEWS.find((v) => v.id === HASH_STATE.view)?.id;
let currentView: (typeof VIEWS)[number]["id"] = initialView ?? "overview";
const embedded = window.parent !== window;
// agent filter arriving via a share link, applied on the first fetch
let pendingAgent: string | undefined = HASH_STATE.agent || undefined;

let syncingHash = false;
function syncHash(): void {
  if (embedded) return; // hash state is for shareable browser URLs
  const q = new URLSearchParams();
  q.set("view", currentView);
  q.set("range", rangeEl.value);
  if (agentEl.value) q.set("agent", agentEl.value);
  syncingHash = true;
  history.replaceState(null, "", `#${q}`);
  syncingHash = false;
}

// #4(r22): hash state applies on NAVIGATION too, not only at startup — a
// pasted fragment or back/forward switches the view and re-scopes once,
// without a reload. Only validated values apply; self-written hashes are
// ignored via the syncingHash guard.
window.addEventListener("hashchange", () => {
  if (embedded || syncingHash) return;
  const state = parseHashState();
  let scopeChanged = false;
  const view = VIEWS.find((v) => v.id === state.view)?.id;
  if (view && view !== currentView) {
    traceFocus = false;
    currentView = view;
  }
  if (state.range && state.range !== rangeEl.value && [...rangeEl.options].some((o) => o.value === state.range)) {
    rangeEl.value = state.range;
    rangeTouched = true;
    effectiveHours = null;
    scopeChanged = true;
  }
  const agent = state.agent ?? "";
  let pendingHashAgent: string | undefined;
  if (agent !== agentEl.value) {
    if (agent === "" || [...agentEl.options].some((o) => o.value === agent)) {
      agentEl.value = agent;
      scopeChanged = true;
    } else if (agent.length <= 200) {
      // #1(r23): the agent may only exist in the TARGET range — the current
      // range's option list cannot veto it. Carry it as the pending scope;
      // the refresh queries with it and setData adopts meta.agent
      // authoritatively (adding the option if needed) or shows the empty
      // window that agent truly has.
      pendingHashAgent = agent;
      scopeChanged = true;
    }
  }
  renderTabs();
  renderView();
  if (scopeChanged) {
    invalidateTrace();
    scheduleRefresh();
    // AFTER scheduleRefresh: it clears pendingAgent (local-beats-host-push),
    // but a hash navigation IS the newest local intent
    if (pendingHashAgent !== undefined) pendingAgent = pendingHashAgent;
  }
});

function renderTabs(): void {
  tabsEl.replaceChildren();
  for (const v of VIEWS) {
    const b = el("button", undefined, v.label);
    b.setAttribute("role", "tab");
    b.setAttribute("aria-selected", String(v.id === currentView));
    b.addEventListener("click", () => {
      traceFocus = false; // a tab is an explicit exit from the focused span view
      currentView = v.id;
      renderTabs();
      renderView();
      syncHash();
    });
    tabsEl.appendChild(b);
  }
  // #14: a directly-navigated tab (hash, host push) must be scrolled into view
  const active = tabsEl.querySelector('button[aria-selected="true"]');
  (active as HTMLElement | null)?.scrollIntoView?.({ inline: "nearest", block: "nearest" });
}

// #10(r10)/#7(r11): curated panels only follow time + the GLOBAL agent. When
// Explore carries model/tool/status filters — or an agent differing from the
// global selector — say so persistently, and re-derive it on every render so
// typed filter changes update the notice without waiting for a refresh.
function updateScopeNotice(): void {
  document.getElementById("scope-warn")?.remove();
  const f = explore.spec.filters as Record<string, string | undefined> | undefined;
  const parts: string[] = (["model", "tool", "status"] as const).filter((k) => f?.[k]);
  const globalAgent = currentAgent();
  if (f?.agent && f.agent !== globalAgent) parts.unshift("agent");
  if (!parts.length) return;
  const warn = el("span", "pill warn", `${parts.join(" + ")} filter: Explore only`);
  warn.id = "scope-warn";
  warn.title =
    "Overview/Latency/Tokens/Tools/Cost/Agents panels apply only the time window and the global agent filter.";
  scopeEl.appendChild(warn);
}

// render_trace asked for the SPAN VIEW, not the dashboard: while focused,
// only the waterfall card renders. Tabs and Close exit focus.
let traceFocus = false;

function renderView(): void {
  hideTooltip();
  updateScopeNotice();
  mainEl.replaceChildren();
  if (authRequired) {
    renderLoginPrompt(); // #17: survives resize-triggered re-renders
    return;
  }
  if (traceFocus && traceCard) {
    const back = el("button", "trace-close wf-back", "◂ Full dashboard");
    back.addEventListener("click", () => {
      traceFocus = false;
      renderView();
    });
    mainEl.appendChild(back);
    renderTraceCard(mainEl);
    return;
  }
  if (traceFocus) traceFocus = false; // the focused trace is gone — fall through
  if (!data && !(currentView === "explore" && explore.result) && currentView !== "ask" && currentView !== "traces") {
    mainEl.appendChild(el("div", "empty", "Waiting for data…"));
    renderTraceCard(mainEl); // #4(r9): a pushed waterfall must not be hidden by a failed refresh
    return;
  }
  VIEWS.find((v) => v.id === currentView)!.render(data as DashboardData, mainEl);
  renderTraceCard(mainEl); // #22: survives re-renders
}

function setData(d: DashboardData): void {
  data = d;
  inflightAgent = undefined; // the published meta.agent is authoritative now
  const hours = Math.round((Date.parse(d.meta.end) - Date.parse(d.meta.start)) / 3_600_000);
  // reflect the data's actual window in the range control when it matches a
  // preset; otherwise remember it so widget/trace/ask queries stay in sync
  if ([...rangeEl.options].some((o) => o.value === String(hours))) {
    rangeEl.value = String(hours);
    effectiveHours = null;
  } else {
    effectiveHours = hours;
  }
  scopeEl.replaceChildren();
  scopeEl.appendChild(el("span", "pill", d.meta.source === "mock" ? "sample data" : d.meta.source));
  updateScopeNotice(); // #7(r11): recomputed here AND on every Explore change
  scopeEl.appendChild(
    document.createTextNode(
      `last ${hours % 24 === 0 && hours >= 48 ? `${hours / 24} days` : `${hours} h`} · by ${d.meta.granularity}`,
    ),
  );
  // data-freshness indicator from the newest event in the window
  if (d.overview.last_event_ts) {
    const ageMs = Date.now() - Date.parse(d.overview.last_event_ts);
    const ageH = ageMs / 3_600_000;
    const badge =
      ageH < 2
        ? el("span", "fresh good", "live")
        : ageH < 48
          ? el("span", "fresh ok", `updated ${Math.round(ageH)}h ago`)
          : el("span", "fresh stale", `data ${Math.round(ageH / 24)}d old`);
    badge.title = `newest event: ${d.overview.last_event_ts}`;
    scopeEl.appendChild(badge);
  }
  const bytes = d.meta.bytes_processed;
  const fmtBytes =
    bytes == null
      ? null
      : bytes >= 1e9
        ? `${(bytes / 1e9).toFixed(2)} GB`
        : bytes >= 1e6
          ? `${(bytes / 1e6).toFixed(1)} MB`
          : `${Math.round(bytes / 1e3)} KB`;
  footEl.textContent =
    `BigQuery Agent Analytics · ${fmtCompact(d.overview.total_events)} events in window · updated ${new Date(
      d.meta.end,
    ).toLocaleString("en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}` +
    (fmtBytes ? ` · ${fmtBytes} scanned${d.meta.cache_hit ? " (cached)" : ""}` : "");
  renderPulse(d);
  agentEl.replaceChildren();
  const all = el("option", undefined, "All agents");
  all.value = "";
  agentEl.appendChild(all);
  for (const a of d.agentsList) {
    const o = el("option", undefined, a);
    o.value = a;
    agentEl.appendChild(o);
  }
  // #12: the payload's own scope is authoritative — the selector must show
  // the agent this data was actually filtered by, not a stale prior choice
  const dataAgent = d.meta.agent ?? "";
  if (dataAgent && !d.agentsList.includes(dataAgent)) {
    const extra = el("option", undefined, dataAgent);
    extra.value = dataAgent;
    agentEl.appendChild(extra);
  }
  agentEl.value = dataAgent;
  // one failed panel must not read as "no data" — say which panels failed
  const failed = Object.keys(d.meta.section_errors ?? {});
  if (failed.length) {
    statusEl.textContent = `${failed.length} panel${failed.length > 1 ? "s" : ""} failed to load: ${failed.join(", ")}`;
    statusEl.classList.add("error");
  } else {
    statusEl.textContent = "";
    statusEl.classList.remove("error");
  }
  syncHash();
  renderView();
}

function extractData(result: any): DashboardData | null {
  const sc = result?.structuredContent;
  if (sc?.data?.overview) return sc.data as DashboardData;
  for (const c of result?.content ?? []) {
    if (c.type === "text") {
      try {
        const parsed = JSON.parse(c.text);
        if (parsed?.data?.overview) return parsed.data;
        if (parsed?.overview) return parsed;
      } catch {
        /* not JSON — skip */
      }
    }
  }
  return null;
}

let appBridge: App | null = null;

// Standalone (no MCP host): served over HTTP the page fetches live data from
// its own server, and a failed fetch is a real error — never silently
// replaced with sample data. Only the from-disk (file://) preview uses mocks.
async function fetchStandalone(
  hours: number | null,
  agent: string | undefined,
  signal: AbortSignal,
): Promise<DashboardData> {
  if (location.protocol.startsWith("http")) {
    // hours === null → let the server apply its configured default window
    const q = new URLSearchParams();
    if (hours != null) q.set("time_range_hours", String(hours));
    if (agent) q.set("agent", agent);
    const res = await fetch(`api/dashboard?${q}`, { signal, headers: authHeaders() });
    let body: any = null;
    try {
      body = await res.json();
    } catch {
      throw new Error(`HTTP ${res.status}: response was not JSON`);
    }
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    if (!body?.data?.overview) throw new Error("malformed dashboard payload");
    return body.data as DashboardData;
  }
  const h = hours ?? Number(rangeEl.value);
  const end = new Date();
  const start = new Date(end.getTime() - h * 3_600_000);
  return mockDashboard(start, end, h <= 72 ? "hour" : "day", agent ?? null);
}

// Token sign-in for protected servers: the token is exchanged for an HttpOnly
// cookie via POST /auth/login and never appears in a URL. The prompt is app
// STATE (#17) — a resize/re-render rebuilds it instead of erasing it.
let authRequired = false;
let loginDraft = ""; // #15: a half-typed token survives resize re-renders

function renderLoginPrompt(): void {
  authRequired = true;
  statusEl.textContent = "";
  statusEl.classList.remove("error");
  mainEl.classList.remove("loading");
  mainEl.replaceChildren();
  const { card, body } = chartCard("Sign in", "this dashboard requires an access token", []);
  const row = el("div", "ask-row");
  const input = el("input", "ask-input") as HTMLInputElement;
  input.type = "password";
  input.placeholder = "Access token";
  input.setAttribute("aria-label", "Access token");
  input.value = loginDraft;
  input.addEventListener("input", () => {
    loginDraft = input.value;
  });
  const btn = el("button", "run-btn", "Sign in");
  const note = el("div", "sub", "");
  const submit = async (): Promise<void> => {
    btn.disabled = true;
    const ok = await loginWithToken(input.value).catch(() => false);
    if (ok) {
      authRequired = false;
      loginDraft = "";
      void refresh();
    } else {
      btn.disabled = false;
      note.textContent = "Invalid token — try again.";
    }
  };
  btn.addEventListener("click", () => void submit());
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") void submit();
  });
  row.appendChild(input);
  row.appendChild(btn);
  body.appendChild(row);
  body.appendChild(note);
  mainEl.appendChild(card);
  input.focus();
}

let rangeTouched = false;

// Only the most recent refresh may publish results: a slow older request must
// never overwrite newer filters (monotonic sequence + abort for HTTP).
let refreshSeq = 0;
let inflightAbort: AbortController | null = null;
// #9: host tool calls cannot be cancelled, so embedded refreshes are
// single-flight — while one is in flight, newer scopes queue (latest only)
// and rerun after it settles instead of stacking 10-query loads.
let embeddedRefreshBusy = false;
let embeddedRefreshQueued = false;

async function refresh(): Promise<void> {
  if (embedded && embeddedRefreshBusy) {
    embeddedRefreshQueued = true; // controls/pendingAgent stay untouched for the rerun
    refreshSeq++; // #5(r7): the in-flight refresh must not publish or reset controls
    return;
  }
  const seq = ++refreshSeq;
  inflightAbort?.abort();
  const abort = new AbortController();
  inflightAbort = abort;

  const hours = currentHours(); // #18: honor a non-preset effective window
  // #6(r5): a pushed scope is authoritative — "" is the explicit all-agents
  // sentinel and must CLEAR a previously selected agent, not defer to it
  const pushed = pendingAgent;
  pendingAgent = undefined;
  const agent = pushed !== undefined ? pushed || undefined : agentEl.value || undefined;
  inflightAgent = agent ?? ""; // #1(r24): the consumed scope stays visible to currentAgent()
  mainEl.classList.add("loading");
  statusEl.textContent = "Refreshing…";
  statusEl.classList.remove("error");
  try {
    let d: DashboardData | null;
    if (embedded && appBridge) {
      embeddedRefreshBusy = true;
      try {
        const result = await appBridge.callServerTool({
          name: "query_agent_metrics",
          arguments: { time_range_hours: hours, ...(agent ? { agent } : {}) },
        });
        d = extractData(result);
      } finally {
        embeddedRefreshBusy = false;
        if (embeddedRefreshQueued) {
          embeddedRefreshQueued = false;
          setTimeout(() => void refresh(), 0); // rerun with the latest scope
        }
      }
      if (!d) throw new Error("no data in tool result");
    } else {
      d = await fetchStandalone(rangeTouched ? hours : null, agent, abort.signal);
    }
    if (seq !== refreshSeq) return; // superseded by a newer request
    setData(d);
  } catch (e) {
    if (seq !== refreshSeq || (e instanceof DOMException && e.name === "AbortError")) return;
    const detail = e instanceof Error ? e.message : String(e);
    if (!embedded && isUnauthorized(detail)) {
      renderLoginPrompt();
      return;
    }
    statusEl.textContent = data
      ? `Refresh failed: ${detail} — showing previously loaded data`
      : `Load failed: ${detail}`;
    statusEl.classList.add("error");
  } finally {
    if (seq === refreshSeq) mainEl.classList.remove("loading");
  }
}

// ------------------------------------------------------------ trace drill-down

async function fetchTrace(traceId: string, signal?: AbortSignal): Promise<{ events: TraceEvent[]; truncated: boolean }> {
  const hours = currentHours();
  if (embedded && appBridge) {
    const result: any = await appBridge.callServerTool({
      name: "get_trace",
      arguments: { trace_id: traceId, time_range_hours: hours },
    });
    const d = result?.structuredContent?.data;
    if (Array.isArray(d?.events)) return { events: d.events, truncated: !!d.truncated };
    if (Array.isArray(d)) return { events: d, truncated: false }; // older servers
    throw new Error("no trace data in tool result");
  }
  if (location.protocol.startsWith("http")) {
    const q = new URLSearchParams({ trace_id: traceId, time_range_hours: String(hours) });
    const res = await fetch(`api/trace?${q}`, { headers: authHeaders(), signal });
    const body: any = await res.json().catch(() => null);
    if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status}`);
    return { events: body?.data ?? [], truncated: !!body?.truncated };
  }
  return { events: mockTrace(traceId, currentHours()), truncated: false }; // r15 residual: preview honors the active window
}

// #22: the open trace lives in state and is re-rendered after any full
// re-render (resize, refresh) instead of being silently destroyed.
interface TraceCardState {
  traceId: string;
  view: string; // the tab the trace was opened from
  events: TraceEvent[] | null; // null while loading
  truncated: boolean;
  error: string | null;
}
let traceCard: TraceCardState | null = null;
// #6: a trace fetched under an old window must not publish under a new one
let traceGen = 0;
let traceAbort: AbortController | null = null;

// canonical error semantics on the client, matching the SQL predicate (#10)
function isErrorEvent(e: TraceEvent): boolean {
  return e.status === "ERROR" || e.event_type.endsWith("_ERROR") || e.error_message != null;
}

// Waterfall: spans as duration bars on a shared time axis, indented by
// parent-child depth — the classic tracing view (LLM=blue, tool=orange,
// other=aqua; errors outlined and labeled, never color-alone).
// Expansion state for the CURRENT trace: collapsed parents hide their whole
// subtree; expanded leaves show an inline detail row. Reset per trace.
let wfStateTraceId: string | null = null;
const wfCollapsed = new Set<string>();
const wfExpandedDetails = new Set<string>();
// #3(r13): Enter/Space toggles rebuild the DOM — the toggled row's key is
// remembered so the recreated row receives focus instead of BODY
let wfPendingFocusKey: string | null = null;

function resetWaterfallState(traceId: string): void {
  if (wfStateTraceId !== traceId) {
    wfStateTraceId = traceId;
    wfCollapsed.clear();
    wfExpandedDetails.clear();
  }
}

function renderWaterfall(container: HTMLElement, events: TraceEvent[]): void {
  const { spans, totalMs } = buildSpans(events);
  if (!spans.length) return;

  const legend = el("div", "legend");
  for (const item of [
    { name: "LLM", cssVar: "--s1" },
    { name: "Tool", cssVar: "--s2" },
    { name: "Other", cssVar: "--s3" },
  ]) {
    const it = el("span", "item");
    const key = el("span", "key-rect");
    key.style.background = `var(${item.cssVar})`;
    it.appendChild(key);
    it.appendChild(document.createTextNode(item.name));
    legend.appendChild(it);
  }
  const errKey = el("span", "item");
  errKey.appendChild(el("span", "wf-err-key"));
  errKey.appendChild(document.createTextNode("Error"));
  legend.appendChild(errKey);
  container.appendChild(legend);

  const wf = el("div", "waterfall");
  // time axis with ~4 clean ticks
  const axis = el("div", "wf-axis");
  axis.appendChild(el("span", "wf-axis-label", ""));
  const ticksWrap = el("div", "wf-ticks");
  // #8(r10): density must follow the TRACK the labels actually live in — the
  // panel is wider than the track by the row-label column, so panel-based
  // counts overlap at 320px. Build from the panel as a first guess, then
  // remeasure the mounted track and rebuild if the answer differs.
  const buildTicks = (width: number): void => {
    ticksWrap.replaceChildren();
    const divisions = width < 200 ? 1 : width < 340 ? 2 : width < 560 ? 3 : 4;
    for (let t = 0; t <= divisions; t++) {
      const tick = el("span", "wf-tick", fmtMs((totalMs / divisions) * t));
      tick.style.left = `${(t / divisions) * 100}%`;
      if (t === divisions) tick.classList.add("last"); // anchored inside the track
      ticksWrap.appendChild(tick);
    }
  };
  buildTicks(Math.max(0, (mainEl.clientWidth || 800) - 120));
  requestAnimationFrame(() => {
    if (ticksWrap.isConnected && ticksWrap.clientWidth > 0) buildTicks(ticksWrap.clientWidth);
  });
  axis.appendChild(ticksWrap);
  wf.appendChild(axis);

  const kindVar: Record<string, string> = { llm: "--s1", tool: "--s2", other: "--s3" };
  const hasChildren = new Set<string>();
  for (const sp of spans) if (sp.parentId) hasChildren.add(sp.parentId);
  // #5(r13): visited-set walk — ancestry is unbounded now that parentId
  // survives the display-depth cap, and a malformed link can never loop
  const hiddenByCollapse = (sp: (typeof spans)[number]): boolean => {
    const visited = new Set<string>();
    let p = sp.parentId;
    while (p && !visited.has(p)) {
      if (wfCollapsed.has(p)) return true;
      visited.add(p);
      p = spans.find((x) => x.id === p)?.parentId ?? null;
    }
    return false;
  };
  spans.forEach((span, spanIdx) => {
    if (hiddenByCollapse(span)) return;
    const key = span.id ?? `orphan:${spanIdx}`;
    const parent = span.id != null && hasChildren.has(span.id);
    const row = el("div", "wf-row");
    row.tabIndex = 0;
    row.setAttribute("role", "button");
    row.dataset.wfKey = key; // #3(r13): stable identity for focus restoration
    // parents expose subtree state; leaves expose detail-row state
    row.setAttribute("aria-expanded", String(parent ? !wfCollapsed.has(span.id!) : wfExpandedDetails.has(key)));
    const chevron = parent ? (wfCollapsed.has(span.id!) ? "▸ " : "▾ ") : "";
    const label = el("span", "wf-label", `${chevron}${span.error ? "! " : ""}${span.name}`);
    label.style.paddingLeft = `${span.depth * 12}px`;
    if (span.error) label.classList.add("error");
    if (parent) label.classList.add("wf-parent");
    row.appendChild(label);
    const track = el("span", "wf-track");
    const left = Math.min(99, (span.startMs / totalMs) * 100);
    if (span.instant) {
      const dot = el("span", "wf-dot");
      dot.style.left = `${left}%`;
      dot.style.background = `var(${kindVar[span.kind]})`;
      track.appendChild(dot);
    } else {
      const bar = el("span", `wf-bar${span.error ? " error" : ""}`);
      bar.style.left = `${left}%`;
      bar.style.width = `${Math.max(0.8, ((span.endMs - span.startMs) / totalMs) * 100)}%`;
      bar.style.background = `var(${kindVar[span.kind]})`;
      track.appendChild(bar);
    }
    row.appendChild(track);
    row.appendChild(el("span", "wf-dur", span.instant ? "·" : fmtMs(span.endMs - span.startMs)));
    const present = (x: number, y: number): void =>
      showTooltip(span.name, [
        { name: "start", value: `+${(span.startMs / 1000).toFixed(2)}s` },
        { name: "duration", value: span.instant ? "instant" : fmtMs(span.endMs - span.startMs), cssVar: kindVar[span.kind] },
        ...(span.agent ? [{ name: "agent", value: span.agent }] : []),
        ...(span.error ? [{ name: "status", value: span.detail || "ERROR", cssVar: "--s8" }] : []),
        ...(!span.error && span.detail ? [{ name: "detail", value: span.detail }] : []),
      ], x, y);
    row.addEventListener("pointermove", (e) => present(e.clientX, e.clientY));
    row.addEventListener("pointerleave", hideTooltip);
    row.addEventListener("focus", () => {
      const r = row.getBoundingClientRect();
      present(r.left + r.width / 2, r.bottom);
    });
    row.addEventListener("blur", hideTooltip);
    // click to dive deeper: parents toggle their subtree, leaves toggle an
    // inline detail row (agent, timing, tool origin / error / response)
    const toggle = (): void => {
      hideTooltip();
      if (parent) {
        if (wfCollapsed.has(span.id!)) wfCollapsed.delete(span.id!);
        else wfCollapsed.add(span.id!);
      } else if (wfExpandedDetails.has(key)) {
        wfExpandedDetails.delete(key);
      } else {
        wfExpandedDetails.add(key);
      }
      wfPendingFocusKey = key; // #3(r13): the rerender must give focus back
      renderView();
    };
    row.addEventListener("click", toggle);
    row.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        toggle();
      }
    });
    wf.appendChild(row);
    if (!parent && wfExpandedDetails.has(key)) {
      const detail = el("div", "wf-detail");
      detail.style.paddingLeft = `${span.depth * 12 + 14}px`;
      const line = (name: string, value: string): void => {
        const d = el("div", "wf-detail-line");
        d.appendChild(el("span", "wf-detail-k", name));
        d.appendChild(el("span", undefined, value));
        detail.appendChild(d);
      };
      line("start", `+${(span.startMs / 1000).toFixed(2)}s`);
      line("duration", span.instant ? "instant" : fmtMs(span.endMs - span.startMs));
      if (span.agent) line("agent", span.agent);
      if (span.error) line("status", span.detail || "ERROR");
      else if (span.detail) line("detail", span.detail);
      wf.appendChild(detail);
    }
  });
  container.appendChild(wf);
  if (wfPendingFocusKey != null) {
    const focusKey = wfPendingFocusKey;
    wfPendingFocusKey = null;
    requestAnimationFrame(() => {
      const target = wf.querySelector<HTMLElement>(`[data-wf-key="${CSS.escape(focusKey)}"]`);
      target?.focus();
    });
  }
}

function renderTraceCard(main: HTMLElement): void {
  const t = traceCard;
  if (!t || (!traceFocus && t.view !== currentView)) return;
  resetWaterfallState(t.traceId);
  const { card, body } = chartCard(`Trace ${t.traceId}`, "ordered agent_events for this trace", []);
  card.id = "trace-card";
  const h2 = card.querySelector("h2")!;
  const head = el("div", "trace-head");
  h2.replaceWith(head);
  head.appendChild(h2);
  const close = el("button", "trace-close", "Close");
  close.addEventListener("click", () => {
    // #4(r11): Close is an intent — in-flight AND queued trace loads die with it
    traceGen++;
    traceAbort?.abort();
    traceIntentEpoch++;
    embeddedTraceQueued = null;
    traceCard = null;
    if (traceFocus) {
      traceFocus = false; // leaving the focused span view returns to the dashboard
      renderView();
      return;
    }
    card.remove();
  });
  head.appendChild(close);

  if (t.error) {
    body.appendChild(el("div", "empty error", `Trace load failed: ${t.error}`));
  } else if (!t.events) {
    body.appendChild(el("div", "empty", "Loading trace…"));
  } else if (!t.events.length) {
    body.appendChild(el("div", "empty", "No events found for this trace in the selected window"));
  } else {
    renderWaterfall(body, t.events);
    const log = statefulDetails("data-table", "Event log", `trace-log:${t.traceId}`);
    const t0 = Date.parse(t.events[0].timestamp);
    const list = el("div", "trace-timeline");
    for (const e of t.events) {
      const row = el("div", `trace-row${isErrorEvent(e) ? " error" : ""}`);
      row.appendChild(el("span", "trace-t", `+${((Date.parse(e.timestamp) - t0) / 1000).toFixed(1)}s`));
      row.appendChild(el("span", "trace-type", e.event_type));
      const detail =
        e.error_message ??
        (e.tool_name
          ? `${e.tool_name}${e.tool_origin ? ` (${e.tool_origin})` : ""}`
          : (e.llm_response ?? e.agent ?? ""));
      const detailEl = el("span", "trace-detail", detail ?? "");
      if (detail) detailEl.title = detail;
      row.appendChild(detailEl);
      row.appendChild(el("span", "trace-lat", e.latency_ms != null ? fmtMs(e.latency_ms) : ""));
      list.appendChild(row);
    }
    log.appendChild(list);
    body.appendChild(log);
    if (t.truncated) {
      body.appendChild(
        el("div", "sub", `Showing the first ${t.events.length} events — the trace is longer; narrow the time window for the rest.`),
      );
    }
  }
  main.appendChild(card);
}

// #3(r9): host tool calls cannot be cancelled, so embedded trace loads are
// single-flight — rapid clicks queue only the LATEST trace id instead of
// stacking concurrent get_trace jobs against the shared admission cap.
let embeddedTraceBusy = false;
let embeddedTraceQueued: string | null = null;
// #2(r10): a host-pushed trace is the newest intent — it advances this epoch
// and clears the queue, and a captured dequeue must recheck before starting
let traceIntentEpoch = 0;

async function showTrace(traceId: string): Promise<void> {
  if (embedded && embeddedTraceBusy) {
    embeddedTraceQueued = traceId;
    return;
  }
  const gen = ++traceGen;
  traceAbort?.abort();
  const abort = new AbortController();
  traceAbort = abort;
  traceCard = { traceId, view: currentView, events: null, truncated: false, error: null };
  renderView();
  document.getElementById("trace-card")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  focusTraceCard(); // #3(r22): the clicked list button was just replaced
  if (embedded) embeddedTraceBusy = true;
  try {
    const { events, truncated } = await fetchTrace(traceId, abort.signal);
    if (gen !== traceGen || traceCard?.traceId !== traceId) return; // window changed or replaced
    traceCard = { ...traceCard, events, truncated };
  } catch (err) {
    if (gen !== traceGen || traceCard?.traceId !== traceId) return;
    if (err instanceof DOMException && err.name === "AbortError") return;
    traceCard = { ...traceCard, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (embedded) {
      if (embeddedTraceQueued) {
        const next = embeddedTraceQueued;
        embeddedTraceQueued = null;
        const epoch = traceIntentEpoch; // #2(r10)
        setTimeout(() => {
          embeddedTraceBusy = false;
          if (epoch !== traceIntentEpoch) return; // a host trace arrived meanwhile
          const latest = embeddedTraceQueued ?? next;
          embeddedTraceQueued = null;
          void showTrace(latest);
        }, 0);
      } else {
        embeddedTraceBusy = false;
      }
    }
  }
  const restoreFocus = snapshotFocusForTrace(); // #4(r23): decide BEFORE replacing the DOM
  renderView();
  restoreFocus();
}

// #4(r23): the loaded trace render must not STEAL focus — it may claim it
// only when the user still owned the old trace card (or already lost focus
// to BODY). A user who moved to another control mid-load keeps that control:
// we re-find its recreated equivalent by wf-key, id, or class+label.
function snapshotFocusForTrace(): () => void {
  const prev = document.activeElement as HTMLElement | null;
  if (!prev || prev === document.body || prev.closest("#trace-card")) {
    return () => focusTraceCard();
  }
  const wfKey = prev.dataset?.wfKey;
  const id = prev.id;
  const cls = (prev.className || "").split(" ")[0];
  const parentCls = ((prev.parentElement?.className as string) || "").split(" ")[0];
  const text = prev.textContent;
  return () => {
    if (document.activeElement !== document.body) return; // their control survived
    let target: HTMLElement | null = null;
    if (wfKey) target = document.querySelector<HTMLElement>(`[data-wf-key="${CSS.escape(wfKey)}"]`);
    else if (id) target = document.getElementById(id);
    else if (cls) {
      target = [...document.querySelectorAll<HTMLElement>(`.${CSS.escape(cls)}`)].find((e) => e.textContent === text) ?? null;
    } else if (parentCls) {
      target = document.querySelector<HTMLElement>(`.${CSS.escape(parentCls)} ${prev.tagName.toLowerCase()}`);
    }
    target?.focus(); // and if we cannot re-find it, we take NOTHING
  };
}

// #3(r22): rerenders replace the element that held keyboard focus — when
// focus fell back to BODY, move it into the trace card (the first waterfall
// row once loaded, else Close) so keyboard flows continue from the card.
function focusTraceCard(): void {
  if (document.activeElement !== document.body) return; // the user still has a target
  const card = document.getElementById("trace-card");
  if (!card) return;
  const target = card.querySelector<HTMLElement>(".wf-row") ?? card.querySelector<HTMLElement>(".trace-close");
  target?.focus();
}

function invalidateTrace(): void {
  traceGen++;
  traceAbort?.abort();
  traceIntentEpoch++; // #4(r11): queued trace dispatches lose their intent too
  embeddedTraceQueued = null;
  traceCard = null; // an open trace belongs to the previous window
  invalidateAskScope(); // #5(r5): pending Ask answers belong to the old scope too
}

// #16: rapid filter changes coalesce into one refresh instead of racing
// several 10-query loads against the job-slot cap. #5(r7): the generation is
// invalidated IMMEDIATELY — not at debounce expiry — so an in-flight refresh
// (embedded included) loses publication rights the moment the scope changes
// and can never reset the controls before the queued rerun reads them.
let refreshDebounce: ReturnType<typeof setTimeout> | undefined;
function scheduleRefresh(): void {
  refreshSeq++; // stale publication is dead from this instant
  inflightAbort?.abort(); // standalone work stops before the debounce, too
  pendingAgent = undefined; // #3(r8): a LOCAL choice outranks any queued host push
  inflightAgent = undefined; // #1(r24): and outranks the superseded refresh's scope
  exploreSpecChanged(); // #15(r9): Explore results computed under the old scope are stale
  tracesGen++; // the trace-explorer list belongs to the old scope too
  tracesAbort?.abort();
  tracesState.rows = null;
  tracesState.loading = false;
  tracesState.error = null; // #1(r13): a stale error must not block the new scope
  tracesState.key = "";
  clearTimeout(refreshDebounce);
  refreshDebounce = setTimeout(() => void refresh(), 250);
}

rangeEl.addEventListener("change", () => {
  rangeTouched = true;
  effectiveHours = null; // user picked a preset — it wins
  invalidateTrace();
  scheduleRefresh();
});
agentEl.addEventListener("change", () => {
  invalidateTrace();
  scheduleRefresh();
});

let resizeTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleRerender(): void {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    renderView();
    if (data) renderPulse(data);
    renderTabs(); // #20(r5): keep the active tab scrolled into view after resize
  }, 150);
}
window.addEventListener("resize", scheduleRerender);
// MCP hosts can resize the iframe's content box without firing window.resize
let lastMainW = mainEl.clientWidth;
new ResizeObserver(() => {
  const w = mainEl.clientWidth;
  if (Math.abs(w - lastMainW) < 8) return;
  lastMainW = w;
  scheduleRerender();
}).observe(mainEl);

// share-link state: restore the time range before the first fetch
if (HASH_STATE.range && [...rangeEl.options].some((o) => o.value === HASH_STATE.range)) {
  rangeEl.value = HASH_STATE.range;
  rangeTouched = true;
}

renderTabs();
renderView();

if (embedded) {
  const app = new App({ name: "BQAA Dashboard", version: "0.1.0" });
  app.ontoolresult = (result: any) => {
    const payload = result?.structuredContent?.data;
    // render_widget pushes a widget result: open Explore prefilled + rendered,
    // then sync the dashboard to the same scope for every other tab (#17).
    if (payload?.spec && Array.isArray(payload.rows)) {
      exploreOpSeq++; // supersede any in-flight Explore op
      invalidateTrace(); // #7: an open trace belongs to the previous scope
      explore.spec = { v: 1, filters: {}, ...payload.spec };
      if (payload.dry_run) {
        // #9(r10): a cost estimate is NOT a data result — rendering it as one
        // would claim the scoped query returned no rows
        explore.estimate = payload.estimated_bytes ?? null;
        explore.result = null;
      } else {
        explore.result = payload as WidgetResult;
        explore.estimate = null;
      }
      // keep the pushed widget's window as the effective one
      if (payload.window?.start && payload.window?.end) {
        const h = Math.round((Date.parse(payload.window.end) - Date.parse(payload.window.start)) / 3_600_000);
        if ([...rangeEl.options].some((o) => o.value === String(h))) {
          rangeEl.value = String(h);
          effectiveHours = null;
        } else {
          effectiveHours = h;
        }
      }
      // promote the pushed scope so curated tabs match the widget; an absent
      // agent filter means ALL agents and must clear any previous selection
      pendingAgent = payload.spec.filters?.agent ?? "";
      currentView = "explore";
      renderTabs();
      renderView();
      void refresh(); // always re-sync the dashboard to the pushed scope
      return;
    }
    // render_trace pushes a trace: open the waterfall card on the current view
    if (payload?.trace_id && Array.isArray(payload.events)) {
      traceGen++; // supersede any in-flight local trace fetch
      traceAbort?.abort();
      // #2(r10): revoke any QUEUED local trace too — latest-host-wins
      traceIntentEpoch++;
      embeddedTraceQueued = null;
      // #1(r9): adopt the pushed trace's window so the surrounding dashboard
      // is labeled and refreshed with the SAME scope the trace was fetched in
      const h = Math.trunc(Number(payload.time_range_hours));
      if (Number.isInteger(h) && h > 0) {
        if ([...rangeEl.options].some((o) => o.value === String(h))) {
          rangeEl.value = String(h);
          effectiveHours = null;
        } else {
          effectiveHours = h;
        }
      }
      traceCard = {
        traceId: payload.trace_id,
        view: currentView,
        events: payload.events as TraceEvent[],
        truncated: !!payload.truncated,
        error: null,
      };
      traceFocus = true; // render_trace asked for the span view, not the dashboard
      renderView();
      document.getElementById("trace-card")?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      // #3(r10): the pushed window is a GLOBAL scope change — already-loaded
      // panels, pending Ask answers, and Explore results all belong to the
      // old window. Invalidate them and re-query; the pushed trace stays.
      invalidateAskScope();
      scheduleRefresh();
      return;
    }
    // a host push is the newest truth — invalidate in-flight refreshes and
    // any trace whose scope no longer matches (#7)
    const d = extractData(result);
    if (d) {
      refreshSeq++;
      inflightAbort?.abort();
      embeddedRefreshQueued = false; // #4(r11): the host result IS the rerun
      invalidateTrace();
      setData(d);
    }
  };
  appBridge = app;
  app
    .connect()
    .catch((e: unknown) => {
      statusEl.textContent = `Host connection failed: ${e instanceof Error ? e.message : String(e)}`;
      statusEl.classList.add("error");
    });
} else {
  // Standalone preview (opened directly in a browser): sample data.
  void refresh();
}
