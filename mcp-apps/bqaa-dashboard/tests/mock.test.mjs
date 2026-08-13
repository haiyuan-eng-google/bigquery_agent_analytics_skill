// Mock-data truthfulness — filters honored, one row set drives everything (r9).
import assert from "node:assert/strict";
import { test } from "node:test";
import { mockWidget, mockAsk, mockErrorTraces, mockTrace, mockDashboard, mockTracesList } from "../src/mock.js";

const start = new Date("2026-07-01T00:00:00Z");
const end = new Date("2026-07-02T00:00:00Z");

test("mockWidget honors a filter on the grouped dimension (#8-r9)", () => {
  const spec = { measure: "events", dimension: "agent", granularity: "auto", filters: { agent: "coder" } };
  const r = mockWidget(spec, start, end);
  assert.equal(r.rows.length, 1, "a matching dimension filter narrows to that value");
  assert.equal(r.rows[0].dim, "coder");
});

test("filtering to an entity that does not exist returns zero rows (#11-r10)", () => {
  const spec = { measure: "events", dimension: "agent", granularity: "auto", filters: { agent: "no-such-agent" } };
  const r = mockWidget(spec, start, end);
  assert.deepEqual(r.rows, [], "the mock must not invent the requested value");
});

test("mockWidget applies the production categorical limit contract (#12-r10)", () => {
  const base = { measure: "events", dimension: "agent", granularity: "auto" };
  assert.equal(mockWidget({ ...base, limit: 1 }, start, end).rows.length, 1, "limit: 1 keeps only the top row");
  assert.equal(mockWidget(base, start, end).rows.length, 4, "default keeps the whole 4-agent domain (under 20)");
  assert.equal(mockWidget({ ...base, limit: 100 }, start, end).rows.length, 4, "upper bound never pads rows");
});

test("mockWidget seed covers filters — different filters, different data (#8-r9)", () => {
  const base = { measure: "events", dimension: "agent", granularity: "auto" };
  const a = mockWidget({ ...base, filters: {} }, start, end);
  const b = mockWidget({ ...base, filters: { tool: "search_kb" } }, start, end);
  assert.notDeepEqual(a.rows, b.rows, "a non-dimension filter must still change the sample");
});

test("mockAsk prose, rows, and SQL all come from one sorted sample (#10-r9)", () => {
  const r = mockAsk("Which tool fails most?", { startIso: "2026-07-01T00:00:00Z", endIso: "2026-07-02T00:00:00Z" });
  const rates = r.rows.map((row) => row.failure_rate);
  assert.deepEqual(rates, [...rates].sort((x, y) => y - x), "rows arrive sorted by failure rate");
  const top = r.rows[0];
  assert.ok(r.answer.includes(`**${top.tool_name}**`), "prose names the actual top row");
  assert.ok(r.answer.includes(`${(top.failure_rate * 100).toFixed(1)}%`), "prose quotes the actual top rate");
  assert.match(r.sql, /SELECT tool_name, starting_count, error_count, error_count \/ starting_count AS failure_rate/);
});

test("mockAsk escapes a hostile agent value in the sample SQL (#9-r9)", () => {
  const r = mockAsk("q", { startIso: "2026-07-01T00:00:00Z", endIso: "2026-07-02T00:00:00Z", agent: "x' OR '1'='1" });
  assert.ok(!r.sql.includes("agent = 'x' OR '1'='1'"), "raw interpolation would break out of the literal");
  assert.ok(r.sql.includes("agent = 'x\\' OR \\'1\\'=\\'1'"), "value is escaped as one literal");
});

test("every listed error trace round-trips to its listed error count (#13-r10)", () => {
  const isError = (e) => e.status === "ERROR" || e.event_type.endsWith("_ERROR") || e.error_message != null;
  for (const row of mockErrorTraces()) {
    const events = mockTrace(row.trace_id);
    const errors = events.filter(isError);
    assert.equal(errors.length, row.error_events, `${row.trace_id} must show exactly its listed count`);
    assert.ok(errors.every((e) => e.error_message === row.sample_errors), "drill-down shows the listed message");
  }
  // and a trace NOT on the list must be error-free, so the list is complete
  const other = mockTrace("traceffffffff9");
  assert.equal(other.filter(isError).length, 0, "unlisted traces cannot contradict the error list");
});

test("mock error-trace list honors the requested window (#6-r11)", () => {
  // fixture rows are 1.5h apart: a 1h window keeps only the newest
  assert.equal(mockErrorTraces(1).length, 1);
  assert.equal(mockErrorTraces(4).length, 3, "rows at 0h/1.5h/3h fit a 4h window");
  assert.equal(mockErrorTraces(720).length, 6, "a wide window keeps the whole fixture");
});

test("an unknown dashboard agent returns the empty window BigQuery would (#8-r11)", () => {
  const d = mockDashboard(start, end, "hour", "no-such-agent");
  assert.equal(d.overview.total_events, 0);
  assert.deepEqual(d.timeseries, []);
  assert.deepEqual(d.topSessions, []);
  assert.equal(d.meta.agent, "no-such-agent");
});

test("impossible cross-filters return zero widget rows for every dimension (#8-r11)", () => {
  const time = mockWidget({ measure: "events", dimension: "time", granularity: "hour", filters: { tool: "no_such_tool" } }, start, end);
  assert.deepEqual(time.rows, [], "a time widget must not chart activity for a nonexistent tool");
  const cat = mockWidget({ measure: "events", dimension: "agent", granularity: "auto", filters: { model: "no-such-model" } }, start, end);
  assert.deepEqual(cat.rows, [], "a categorical widget must not rank agents for a nonexistent model");
});

