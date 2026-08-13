// BQAA Dashboard MCP App server.
// Design: GoogleCloudPlatform/BigQuery-Agent-Analytics-SDK#396
//
// Tools:
//   show_agent_dashboard  — renders the interactive dashboard (ui:// resource)
//   query_agent_metrics   — same payload without UI; used by the iframe to refresh
//   get_trace             — trace reconstruction for drill-down
//
// HTTP surface: GET / (dashboard webapp), GET /api/dashboard, GET /api/trace,
// POST /mcp, GET /healthz.
//
// Config (env): BQAA_PROJECT, BQAA_DATASET, BQAA_TABLE, BQAA_MOCK=1,
// BQAA_MAX_BYTES_BILLED (per refresh), BQAA_DEFAULT_HOURS, BQAA_AUTH_TOKEN,
// BQAA_ALLOWED_ORIGINS, PORT. See README for details.

import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  registerAppTool,
  registerAppResource,
  RESOURCE_MIME_TYPE,
} from "@modelcontextprotocol/ext-apps/server";
import { askConversational } from "./src/ca.js";
import { mockAsk, mockDashboard, mockErrorTraces, mockTrace, mockTracesList, mockWidget } from "./src/mock.js";
import {
  BQ_MIN_BYTES_PER_QUERY,
  buildDashboardSql,
  buildErrorTracesSql,
  buildTracesListSql,
  buildTraceSql,
  buildWidgetSql,
  SECTIONS,
  splitBudget,
  WIDGET_DIMENSIONS,
  WIDGET_MEASURES,
  widgetSpecError,
  applyCostBucketBound,
  applyModelBound,
} from "./src/queries.js";
import type {
  AskExchange,
  AskResult,
  DashboardData,
  ErrorTraceRow,
  Granularity,
  OverviewStats,
  TraceEvent,
  TraceResult,
  WidgetResult,
  WidgetSpec,
 TraceListRow,} from "./src/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- config

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw == null || raw === "") return fallback;
  const v = Number(raw);
  if (!Number.isInteger(v) || v < min || v > max) {
    console.error(`Invalid ${name}=${JSON.stringify(raw)} — expected an integer in [${min}, ${max}]`);
    process.exit(1);
  }
  return v;
}

const MAX_HOURS = 2160; // 90 days