test("mockTracesList round-trips exactly to mockTrace (explorer truth)", () => {
  for (const row of mockTracesList(720)) {
    const events = mockTrace(row.trace_id);
    const errors = events.filter(
      (e) => e.status === "ERROR" || e.event_type.endsWith("_ERROR") || e.error_message != null,
    ).length;
    assert.equal(row.events, events.length, `${row.trace_id} event count`);
    assert.equal(row.error_events, errors, `${row.trace_id} error count`);
  }
  const errsOnly = mockTracesList(720, true);
  assert.ok(errsOnly.length > 0 && errsOnly.every((r) => r.error_events > 0));
  const scoped = mockTracesList(720, false, "no-such-agent");
  assert.deepEqual(scoped, [], "an unknown agent filter returns no traces");
});

test("list timestamps ARE the drill-down timestamps (#4-r12)", () => {
  for (const row of mockErrorTraces(720)) {
    const events = mockTrace(row.trace_id);
    const lastEvent = Math.max(...events.map((e) => Date.parse(e.timestamp)));
    assert.equal(row.last_ts, new Date(lastEvent).toISOString(), `${row.trace_id} list vs drill-down`);
  }
  for (const row of mockTracesList(720)) {
    const events = mockTrace(row.trace_id);
    const times = events.map((e) => Date.parse(e.timestamp));
    assert.equal(row.last_ts, new Date(Math.max(...times)).toISOString());
    assert.equal(row.start_ts, new Date(Math.min(...times)).toISOString());
  }
});

test("mockTrace honors the requested window (#4-r12)", () => {
  const oldest = mockErrorTraces(720).at(-1);
  const all = mockTrace(oldest.trace_id);
  assert.ok(all.length > 0);
  // that trace is hours old — a 1h window excludes every event
  const narrow = mockTrace(oldest.trace_id, 1);
  assert.deepEqual(narrow, [], "events outside the window must not be returned");
  // a wide window returns them all, inside the range
  const wide = mockTrace(oldest.trace_id, 720);
  assert.equal(wide.length, all.length);
  const cutoff = Date.now() - 720 * 3_600_000 - 60_000; // tolerance for the mock clock epoch
  assert.ok(wide.every((e) => Date.parse(e.timestamp) >= cutoff));
});

test("boundary-clipped traces list exactly what drill-down shows (#4-r13)", () => {
  // 3h window: the trace anchored exactly 3h ago is clipped mid-trace
  for (const hours of [3, 4.5 / 1.5, 2]) {
    for (const row of mockTracesList(hours)) {
      const events = mockTrace(row.trace_id, hours);
      assert.equal(row.events, events.length, `${row.trace_id} @${hours}h`);
      const times = events.map((e) => Date.parse(e.timestamp));
      assert.equal(row.last_ts, new Date(Math.max(...times)).toISOString());
      assert.equal(row.duration_ms, Math.max(...times) - Math.min(...times));
    }
  }
  // error list too: windowed error counts, no empty-window rows
  for (const row of mockErrorTraces(3)) {
    const events = mockTrace(row.trace_id, 3);
    const errors = events.filter(
      (e) => e.status === "ERROR" || e.event_type.endsWith("_ERROR") || e.error_message != null,
    ).length;
    assert.equal(row.error_events, errors, `${row.trace_id} windowed error count`);
    assert.ok(errors > 0, "an errorless windowed slice must not be listed");
  }
});

test("mock error-trace rows list every participating agent (#3-r14)", () => {
  for (const row of mockErrorTraces(720)) {
    const events = mockTrace(row.trace_id, 720);
    const expected = [...new Set(events.map((e) => e.agent).filter(Boolean))].slice(0, 5).join(",");
    assert.equal(row.agents, expected, `${row.trace_id} agents must match its drill-down`);
    assert.ok(row.agents.includes("sub-researcher"), "the delegated sub-agent is a participant");
  }
});

test("mock model calls equal timeseries attempts (#4-r17)", () => {
  const d = mockDashboard(start, end, "hour");
  const attempts = d.timeseries.reduce((a, b) => a + b.llm_calls, 0);
  const responses = d.timeseries.reduce((a, b) => a + b.llm_responses, 0);
  const modelCalls = d.modelComparison.reduce((a, m) => a + m.calls, 0);
  assert.ok(attempts > responses, "the preview models failed attempts");
  assert.equal(modelCalls, attempts, "model breakdown sums exactly to the attempt total");
});

test("mock enforces the same widget compatibility contract (#1-r19)", () => {
  assert.throws(
    () => mockWidget({ measure: "p95_latency_ms", dimension: "tool", granularity: "auto", filters: { status: "ERROR" } }, start, end),
    /cannot be grouped/,
    "the preview must not fabricate data production would answer with nulls",
  );
});

test("mock cost buckets sum to the timeseries billed tokens (#3-r19)", () => {
  const d = mockDashboard(start, end, "hour");
  const billed = d.timeseries.reduce((a, b) => a + b.prompt_tokens + b.completion_tokens, 0);
  const bucketed = (d.costBuckets ?? []).reduce((a, c) => a + c.prompt_tokens + c.completion_tokens, 0);
  assert.equal(bucketed, billed, "the exact-cost series covers every billed token");
  assert.ok((d.costBuckets ?? []).some((c) => c.model_id === "gemini-2.5-pro"));
});