const CONFIG = {
  project: process.env.BQAA_PROJECT ?? "",
  dataset: process.env.BQAA_DATASET ?? "agent_analytics",
  table: process.env.BQAA_TABLE ?? "agent_events",
  // Mock only when EXPLICITLY requested, or (dev convenience) when no project
  // is set outside production. In production the absence of a project is a
  // configuration error, not a silent switch to synthetic data.
  mock: process.env.BQAA_MOCK === "1" || (!process.env.BQAA_PROJECT && process.env.NODE_ENV !== "production"),
  // Budget for ONE dashboard refresh (split across its queries), in bytes.
  // Minimum = SECTIONS x BigQuery's 10 MiB floor for maximumBytesBilled —
  // anything smaller would make every panel query invalid.
  refreshBytesBudget: intEnv(
    "BQAA_MAX_BYTES_BILLED",
    2_000_000_000,
    SECTIONS.length * BQ_MIN_BYTES_PER_QUERY,
    1_000_000_000_000,
  ),
  // Application deadline for a single BigQuery query (job is cancelled on expiry).
  queryTimeoutMs: intEnv("BQAA_QUERY_TIMEOUT_MS", 90_000, 500, 600_000),
  port: intEnv("PORT", 3001, 0, 65535),
  // #10: local live mode binds loopback; containers set BQAA_HOST=0.0.0.0
  host: process.env.BQAA_HOST ?? (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"),
  defaultHours: intEnv("BQAA_DEFAULT_HOURS", 168, 1, MAX_HOURS),
  authToken: process.env.BQAA_AUTH_TOKEN ?? "",
  // The service's own public origin (e.g. https://app.example.run.app) —
  // the only non-loopback origin granted the same-origin exemption.
  canonicalOrigin: (process.env.BQAA_CANONICAL_ORIGIN ?? "").replace(/\/+$/, ""),
  // Set BQAA_CA_DISABLED=1 for strict BigQuery-only deployments: disables the
  // Ask path (which sends questions + schema context to Gemini Data Analytics).
  caDisabled: process.env.BQAA_CA_DISABLED === "1",
  // Comma-separated Origin allowlist, or "*". Unset ⇒ same-origin only:
  // no CORS headers, and cross-origin requests bearing an Origin are refused.
  allowedOrigins: (process.env.BQAA_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
};

// Test seam: BQAA_FAKE_BQ swaps in a controllable fake client. It is refused
// outright in production builds, and every payload it produces is labeled —
// synthetic rows must be impossible to mistake for live telemetry.
const FAKE_BQ = process.env.NODE_ENV !== "production" ? (process.env.BQAA_FAKE_BQ ?? "") : "";
// #3(r24): a deterministic Conversational Analytics seam so Ask concurrency
// tests never touch ADC or googleapis. "slow" answers after a delay (holding
// its admission slot the whole time); production refuses it like BQAA_FAKE_BQ.
const FAKE_CA = process.env.NODE_ENV !== "production" ? (process.env.BQAA_FAKE_CA ?? "") : "";
if (process.env.BQAA_FAKE_CA && process.env.NODE_ENV === "production") {
  console.error("BQAA_FAKE_CA is test-only and cannot be enabled in production builds");
  process.exit(1);
}
if (process.env.BQAA_FAKE_BQ && process.env.NODE_ENV === "production") {
  console.error("BQAA_FAKE_BQ is test-only and cannot be enabled in production builds");
  process.exit(1);
}

const PROJECT_RE = /^[A-Za-z0-9_.:-]+$/;
const ID_RE = /^[A-Za-z0-9_]+$/;
const TRACE_ID_RE = /^[A-Za-z0-9_-]{4,64}$/;

function tableRef(): string {
  if (!PROJECT_RE.test(CONFIG.project)) throw new Error(`Invalid BQAA_PROJECT: ${CONFIG.project}`);
  if (!ID_RE.test(CONFIG.dataset)) throw new Error(`Invalid BQAA_DATASET: ${CONFIG.dataset}`);
  if (!ID_RE.test(CONFIG.table)) throw new Error(`Invalid BQAA_TABLE: ${CONFIG.table}`);
  return "`" + `${CONFIG.project}.${CONFIG.dataset}.${CONFIG.table}` + "`";
}
if (process.env.NODE_ENV === "production" && !process.env.BQAA_PROJECT && process.env.BQAA_MOCK !== "1") {
  console.error("BQAA_PROJECT is required in production (or set BQAA_MOCK=1 explicitly for a demo)");
  process.exit(1);
}
if (!CONFIG.mock) tableRef(); // fail fast on invalid identifiers

// Every payload names its true source; synthetic backends are always labeled.
function sourceLabel(): string {
  if (CONFIG.mock) return "mock";
  return `${CONFIG.project}.${CONFIG.dataset}.${CONFIG.table}${FAKE_BQ ? ` [FAKE_BQ:${FAKE_BQ} — synthetic test data]` : ""}`;
}
const SYNTHETIC = (): boolean => CONFIG.mock || !!FAKE_BQ;

function uiBundlePath(): string {
  // src layout: <root>/dist/mcp-app.html — container layout: <dist>/mcp-app.html
  for (const p of [path.join(__dirname, "dist", "mcp-app.html"), path.join(__dirname, "mcp-app.html")]) {
    if (existsSync(p)) return p;
  }
  return path.join(__dirname, "dist", "mcp-app.html");
}

// ---------------------------------------------------------------- BigQuery

let bqClient: import("@google-cloud/bigquery").BigQuery | null = null;

// Global cap on simultaneous BigQuery jobs: past it, requests fail fast
// instead of piling unbounded work onto the project. Abandoned creations —
// jobs whose createQueryJob was still pending when their request's deadline
// or abort fired — keep counting against the cap until they settle (with a
// safety-valve timeout), so the advertised cap covers the FULL lifecycle (#2).
const MAX_CONCURRENT_JOBS = 20;
let inflightJobs = 0;
let abandonedCreations = 0;

// #5(r11): ownership is held until the creation RPC actually SETTLES — no
// timer valve. A timer that released the slot while createQueryJob was still
// pending let repeated stalls exceed the documented 20-job cap. The trade is
// explicit: a transport-level permanent hang now consumes its slot until the
// process recycles, because the cap is a promise about concurrently live
// BigQuery work, not about our bookkeeping.
function trackAbandonedCreation(work: Promise<unknown>): void {
  abandonedCreations++;
  let released = false;
  const release = (): void => {
    if (!released) {
      released = true;
      abandonedCreations--;
      pumpAdmission();
    }
  };
  work.then(release, release);
}

// #1(r21): ONE weighted admission controller over the shared job pool.
// Single-query work (widgets, traces, dry runs, probes) admits with weight 1
// and fails fast when the pool is exhausted — unchanged contract. A dashboard
// refresh atomically RESERVES SECTIONS.length permits first, waiting FIFO
// behind mixed traffic (bounded queue depth #4(r21), bounded wait, abort-
// aware with timer/listener cleanup on every terminal path). Reserved permits
// convert one-by-one into live jobs, so widgets can never starve a refresh
// into arbitrary failed panels and a refresh can never oversubscribe BigQuery.
// #2(r22): admission pressure is an EXPECTED, retryable condition — a typed
// error lets HTTP surfaces answer 503 + Retry-After instead of a false 500
export class AdmissionError extends Error {}

interface Reservation {
  remaining: number;
}
let reservedPermits = 0;
const MAX_ADMISSION_WAITERS = 4;
interface AdmissionWaiter {
  weight: number;
  resolve: () => void;
  cleanup: () => void;
}
const admissionWaiters: AdmissionWaiter[] = [];

function capacityUsed(): number {
  return inflightJobs + abandonedCreations + reservedPermits;
}

function pumpAdmission(): void {
  while (admissionWaiters.length && capacityUsed() + admissionWaiters[0].weight <= MAX_CONCURRENT_JOBS) {
    const w = admissionWaiters.shift()!;
    w.cleanup();
    reservedPermits += w.weight;
    w.resolve();
  }
}

async function reservePermits(weight: number, signal?: AbortSignal): Promise<Reservation> {
  if (capacityUsed() + weight <= MAX_CONCURRENT_JOBS) {
    reservedPermits += weight;
    return { remaining: weight };
  }
  if (admissionWaiters.length >= MAX_ADMISSION_WAITERS) {
    throw new AdmissionError("Server busy: the refresh queue is full — retry shortly");
  }
  await new Promise<void>((resolve, reject) => {
    const waiter: AdmissionWaiter = { weight, resolve, cleanup: () => {} };
    const drop = (err: Error): void => {
      const i = admissionWaiters.indexOf(waiter);
      if (i >= 0) {
        admissionWaiters.splice(i, 1);
        waiter.cleanup();
        reject(err);
      }
      // not found → already admitted; the caller's release path owns the permits
    };
    const timer = setTimeout(
      () => drop(new AdmissionError("Server busy: timed out waiting for refresh capacity — retry shortly")),
      CONFIG.queryTimeoutMs * 2,
    );
    (timer as any).unref?.();
    const onAbort = (): void => drop(new Error("Refresh aborted while queued for capacity"));
    signal?.addEventListener("abort", onAbort, { once: true });
    waiter.cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    admissionWaiters.push(waiter);
  });
  return { remaining: weight };
}

function releaseReservation(r: Reservation): void {
  reservedPermits -= r.remaining;
  r.remaining = 0;
  pumpAdmission();
}

async function withJobSlot<T>(fn: () => Promise<T>, reservation?: Reservation): Promise<T> {
  if (reservation && reservation.remaining > 0) {
    reservation.remaining--;
    reservedPermits--; // the reserved permit converts into a live job
  } else if (capacityUsed() >= MAX_CONCURRENT_JOBS) {
    throw new AdmissionError("Server busy: too many concurrent BigQuery jobs — retry shortly");
  }
  inflightJobs++;
  try {
    return await fn();
  } finally {
    inflightJobs--;
    pumpAdmission();
  }
}

interface QueryResult {
  rows: any[];
  bytes: number;
}

async function runQuery(
  sql: string,
  params: Record<string, unknown>,
  maxBytes: number,
  signal?: AbortSignal, // caller abort (per-request ops only, never shared/cached work)
  reservation?: Reservation, // #1(r21): dashboard sections consume pre-reserved permits
): Promise<QueryResult> {
  if (signal?.aborted) throw new Error("request aborted");
  return withJobSlot(async () => {
    // One absolute deadline covers the COMPLETE lifecycle — client/ADC setup,
    // job creation, result polling, and metadata. Caller aborts and deadline
    // expiry are TERMINAL: polling is raced against them (#6), a job that
    // surfaces after either fires cancels itself without polling (#1), and
    // an abandoned creation keeps counting against admission (#2).
    let jobRef: any = null;
    let expired = false;
    const work = (async () => {
      const client = await bigQueryClient();
      const [job] = await client.createQueryJob({
        query: sql,
        params,
        maximumBytesBilled: String(maxBytes),
      });
      jobRef = job;
      if (expired) {
        // deadline/abort already fired while creation was in flight: cancel
        // the late job and never poll it
        await withDeadline(Promise.resolve(job.cancel?.()), 5_000).catch(() => {});
        throw new Error(`BigQuery query abandoned after ${CONFIG.queryTimeoutMs} ms (job created after expiry)`);
      }
      const [rows] = await job.getQueryResults();
      const [meta] = await job.getMetadata();
      return { rows, bytes: Number(meta?.statistics?.totalBytesProcessed ?? 0) } as QueryResult;
    })();
    const abortPromise: Promise<never> | null = signal
      ? new Promise((_, reject) => {
          const fail = (): void => reject(new Error("request aborted"));
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail, { once: true });
        })
      : null;
    try {
      const raced = abortPromise ? Promise.race([work, abortPromise]) : work;
      return await withDeadline<QueryResult>(raced, CONFIG.queryTimeoutMs);
    } catch (e) {
      expired = true; // stops a late creation from ever polling
      work.catch(() => {}); // the abandoned lifecycle must not become unhandled
      if (jobRef) {
        // terminal branch: hold the slot until cancellation settles (bounded)
        await withDeadline(Promise.resolve(jobRef.cancel?.()), 5_000).catch(() => {});
      } else {
        trackAbandonedCreation(work); // creation still pending — keep it counted
      }
      throw e;
    }
  }, reservation);
}

async function bigQueryClient(): Promise<any> {
  if (!bqClient) {
    if (FAKE_BQ) {
      const { makeFakeBigQuery } = await import("./src/fakebq.js");
      bqClient = makeFakeBigQuery(FAKE_BQ) as any;
    } else {
      const { BigQuery } = await import("@google-cloud/bigquery");
      bqClient = new BigQuery({ projectId: CONFIG.project });
    }
  }
  return bqClient;
}

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`BigQuery query timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer)) as Promise<T>;
}

// Estimate a query's scan size without running it (BigQuery dry run).
// #2(r7): dry runs share the SAME lifecycle ownership as real queries — a
// timed-out or aborted dry-run creation stays inside admission accounting
// until it settles, instead of silently escaping the cap.
async function dryRunQuery(sql: string, params: Record<string, unknown>, signal?: AbortSignal): Promise<number> {
  if (signal?.aborted) throw new Error("request aborted");
  return withJobSlot(async () => {
    const work = (async () => {
      const client = await bigQueryClient();
      const [job] = await client.createQueryJob({ query: sql, params, dryRun: true });
      return Number(job.metadata?.statistics?.totalBytesProcessed ?? 0);
    })();
    const abortPromise: Promise<never> | null = signal
      ? new Promise((_, reject) => {
          const fail = (): void => reject(new Error("request aborted"));
          if (signal.aborted) fail();
          else signal.addEventListener("abort", fail, { once: true });
        })
      : null;
    try {
      const raced = abortPromise ? Promise.race([work, abortPromise]) : work;
      return await withDeadline<number>(raced, CONFIG.queryTimeoutMs);
    } catch (e) {
      trackAbandonedCreation(work); // dry-run creation still pending — keep it counted
      work.catch(() => {});
      throw e;
    }
  });
}

const EMPTY_OVERVIEW: OverviewStats = {
  total_events: null,
  errors: null,
  error_rate_pct: null,
  sessions: null,
  agents: null,
  users: null,
  p95_latency_ms: null,
};

async function bigQueryDashboard(
  start: Date,
  end: Date,
  granularity: Granularity,
  agent?: string | null,
  signal?: AbortSignal,
): Promise<DashboardData> {
  const sql = buildDashboardSql({ table: tableRef(), granularity, agentFilter: !!agent });
  const params: Record<string, unknown> = { start: start.toISOString(), end: end.toISOString() };
  if (agent) params.agent = agent;
  // preceding window of equal length, for period-over-period deltas
  const prevParams: Record<string, unknown> = {
    start: new Date(start.getTime() - (end.getTime() - start.getTime())).toISOString(),
    end: start.toISOString(),
    ...(agent ? { agent } : {}),
  };
  // delegation resolves parent-child edges over ALL spans first, then filters
  // edges by the requested agent — so it needs the @agent param but not the
  // per-row agent predicate; the agents option list never filters.
  const paramsFor = (s: (typeof SECTIONS)[number]): Record<string, unknown> =>
    s === "prev_overview" ? prevParams : s === "agents" ? { start: params.start, end: params.end } : params;

  // The refresh budget is split exactly across the panel queries so one
  // dashboard load can never authorize more than BQAA_MAX_BYTES_BILLED total.
  const perQueryBytes = splitBudget(CONFIG.refreshBytesBudget, SECTIONS.length);

  // #1(r21): reserve the WHOLE fan-out atomically; sections consume permits
  const reservation = await reservePermits(SECTIONS.length, signal);
  let settled: PromiseSettledResult<Awaited<ReturnType<typeof runQuery>>>[];
  try {
    settled = await Promise.allSettled(
      SECTIONS.map((s) => runQuery(sql[s], paramsFor(s), perQueryBytes, signal, reservation)),
    );
  } finally {
    releaseReservation(reservation); // returns any unconsumed permits
  }

  // One failed panel must not blank the dashboard: keep healthy sections,
  // report the failed ones (truthfully) in meta.section_errors.
  const sectionErrors: Record<string, string> = {};
  let bytes = 0;
  const rowsOf = (i: number): any[] | null => {
    const r = settled[i];
    if (r.status === "fulfilled") {
      bytes += r.value.bytes;
      return r.value.rows;
    }
    sectionErrors[SECTIONS[i]] = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return null;
  };
  const [
    overviewRows,
    prevOverviewRows,
    timeseries,
    latencyByAgent,
    toolStats,
    modelComparison,
    topSessions,
    hitl,
    delegation,
    agentRows,
    costBuckets,
  ] = SECTIONS.map((_, i) => rowsOf(i));

  if (Object.keys(sectionErrors).length === SECTIONS.length) {
    throw new Error(`All dashboard queries failed: ${Object.values(sectionErrors)[0]}`);
  }

  return {
    meta: {
      source: sourceLabel(),
      start: start.toISOString(),
      end: end.toISOString(),
      granularity,
      agent: agent ?? null,
      bytes_processed: bytes,
      ...(Object.keys(sectionErrors).length ? { section_errors: sectionErrors } : {}),
    },
    overview: overviewRows?.[0] ?? EMPTY_OVERVIEW,
    prevOverview: prevOverviewRows?.[0] ?? null,
    timeseries: timeseries ?? [],
    latencyByAgent: latencyByAgent ?? [],
    toolStats: toolStats ?? [],
    ...(() => {
      const bounded = applyModelBound(modelComparison ?? []);
      return { modelComparison: bounded.rows, models_truncated: bounded.truncated };
    })(),
    topSessions: topSessions ?? [],
    hitl: hitl ?? [],
    delegation: delegation ?? [],
    agentsList: (agentRows ?? []).map((r: any) => r.agent),
    ...(() => {
      // #1(r22): truncation is measured server-side (cap+1 fetch) and
      // published explicitly to EVERY consumer
      const bounded = applyCostBucketBound(costBuckets ?? []);
      return { costBuckets: bounded.rows, cost_buckets_truncated: bounded.truncated };
    })(),
  };
}

// ------------------------------------------------------------ custom widgets

const WIDGET_QUERY_BYTES = Math.min(200_000_000, CONFIG.refreshBytesBudget); // single-query ops

// A spec the measure's population cannot answer — an INPUT error (400), not
// a server failure
class WidgetSpecError extends Error {}

async function loadWidget(
  spec: WidgetSpec,
  timeRangeHours: number,
  dryRun: boolean,
  signal?: AbortSignal,
): Promise<WidgetResult> {
  const end = new Date();
  const start = new Date(end.getTime() - timeRangeHours * 3_600_000);
  const granularity: Granularity = spec.granularity ?? (timeRangeHours <= 72 ? "hour" : "day");
  const fullSpec: WidgetSpec = { v: 1, ...spec, granularity };
  // #1(r19): the compatibility contract gates EVERY surface — HTTP, MCP, and
  // mock — before any dry run, execution, or plausible-looking sample data
  const compat = widgetSpecError(fullSpec);
  if (compat) throw new WidgetSpecError(compat);
  if (CONFIG.mock) {
    const result = { ...mockWidget(fullSpec, start, end), source: "mock" };
    return dryRun ? { ...result, rows: [], dry_run: true, estimated_bytes: 12_345_678 } : result;
  }
  const built = buildWidgetSql(tableRef(), fullSpec);
  const params = { start: start.toISOString(), end: end.toISOString(), ...built.filterParams };
  const window = { start: start.toISOString(), end: end.toISOString() };
  if (dryRun) {
    const estimated = await dryRunQuery(built.sql, params, signal);
    return { spec: fullSpec as WidgetResult["spec"], window, rows: [], dry_run: true, estimated_bytes: estimated, source: sourceLabel() };
  }
  const { rows, bytes } = await runQuery(built.sql, params, WIDGET_QUERY_BYTES, signal);
  return { spec: fullSpec as WidgetResult["spec"], window, rows, bytes_processed: bytes, source: sourceLabel() };
}

// ------------------------------------------------ conversational layer (BQCA)

// Ask runs Conversational Analytics work in our project: bound how many run
// at once, and cap the bytes its generated queries may bill (#5).
const MAX_CONCURRENT_ASK = 3;
let inflightAsk = 0;

interface AskScope {
  time_range_hours?: number;
  agent?: string;
}

async function ask(question: string, history: AskExchange[], scope: AskScope, signal?: AbortSignal): Promise<AskResult> {
  if (CONFIG.caDisabled) {
    throw new Error("Conversational analytics is disabled on this deployment (BQAA_CA_DISABLED=1)");
  }
  // #7(r7): normalize the scope BEFORE the mock/live branch so sample answers
  // are scope-consistent instead of fixed-30-day data under the user's label
  const hoursNorm = Math.min(MAX_HOURS, Math.max(1, scope.time_range_hours ?? CONFIG.defaultHours));
  const endNorm = new Date();
  const startNorm = new Date(endNorm.getTime() - hoursNorm * 3_600_000);
  const normScope = {
    startIso: startNorm.toISOString(),
    endIso: endNorm.toISOString(),
    agent: scope.agent?.slice(0, 200),
  };
  if (CONFIG.mock) return mockAsk(question, normScope);
  if (signal?.aborted) throw new Error("Ask aborted before start"); // #8: never consume a slot for dead work
  if (inflightAsk >= MAX_CONCURRENT_ASK) {
    throw new AdmissionError("Server busy: too many concurrent Ask requests — retry shortly"); // #2(r23): retryable 503, like every admission limit
  }
  inflightAsk++;
  try {
    if (FAKE_CA) {
      // deferred deterministic answer — the slot is held for the duration
      await new Promise((r) => setTimeout(r, FAKE_CA === "slow" ? 1500 : 50));
      return {
        ...mockAsk(question, normScope),
        answer: "(FAKE_CA test seam) deterministic answer — no Google API was called.",
      };
    }
    return await askConversational(
      {
        project: CONFIG.project,
        dataset: CONFIG.dataset,
        table: CONFIG.table,
        location: process.env.BQAA_CA_LOCATION,
        // per-QUERY cap on CA-generated SQL (CA may run several queries per
        // question); aggregate spend control belongs to project/user quotas
        maxBilledBytes: CONFIG.refreshBytesBudget,
        scope: normScope,
      },
      question,
      history,
      signal,
    );
  } finally {
    inflightAsk--;
  }
}

async function loadErrorTraces(timeRangeHours: number, limit: number, signal?: AbortSignal): Promise<ErrorTraceRow[]> {
  if (CONFIG.mock) return mockErrorTraces(timeRangeHours).slice(0, limit); // #6(r11): window applies before limit
  const end = new Date();
  const start = new Date(end.getTime() - timeRangeHours * 3_600_000);
  const { rows } = await runQuery(
    buildErrorTracesSql(tableRef()),
    { start: start.toISOString(), end: end.toISOString(), limit },
    WIDGET_QUERY_BYTES,
    signal,
  );
  return rows;
}

// Trace explorer: summary rows for recent traces, optionally errors-only,
// optionally narrowed to one agent — same budget class as widgets.
async function loadTraces(
  timeRangeHours: number,
  limit: number,
  errorsOnly: boolean,
  agent?: string,
  signal?: AbortSignal,
): Promise<TraceListRow[]> {
  if (CONFIG.mock) return mockTracesList(timeRangeHours, errorsOnly, agent).slice(0, limit);
  const end = new Date();
  const start = new Date(end.getTime() - timeRangeHours * 3_600_000);
  const { rows } = await runQuery(
    buildTracesListSql(tableRef(), { errorsOnly, agentFilter: !!agent }),
    { start: start.toISOString(), end: end.toISOString(), limit, ...(agent ? { agent } : {}) },
    WIDGET_QUERY_BYTES,
    signal,
  );
  return rows;
}

// Cache + coalescing: identical (window, agent) refreshes within the TTL share
// one BigQuery round-trip, including concurrent ones. The cache is a bounded
// LRU — arbitrary agent filters cannot grow it without limit, and expired
// entries are evicted on access.
const CACHE_TTL_MS = 60_000;
const CACHE_MAX_ENTRIES = 50;

interface CacheEntry {
  promise: Promise<DashboardData>;
  expires: number; // Infinity while pending — in-flight work is never evicted
  settled: boolean;
  subscribers: number; // callers currently awaiting this pipeline
  abort: AbortController; // fires only when the LAST subscriber disconnects
}

const dashboardCache = new Map<string, CacheEntry>();

function cacheGet(key: string): CacheEntry | null {
  const entry = dashboardCache.get(key);
  if (!entry) return null;
  // #3: an aborted pipeline is dead — never hand it to a new caller
  if (entry.abort.signal.aborted) {
    dashboardCache.delete(key);
    return null;
  }
  if (entry.settled && entry.expires <= Date.now()) {
    dashboardCache.delete(key);
    return null;
  }
  dashboardCache.delete(key); // re-insert as most recently used
  dashboardCache.set(key, entry);
  return entry;
}

function cacheSet(key: string, entry: CacheEntry): void {
  const now = Date.now();
  for (const [k, e] of dashboardCache) if (e.settled && e.expires <= now) dashboardCache.delete(k);
  while (dashboardCache.size >= CACHE_MAX_ENTRIES) {
    // evict the oldest SETTLED entry; pending pipelines have awaiting callers
    let evicted = false;
    for (const [k, e] of dashboardCache) {
      if (e.settled) {
        dashboardCache.delete(k);
        evicted = true;
        break;
      }
    }
    if (!evicted) break;
  }
  dashboardCache.set(key, entry);
}

// #14/#11: callers subscribe to the shared pipeline; a caller abort only
// cancels the underlying BigQuery work when NO other subscriber remains.
function subscribe(entry: CacheEntry, key: string, signal?: AbortSignal): void {
  if (!signal || entry.settled) return;
  entry.subscribers++;
  const release = (): void => {
    entry.subscribers--;
    if (entry.subscribers <= 0 && !entry.settled) {
      // #3: evict BEFORE aborting so a same-tick retry can never latch on
      if (dashboardCache.get(key) === entry) dashboardCache.delete(key);
      entry.abort.abort();
    }
  };
  if (signal.aborted) release();
  else signal.addEventListener("abort", release, { once: true });
}

// #4(r8): a disconnected caller must release its own handler promptly while
// the SHARED pipeline keeps running for remaining subscribers — the race
// frees the caller; the last-subscriber rule (in subscribe) owns cancellation.
function awaitForCaller<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      const fail = (): void => reject(new Error("request aborted"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    }),
  ]);
}

async function loadDashboard(
  timeRangeHours: number,
  agent?: string | null,
  signal?: AbortSignal,
): Promise<DashboardData> {
  const end = new Date();
  const start = new Date(end.getTime() - timeRangeHours * 3_600_000);
  const granularity: Granularity = timeRangeHours <= 72 ? "hour" : "day";
  if (CONFIG.mock) return mockDashboard(start, end, granularity, agent);

  const key = `${timeRangeHours}|${agent ?? ""}`;
  const cached = cacheGet(key);
  if (cached) {
    subscribe(cached, key, signal);
    const data = await awaitForCaller(cached.promise, signal);
    return { ...data, meta: { ...data.meta, cache_hit: true } };
  }
  const abort = new AbortController();
  const entry: CacheEntry = {
    promise: undefined as any,
    expires: Infinity, // #26: pending work is never evicted mid-flight
    settled: false,
    subscribers: 0,
    abort,
  };
  entry.promise = bigQueryDashboard(start, end, granularity, agent, abort.signal);
  cacheSet(key, entry);
  subscribe(entry, key, signal);
  entry.promise
    .then((d) => {
      entry.settled = true;
      entry.expires = Date.now() + CACHE_TTL_MS; // #26: TTL starts at success
      // a degraded (partial-failure) result must not be served from cache
      if (Object.keys(d.meta.section_errors ?? {}).length && dashboardCache.get(key) === entry) {
        dashboardCache.delete(key);
      }
    })
    .catch(() => {
      entry.settled = true;
      if (dashboardCache.get(key) === entry) dashboardCache.delete(key); // failures are not cacheable
    });
  return awaitForCaller(entry.promise, signal); // #4(r8): caller-scoped release
}

const TRACE_EVENT_CAP = 500;

async function loadTrace(traceId: string, timeRangeHours: number, signal?: AbortSignal): Promise<TraceResult> {
  if (!TRACE_ID_RE.test(traceId)) throw new Error("Invalid trace_id");
  if (CONFIG.mock) return { events: mockTrace(traceId, timeRangeHours), truncated: false, source: "mock" }; // #4(r12): window applies
  const end = new Date();
  const start = new Date(end.getTime() - timeRangeHours * 3_600_000);
  // fetch cap+1 so truncation is reported instead of silently dropping events
  const { rows } = await runQuery(
    buildTraceSql(tableRef()),
    { trace_id: traceId, start: start.toISOString(), end: end.toISOString(), limit: TRACE_EVENT_CAP + 1 },
    WIDGET_QUERY_BYTES,
    signal,
  );
  return { events: rows.slice(0, TRACE_EVENT_CAP), truncated: rows.length > TRACE_EVENT_CAP, source: sourceLabel() };
}

// ---------------------------------------------------------------- summaries

const n = (v: number | null | undefined): string => (v == null ? "n/a" : v.toLocaleString("en-US"));

function summarize(d: DashboardData, willRender: boolean): string {
  const o = d.overview;
  const hours = Math.round((Date.parse(d.meta.end) - Date.parse(d.meta.start)) / 3_600_000);
  const topModel = d.modelComparison[0];
  const worstTool = [...d.toolStats].sort((a, b) => b.fail_rate_pct - a.fail_rate_pct)[0];
  const lines = [
    `Agent analytics, last ${hours}h (source: ${d.meta.source}${d.meta.agent ? `, agent=${d.meta.agent}` : ""}):`,
    `- ${n(o.total_events)} events, ${n(o.sessions)} sessions, ${n(o.users)} users, ${n(o.agents)} agents`,
    `- error rate ${o.error_rate_pct ?? "n/a"}%, p95 event latency ${o.p95_latency_ms ?? "n/a"} ms`,
  ];
  if (topModel) lines.push(`- busiest model: ${topModel.model_id} (${n(topModel.calls)} calls, p95 ${topModel.p95_latency_ms ?? "n/a"} ms)`);
  if (worstTool) lines.push(`- highest tool failure rate: ${worstTool.tool_name} at ${worstTool.fail_rate_pct}% of ${n(worstTool.total_calls)} calls`);
  const failed = Object.keys(d.meta.section_errors ?? {});
  if (failed.length) lines.push(`- WARNING: ${failed.length} panel(s) failed to load: ${failed.join(", ")}`);
  if (d.models_truncated) {
    lines.push("- WARNING: the model breakdown is TRUNCATED (too many distinct model ids) — model comparison and cost pricing are incomplete.");
  }
  if (d.cost_buckets_truncated) {
    lines.push("- WARNING: the per-model cost series is TRUNCATED for this window — do not treat cost-over-time as exact; narrow the time range.");
  }
  if (willRender) lines.push("Compatible MCP App hosts will render the interactive dashboard."); // #3(r23): only the APP tool may claim rendering
  return lines.join("\n");
}

// ---------------------------------------------------------------- MCP server

const resourceUri = "ui://bqaa/dashboard.html";

const metricArgs = {
  time_range_hours: z
    .number()
    .int()
    .min(1)
    .max(MAX_HOURS)
    .default(CONFIG.defaultHours)
    .describe(`Lookback window in hours (default ${CONFIG.defaultHours}, max ${MAX_HOURS} = 90 days)`),
  agent: z.string().max(200).optional().describe("Optional: restrict to a single agent name"),
};

// #3(r23): show_agent_dashboard renders an app; query_agent_metrics is
// data-only and its summary must never promise a rendered dashboard.
function metricsHandlerFor(willRender: boolean) {
  return async (args: { time_range_hours?: number; agent?: string }, extra?: { signal?: AbortSignal }) => {
    const data = await loadDashboard(args.time_range_hours ?? CONFIG.defaultHours, args.agent ?? null, extra?.signal);
    return {
      content: [{ type: "text" as const, text: summarize(data, willRender) }],
      structuredContent: { data } as any,
    };
  };
}

// ---- custom widgets (measure × dimension × filters), conversational + UI

const MEASURE_KEYS = Object.keys(WIDGET_MEASURES) as [string, ...string[]];
const DIMENSION_KEYS = Object.keys(WIDGET_DIMENSIONS) as [string, ...string[]];

const widgetArgs = {
  measure: z.enum(MEASURE_KEYS).describe(`One of: ${MEASURE_KEYS.join(", ")}`),
  dimension: z.enum(DIMENSION_KEYS).describe(`Group by: ${DIMENSION_KEYS.join(", ")}`),
  time_range_hours: z.number().int().min(1).max(MAX_HOURS).default(CONFIG.defaultHours),
  granularity: z.enum(["hour", "day"]).optional().describe("Bucket size when dimension=time"),
  agent: z.string().max(200).optional(),
  model: z.string().max(200).optional(),
  tool: z.string().max(200).optional(),
  status: z.enum(["OK", "ERROR"]).optional(),
  limit: z.number().int().min(1).max(100).optional().describe("Top-N for categorical dimensions (default 20)"),
  dry_run: z.boolean().default(false).describe("Estimate bytes scanned without running the query"),
};

type WidgetArgs = {
  measure: string;
  dimension: string;
  time_range_hours?: number;
  granularity?: Granularity;
  agent?: string;
  model?: string;
  tool?: string;
  status?: "OK" | "ERROR";
  limit?: number;
  dry_run?: boolean;
};

function widgetSpecOf(args: WidgetArgs): WidgetSpec {
  return {
    measure: args.measure,
    dimension: args.dimension,
    granularity: args.granularity,
    limit: args.limit,
    filters: { agent: args.agent, model: args.model, tool: args.tool, status: args.status },
  };
}

function summarizeWidget(r: WidgetResult): string {
  const marker = SYNTHETIC() ? "(synthetic sample data) " : "";
  const label = `${marker}${WIDGET_MEASURES[r.spec.measure]?.label ?? r.spec.measure} by ${r.spec.dimension}`;
  if (r.dry_run) {
    return `Dry run for "${label}": would scan ~${((r.estimated_bytes ?? 0) / 1e6).toFixed(1)} MB.`;
  }
  const top = r.rows
    .slice(0, 5)
    .map((row) => `${row.dim ?? "(null)"}: ${row.value ?? "n/a"}`)
    .join("; ");
  return `${label} (${r.rows.length} rows): ${top}${r.rows.length > 5 ? "; …" : ""}`;
}

async function widgetHandler(args: WidgetArgs, extra?: { signal?: AbortSignal }) {
  const result = await loadWidget(widgetSpecOf(args), args.time_range_hours ?? CONFIG.defaultHours, !!args.dry_run, extra?.signal);
  return {
    content: [{ type: "text" as const, text: summarizeWidget(result) }],
    structuredContent: { data: result } as any,
  };
}


// Each stateless HTTP request gets its own McpServer: a shared instance
// re-binds its transport on connect(), so concurrent RPCs would race.
// Every tool is a read-only query over agent_events — no writes, no side
// effects, same result for the same arguments. Hosts (Gemini Enterprise,
// Claude, etc.) read these hints to skip per-action confirmation prompts.
const READ_ONLY_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const;

function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "BigQuery Agent Analytics Dashboard", version: "0.1.0" });

registerAppTool(
  server,
  "show_agent_dashboard",
  {
    title: "Agent Analytics Dashboard",
    description:
      "Render an interactive dashboard over the BigQuery Agent Analytics agent_events table with nine views: Overview, Ask (conversational analytics), Latency, Tokens, Tools, Cost, Agents (HITL + delegation), Traces (explorer + waterfalls), and Explore (custom widgets). Use when the user wants to see, explore, or monitor agent metrics visually.",
    inputSchema: metricArgs,
    outputSchema: { data: z.unknown() },
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: { ui: { resourceUri } },
  },
  metricsHandlerFor(true),
);

server.registerTool(
  "query_agent_metrics",
  {
    title: "Query agent metrics",
    description:
      "Return the aggregated agent-analytics payload (overview, timeseries, latency by agent, token usage, tool stats, model comparison, sessions, HITL, delegation, per-model cost buckets) as structured data without rendering UI. Used by the dashboard for refresh/filtering; also useful for text answers.",
    inputSchema: metricArgs,
    outputSchema: { data: z.unknown() },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  metricsHandlerFor(false),
);

server.registerTool(
  "get_trace",
  {
    title: "Get trace",
    description: "Reconstruct a single trace (ordered agent_events) by trace_id for drill-down debugging.",
    inputSchema: {
      trace_id: z.string().regex(TRACE_ID_RE).describe("OpenTelemetry trace id"),
      time_range_hours: z.number().int().min(1).max(MAX_HOURS).default(CONFIG.defaultHours),
    },
    outputSchema: { data: z.unknown() },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async (args, extra) => {
    const trace = await loadTrace(args.trace_id, args.time_range_hours ?? CONFIG.defaultHours, extra?.signal);
    const errorCount = trace.events.filter(
      (e) => e.status === "ERROR" || e.event_type.endsWith("_ERROR") || e.error_message != null,
    ).length;
    return {
      content: [
        {
          type: "text" as const,
          text:
            `${SYNTHETIC() ? "(synthetic sample data) " : ""}Trace ${args.trace_id}: ${trace.events.length} events, ${errorCount} errors.` +
            (trace.truncated ? ` TRUNCATED at ${trace.events.length} events — narrow the window for the full trace.` : ""),
        },
      ],
      structuredContent: { data: trace } as any,
    };
  },
);

// #5(r20): the compatibility matrix is PUBLISHED in the tool contract — an
// MCP model can plan a valid spec from tools/list instead of submitting and
// recovering from rejections.
const WIDGET_MATRIX = Object.entries(WIDGET_MEASURES)
  .map(([k, m]) => `${k} (dims: ${m.dimensions.join("|")}; filters: ${m.filters.join("|") || "none"})`)
  .join("; ");

server.registerTool(
  "query_widget",
  {
    title: "Query a custom widget",
    description:
      "Run one custom analytics widget over agent_events: a measure grouped by a compatible dimension with optional filters. Set dry_run=true to estimate bytes scanned first. Used by the dashboard's Explore tab and for ad-hoc questions. " +
      `Measure compatibility: ${WIDGET_MATRIX}. The status filter uses the canonical error contract (ERROR matches *_ERROR events, status='ERROR', or an error_message).`,
    inputSchema: widgetArgs,
    outputSchema: { data: z.unknown() },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  widgetHandler,
);

registerAppTool(
  server,
  "render_widget",
  {
    title: "Render a custom widget",
    description:
      "Build a custom chart from natural language and render it interactively in the dashboard UI: pick a measure, a compatible dimension, and filters. Use when the user asks to visualize a specific slice (e.g. tool_p95_latency_ms by tool with status=ERROR for 'show p95 tool latency for errors'). " +
      `Measure compatibility: ${WIDGET_MATRIX}.`,
    inputSchema: widgetArgs,
    outputSchema: { data: z.unknown() },
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: { ui: { resourceUri } },
  },
  widgetHandler,
);

server.registerTool(
  "ask_data",
  {
    title: "Ask the agent_events table",
    description:
      "Ask a natural-language analytics question about the agent_events table. Answered by BigQuery Conversational Analytics (Gemini Data Analytics): it plans, writes and runs SQL, and returns an answer with the generated SQL and result rows. Slower than the widget tools (~30-60s) but handles open-ended questions.",
    inputSchema: {
      question: z.string().min(3).max(2000).describe("The analytics question, in natural language"),
      history: z
        .array(z.object({ question: z.string().max(2000), answer: z.string().max(4000) }))
        .max(3)
        .optional()
        .describe("Up to 3 prior question/answer exchanges, for follow-up context"),
      time_range_hours: z.number().int().min(1).max(MAX_HOURS).optional().describe("Restrict analysis to this window"),
      agent: z.string().max(200).optional().describe("Restrict analysis to one agent"),
    },
    outputSchema: { data: z.unknown() },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async (args, extra) => {
    const result = await ask(
      args.question,
      args.history ?? [],
      { time_range_hours: args.time_range_hours, agent: args.agent },
      extra?.signal,
    );
    return {
      content: [{ type: "text" as const, text: result.answer + (result.sql ? `\n\nGenerated SQL:\n${result.sql}` : "") }],
      structuredContent: { data: result } as any,
    };
  },
);

registerAppTool(
  server,
  "render_trace",
  {
    title: "Render a trace waterfall",
    description:
      "Render one trace interactively in the dashboard UI: a waterfall of spans (LLM calls, tool calls, instants) on a shared time axis with errors highlighted, plus the ordered event log. Use when the user wants to SEE a trace — e.g. after list_error_traces surfaces a suspicious trace id. get_trace returns the same data without UI.",
    inputSchema: {
      trace_id: z.string().regex(TRACE_ID_RE).describe("OpenTelemetry trace id"),
      time_range_hours: z.number().int().min(1).max(MAX_HOURS).default(CONFIG.defaultHours),
    },
    outputSchema: { data: z.unknown() },
    annotations: READ_ONLY_ANNOTATIONS,
    _meta: { ui: { resourceUri } },
  },
  async (args, extra) => {
    const hours = args.time_range_hours ?? CONFIG.defaultHours;
    const trace = await loadTrace(args.trace_id, hours, extra?.signal);
    const errorCount = trace.events.filter(
      (e) => e.status === "ERROR" || e.event_type.endsWith("_ERROR") || e.error_message != null,
    ).length;
    return {
      content: [
        {
          type: "text" as const,
          text:
            `${SYNTHETIC() ? "(synthetic sample data) " : ""}Trace ${args.trace_id}: ${trace.events.length} events, ${errorCount} errors (window: last ${hours}h).` +
            (trace.truncated ? " TRUNCATED — narrow the window for the full trace." : "") +
            // #6(r9): the server cannot know whether this caller renders UI
            " Compatible MCP App hosts will render the waterfall.",
        },
      ],
      // #1(r9): the requested window travels with the payload so the App can
      // adopt it instead of silently keeping a different dashboard scope
      structuredContent: { data: { trace_id: args.trace_id, time_range_hours: hours, ...trace } } as any,
    };
  },
);

server.registerTool(
  "list_traces",
  {
    title: "List recent traces",
    description:
      "Return summary rows for recent traces in the window (start, duration, event and error counts, agents), newest first — the trace explorer's data source. Set errors_only=true to keep only traces containing errors; pass agent to narrow to one agent. Use get_trace or render_trace on a returned trace_id to dive deeper.",
    inputSchema: {
      time_range_hours: z.number().int().min(1).max(MAX_HOURS).default(CONFIG.defaultHours),
      limit: z.number().int().min(1).max(50).default(25),
      errors_only: z.boolean().default(false),
      agent: z.string().max(200).optional().describe("Only traces this agent participated in"),
    },
    outputSchema: { data: z.unknown() },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async (args, extra) => {
    const rows = await loadTraces(
      args.time_range_hours ?? CONFIG.defaultHours,
      args.limit ?? 25,
      args.errors_only ?? false,
      args.agent,
      extra?.signal,
    );
    const text = rows.length
      ? `${SYNTHETIC() ? "(synthetic sample data) " : ""}${rows.length} recent trace(s):\n` +
        rows
          .map((r) => `- ${r.trace_id} (${r.last_ts}, ${r.events} events, ${r.error_events} errors, agents: ${r.agents ?? "?"})`)
          .join("\n")
      : "No traces in this window.";
    return { content: [{ type: "text" as const, text }], structuredContent: { data: rows } as any };
  },
);

server.registerTool(
  "list_error_traces",
  {
    title: "List recent error traces",
    description:
      "Return recent trace ids that contain errors, with sample error messages — use with get_trace to cite exact evidence when diagnosing failures.",
    inputSchema: {
      time_range_hours: z.number().int().min(1).max(MAX_HOURS).default(CONFIG.defaultHours),
      limit: z.number().int().min(1).max(50).default(10),
    },
    outputSchema: { data: z.unknown() },
    annotations: READ_ONLY_ANNOTATIONS,
  },
  async (args, extra) => {
    const rows = await loadErrorTraces(args.time_range_hours ?? CONFIG.defaultHours, args.limit ?? 10, extra?.signal);
    const text = rows.length
      ? `${SYNTHETIC() ? "(synthetic sample data) " : ""}${rows.length} recent trace(s) with errors:\n` +
        rows.map((r) => `- ${r.trace_id} (${r.last_ts}, agents: ${r.agents ?? "?"}) — ${r.sample_errors ?? ""}`).join("\n")
      : "No traces with errors in this window.";
    return { content: [{ type: "text" as const, text }], structuredContent: { data: rows } as any };
  },
);

registerAppResource(server, resourceUri, resourceUri, { mimeType: RESOURCE_MIME_TYPE }, async () => {
  const html = await fs.readFile(uiBundlePath(), "utf-8");
  return { contents: [{ uri: resourceUri, mimeType: RESOURCE_MIME_TYPE, text: html }] };
});

  return server;
}

// ---------------------------------------------------------------- transport

const app = express();
app.set("trust proxy", true); // Cloud Run terminates TLS; honor X-Forwarded-Proto

function originAllowed(origin: string): boolean {
  return CONFIG.allowedOrigins.includes("*") || CONFIG.allowedOrigins.includes(origin);
}

// MCP transport security: cross-origin callers must present an allowed
// Origin (DNS-rebinding defense per the MCP spec). The Host header is
// requester-controlled and is NEVER used to derive trust — the same-origin
// exemption applies only to the operator-configured canonical origin, or to
// loopback origins in local development. Server-to-server clients send no
// Origin header and pass through.
const LOOPBACK_ORIGIN_RE = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
// #2(r24): the loopback exemption exists for LOCAL DEVELOPMENT — a publicly
// bound server (BQAA_HOST=0.0.0.0 / non-loopback) must not trust arbitrary
// localhost origins, which any local process on a client machine can forge.
const SERVER_BINDS_LOOPBACK = /^(127\.|localhost$|::1$)/.test(CONFIG.host);

// One shared trust predicate for BOTH the Origin check and CORS headers.
function isTrustedOrigin(origin: string): boolean {
  return (
    originAllowed(origin) ||
    (CONFIG.canonicalOrigin !== "" && origin === CONFIG.canonicalOrigin) ||
    (SERVER_BINDS_LOOPBACK && LOOPBACK_ORIGIN_RE.test(origin))
  );
}

function checkOrigin(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const origin = req.headers.origin;
  if (origin) {
    if (!isTrustedOrigin(origin)) {
      res.status(403).json({ error: "Origin not allowed. Configure BQAA_ALLOWED_ORIGINS or BQAA_CANONICAL_ORIGIN." });
      return;
    }
  }
  next();
}

// Credentials are accepted from the Authorization header (MCP clients) or an
// HttpOnly cookie set via POST /auth/login (browser pages) — never from URLs,
// per the MCP authorization spec.
function cookieToken(req: express.Request): string {
  const m = /(?:^|;\s*)bqaa_token=([^;]+)/.exec(req.headers.cookie ?? "");
  if (!m) return "";
  // #3(r12): a cookie that cannot be decoded is an ABSENT credential (→ 401),
  // never an internal error — decodeURIComponent throws on e.g. "%"
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return "";
  }
}

function requireAuth(req: express.Request, res: express.Response, next: express.NextFunction): void {
  if (CONFIG.authToken) {
    const header = req.headers.authorization ?? "";
    if (header !== `Bearer ${CONFIG.authToken}` && cookieToken(req) !== CONFIG.authToken) {
      res.status(401).json({ error: "Unauthorized. Send Authorization: Bearer <token>, or sign in at /auth/login." });
      return;
    }
  }
  next();
}

app.use(
  cors({
    // #2(r24): CORS shares the SAME trust predicate as checkOrigin
    origin: (origin, cb) => cb(null, !origin || isTrustedOrigin(origin)),
  }),
);
app.use(express.json({ limit: "2mb" }));

// structured request log
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        ts: new Date().toISOString(),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        ms: Date.now() - t0,
      }),
    );
  });
  next();
});

// /healthz is liveness only (also: GFE intercepts it on run.app). Readiness
// lives at /api/health and actually proves BigQuery access with a cached,
// zero-cost dry run — green must mean "can serve data".
let bqProbe: { ok: boolean; detail: string; checked: number } = { ok: true, detail: "unchecked", checked: 0 };
let bqProbeInflight: Promise<{ ok: boolean; detail: string }> | null = null;

async function probeBigQuery(): Promise<{ ok: boolean; detail: string }> {
  if (CONFIG.mock) return { ok: true, detail: "mock" };
  if (Date.now() - bqProbe.checked < 60_000) return bqProbe;
  if (bqProbeInflight) return bqProbeInflight; // #27: cold probes coalesce
  bqProbeInflight = runProbe().finally(() => {
    bqProbeInflight = null;
  });
  return bqProbeInflight;
}

async function runProbe(): Promise<{ ok: boolean; detail: string }> {
  try {
    const end = new Date();
    const start = new Date(end.getTime() - 3_600_000);
    await dryRunQuery(`SELECT 1 FROM ${tableRef()} WHERE timestamp BETWEEN @start AND @end LIMIT 1`, {
      start: start.toISOString(),
      end: end.toISOString(),
    });
    bqProbe = { ok: true, detail: "ok", checked: Date.now() };
  } catch (e) {
    bqProbe = { ok: false, detail: e instanceof Error ? e.message : String(e), checked: Date.now() };
  }
  return bqProbe;
}

app.get("/healthz", (_req, res) => {
  res.json({ ok: true, mock: CONFIG.mock, uiBundle: existsSync(uiBundlePath()) });
});

// Readiness is deliberately unauthenticated (load balancers need it) but
// REDACTED: backend detail goes to logs, never to anonymous callers.
app.get("/api/health", async (_req, res) => {
  const bundle = existsSync(uiBundlePath());
  const bq = await probeBigQuery();
  const ok = bundle && bq.ok;
  if (!bq.ok) console.error(JSON.stringify({ ts: new Date().toISOString(), readiness: "bigquery", detail: bq.detail }));
  const bigquery = CONFIG.mock ? "mock" : bq.ok ? "ok" : "unavailable";
  res.status(ok ? 200 : 503).json({
    ok,
    mock: CONFIG.mock,
    uiBundle: bundle,
    bigquery,
    // in-band deployment identity (Cloud Run stamps K_REVISION; BQAA_BUILD_SHA
    // may be injected at deploy time) — no secrets, no config values
    revision: process.env.K_REVISION ?? null,
    build: process.env.BQAA_BUILD_SHA ?? null,
  });
});

// Browser-shareable view: the shell is static; all data endpoints are guarded.
app.get("/", async (_req, res) => {
  try {
    const html = await fs.readFile(uiBundlePath(), "utf-8");
    res.type("html").send(html);
  } catch {
    res.status(500).send("UI bundle missing — run `npm run build` first.");
  }
});

// Browser sign-in: exchanges the token once (in a POST body) for an HttpOnly
// cookie, so the secret never appears in a URL or in page JavaScript.
app.post("/auth/login", checkOrigin, (req, res) => {
  if (!CONFIG.authToken) {
    res.status(204).end();
    return;
  }
  const token = typeof req.body?.token === "string" ? req.body.token : "";
  if (token !== CONFIG.authToken) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }
  const secure = req.secure ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `bqaa_token=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=604800${secure}`,
  );
  res.status(204).end();
});

// #16: per-request operations propagate a client disconnect as an abort so
// abandoned work can cancel its BigQuery job. Never used for the shared
// (cached/coalesced) dashboard pipeline, which other callers may be awaiting.
function requestAbort(req: express.Request, res: express.Response): AbortSignal {
  const ac = new AbortController();
  // #3: req 'close' fires once the request BODY is consumed (normal POSTs!),
  // so disconnect detection must watch the response/socket instead.
  res.on("close", () => {
    if (!res.writableEnded) ac.abort();
  });
  void req; // request stream events are deliberately not used for aborts
  return ac.signal;
}

// #2(r22): overload answers 503 with Retry-After; anything else stays 500
function sendQueryError(res: express.Response, e: unknown): void {
  if (e instanceof AdmissionError) {
    res.setHeader("Retry-After", String(Math.max(1, Math.ceil(CONFIG.queryTimeoutMs / 1000))));
    res.status(503).json({ error: e.message });
    return;
  }
  res.status(500).json({ error: e instanceof Error ? e.message : String(e) });
}

app.get("/api/dashboard", checkOrigin, requireAuth, async (req, res) => {
  try {
    const hours = Math.min(MAX_HOURS, Math.max(1, Math.trunc(Number(req.query.time_range_hours)) || CONFIG.defaultHours));
    const agentRaw = typeof req.query.agent === "string" ? req.query.agent.slice(0, 200) : "";
    const data = await loadDashboard(hours, agentRaw || null, requestAbort(req, res));
    res.json({ data });
  } catch (e) {
    sendQueryError(res, e);
  }
});

app.get("/api/trace", checkOrigin, requireAuth, async (req, res) => {
  try {
    const traceId = typeof req.query.trace_id === "string" ? req.query.trace_id : "";
    if (!TRACE_ID_RE.test(traceId)) {
      res.status(400).json({ error: "Invalid trace_id" });
      return;
    }
    const hours = Math.min(MAX_HOURS, Math.max(1, Math.trunc(Number(req.query.time_range_hours)) || CONFIG.defaultHours));
    const trace = await loadTrace(traceId, hours, requestAbort(req, res));
    res.json({ data: trace.events, truncated: trace.truncated, source: trace.source });
  } catch (e) {
    sendQueryError(res, e);
  }
});

app.get("/api/traces", checkOrigin, requireAuth, async (req, res) => {
  try {
    const hours = Math.min(MAX_HOURS, Math.max(1, Math.trunc(Number(req.query.time_range_hours)) || CONFIG.defaultHours));
    const limit = Math.min(50, Math.max(1, Math.trunc(Number(req.query.limit)) || 25));
    const errorsOnly = req.query.errors_only === "1" || req.query.errors_only === "true";
    const agent = typeof req.query.agent === "string" && req.query.agent ? req.query.agent.slice(0, 200) : undefined;
    const rows = await loadTraces(hours, limit, errorsOnly, agent, requestAbort(req, res));
    res.json({ data: rows, source: sourceLabel() });
  } catch (e) {
    sendQueryError(res, e);
  }
});

// #4: HTTP widget requests validate through the SAME zod schema as the MCP
// tool — invalid values are 400s, never silently coerced into different
// queries, and dry_run accepts true/1 (anything else is rejected).
const widgetArgsSchema = z.object(widgetArgs);

app.get("/api/widget", checkOrigin, requireAuth, async (req, res) => {
  try {
    const q = req.query;
    const str = (k: string): string | undefined => (typeof q[k] === "string" && q[k] !== "" ? (q[k] as string) : undefined);
    const num = (k: string): number | string | undefined => {
      const v = str(k);
      if (v === undefined) return undefined;
      const n = Number(v);
      return Number.isFinite(n) ? n : v; // non-numeric falls through to zod for a 400
    };
    const bool = (k: string): boolean | string | undefined => {
      const v = str(k);
      if (v === undefined) return undefined;
      if (v === "1" || v === "true") return true;
      if (v === "0" || v === "false") return false;
      return v; // invalid → zod 400
    };
    const parsed = widgetArgsSchema.safeParse({
      measure: str("measure"),
      dimension: str("dimension"),
      time_range_hours: num("time_range_hours"),
      granularity: str("granularity"),
      agent: str("agent"),
      model: str("model"),
      tool: str("tool"),
      status: str("status"),
      limit: num("limit"),
      dry_run: bool("dry_run"),
    });
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ") });
      return;
    }
    const a = parsed.data as WidgetArgs;
    const data = await loadWidget(widgetSpecOf(a), a.time_range_hours ?? CONFIG.defaultHours, !!a.dry_run, requestAbort(req, res));
    res.json({ data });
  } catch (e) {
    if (e instanceof WidgetSpecError) {
      res.status(400).json({ error: e.message });
      return;
    }
    sendQueryError(res, e);
  }
});

app.post("/api/ask", checkOrigin, requireAuth, async (req, res) => {
  try {
    const question = typeof req.body?.question === "string" ? req.body.question.trim() : "";
    if (question.length < 3 || question.length > 2000) {
      res.status(400).json({ error: "question must be 3-2000 characters" });
      return;
    }
    const history: AskExchange[] = Array.isArray(req.body?.history)
      ? req.body.history
          .filter((h: any) => typeof h?.question === "string" && typeof h?.answer === "string")
          .slice(-3)
      : [];
    const hoursRaw = Math.trunc(Number(req.body?.time_range_hours));
    const scope: AskScope = {
      time_range_hours: Number.isInteger(hoursRaw) && hoursRaw > 0 ? Math.min(MAX_HOURS, hoursRaw) : undefined,
      agent: typeof req.body?.agent === "string" && req.body.agent ? req.body.agent.slice(0, 200) : undefined,
    };
    const data = await ask(question, history, scope, requestAbort(req, res));
    res.json({ data });
  } catch (e) {
    sendQueryError(res, e);
  }
});

app.post("/mcp", checkOrigin, requireAuth, async (req, res) => {
  const mcp = buildMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on("close", () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// #19: body-parse failures and unhandled route errors keep the JSON contract
app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err?.type === "entity.too.large") {
    res.status(413).json({ error: "Request body too large (limit 2 MB)" });
    return;
  }
  if (err instanceof SyntaxError && "body" in err) {
    res.status(400).json({ error: "Malformed JSON body" });
    return;
  }
  console.error(JSON.stringify({ ts: new Date().toISOString(), unhandled: err instanceof Error ? err.message : String(err) }));
  res.status(500).json({ error: "Internal server error" });
});

app.listen(CONFIG.port, CONFIG.host, () => {
  const authNote = CONFIG.authToken ? "auth: bearer token" : "auth: NONE (set BQAA_AUTH_TOKEN)";
  const originNote = CONFIG.allowedOrigins.length
    ? `origins: ${CONFIG.allowedOrigins.join(",")}`
    : "origins: same-origin only";
  console.log(
    `BQAA dashboard MCP server on http://${CONFIG.host}:${CONFIG.port}/mcp ` +
      (CONFIG.mock
        ? "(mock data — set BQAA_PROJECT/BQAA_DATASET/BQAA_TABLE for BigQuery)"
        : `(BigQuery: ${CONFIG.project}.${CONFIG.dataset}.${CONFIG.table})`) +
      ` [${authNote}; ${originNote}]`,
  );
});
