// Waterfall span-reconstruction rules — pairing, latency fallback, hierarchy.
import assert from "node:assert/strict";
import { test } from "node:test";
import { buildSpans } from "../src/spans.js";

const ev = (over) => ({
  timestamp: "2026-08-07T00:00:00Z", event_type: "TOOL_STARTING", agent: "a1",
  invocation_id: null, span_id: null, parent_span_id: null, llm_response: null,
  tool_name: null, tool_origin: null, latency_ms: null, status: "OK", error_message: null,
  ...over,
});

test("start/complete pairs become one span with the right duration", () => {
  const { spans, totalMs } = buildSpans([
    ev({ span_id: "s1", event_type: "TOOL_STARTING", tool_name: "search_kb", timestamp: "2026-08-07T00:00:01Z" }),
    ev({ span_id: "s1", event_type: "TOOL_COMPLETED", tool_name: "search_kb", timestamp: "2026-08-07T00:00:03Z", latency_ms: 2000 }),
  ]);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].name, "search_kb");
  assert.equal(spans[0].kind, "tool");
  assert.equal(spans[0].endMs - spans[0].startMs, 2000);
  assert.equal(spans[0].instant, false);
  assert.equal(totalMs, 2000); // trace time starts at the EARLIEST event (:01), not :00
});

test("completion-only logging back-computes the start from latency", () => {
  const { spans } = buildSpans([
    ev({ event_type: "LLM_REQUEST", span_id: "root", timestamp: "2026-08-07T00:00:00Z" }),
    ev({ span_id: "L2", event_type: "LLM_RESPONSE", timestamp: "2026-08-07T00:00:05Z", latency_ms: 1500 }),
  ]);
  const llm = spans.find((s) => s.id === "L2");
  assert.equal(llm.startMs, 3500);
  assert.equal(llm.endMs, 5000);
  assert.equal(llm.name, "LLM call");
});

test("parent chains produce depth; cycles and missing parents stay at 0", () => {
  const { spans } = buildSpans([
    ev({ span_id: "root", event_type: "LLM_REQUEST" }),
    ev({ span_id: "child", parent_span_id: "root", event_type: "TOOL_STARTING", tool_name: "t", timestamp: "2026-08-07T00:00:01Z" }),
    ev({ span_id: "grand", parent_span_id: "child", event_type: "TOOL_STARTING", tool_name: "g", timestamp: "2026-08-07T00:00:02Z" }),
    ev({ span_id: "lost", parent_span_id: "nonexistent", event_type: "TOOL_STARTING", tool_name: "l", timestamp: "2026-08-07T00:00:03Z" }),
  ]);
  const by = Object.fromEntries(spans.map((s) => [s.id, s.depth]));
  assert.equal(by.root, 0);
  assert.equal(by.child, 1);
  assert.equal(by.grand, 2);
  assert.equal(by.lost, 0);
});

test("errors mark the span; span-less events render as instants", () => {
  const { spans } = buildSpans([
    ev({ span_id: "s1", event_type: "TOOL_STARTING", tool_name: "x" }),
    ev({ span_id: "s1", event_type: "TOOL_ERROR", tool_name: "x", timestamp: "2026-08-07T00:00:02Z", status: "ERROR", error_message: "boom" }),
    ev({ event_type: "USER_MESSAGE_RECEIVED", timestamp: "2026-08-07T00:00:00Z" }),
  ]);
  const s1 = spans.find((s) => s.id === "s1");
  assert.equal(s1.error, true);
  assert.equal(s1.detail, "boom");
  const orphan = spans.find((s) => s.id === null);
  assert.equal(orphan.instant, true);
  assert.equal(orphan.name, "USER_MESSAGE_RECEIVED");
});

test("spans sort by start time and empty input is safe", () => {
  assert.deepEqual(buildSpans([]), { spans: [], totalMs: 0 });
  const { spans } = buildSpans([
    ev({ span_id: "b", event_type: "TOOL_STARTING", tool_name: "later", timestamp: "2026-08-07T00:00:05Z" }),
    ev({ span_id: "a", event_type: "TOOL_STARTING", tool_name: "earlier", timestamp: "2026-08-07T00:00:01Z" }),
  ]);
  assert.deepEqual(spans.map((s) => s.name), ["earlier", "later"]);
});

test("cyclic parent chains collapse to depth 0 (#11-r9)", () => {
  const { spans } = buildSpans([
    ev({ span_id: "self", parent_span_id: "self", event_type: "TOOL_STARTING", tool_name: "s" }),
    ev({ span_id: "A", parent_span_id: "B", event_type: "TOOL_STARTING", tool_name: "a", timestamp: "2026-08-07T00:00:01Z" }),
    ev({ span_id: "B", parent_span_id: "A", event_type: "TOOL_STARTING", tool_name: "b", timestamp: "2026-08-07T00:00:02Z" }),
  ]);
  const by = Object.fromEntries(spans.map((sp) => [sp.id, sp.depth]));
  assert.equal(by.self, 0, "self-cycle is not a level of nesting");
  assert.equal(by.A, 0, "two-node cycle member A");
  assert.equal(by.B, 0, "two-node cycle member B");
});

test("a lone completion-only span keeps its full duration (#12-r9)", () => {
  const { spans, totalMs } = buildSpans([
    ev({ span_id: "L", event_type: "LLM_RESPONSE", timestamp: "2026-08-07T00:00:05Z", latency_ms: 1500 }),
  ]);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].startMs, 0, "trace origin moves back to the inferred start");
  assert.equal(spans[0].endMs, 1500);
  assert.equal(spans[0].instant, false);
  assert.equal(totalMs, 1500);
});

test("spanless events with latency render as bars, not instants (#12-r9)", () => {
  const { spans } = buildSpans([
    ev({ span_id: "s1", event_type: "TOOL_STARTING", tool_name: "t", timestamp: "2026-08-07T00:00:00Z" }),
    ev({ event_type: "LLM_RESPONSE", timestamp: "2026-08-07T00:00:04Z", latency_ms: 3000 }),
  ]);
  const orphan = spans.find((sp) => sp.id === null);
  assert.equal(orphan.instant, false, "latency gives the orphan a measurable duration");
  assert.equal(orphan.endMs - orphan.startMs, 3000);
  assert.equal(orphan.startMs, 1000, "start back-computed from ts - latency");
});

test("cycle depth is identical under every event permutation (#15-r10)", () => {
  const mk = () => [
    ev({ span_id: "A", parent_span_id: "B", event_type: "TOOL_STARTING", tool_name: "a" }),
    ev({ span_id: "B", parent_span_id: "A", event_type: "TOOL_STARTING", tool_name: "b", timestamp: "2026-08-07T00:00:01Z" }),
    ev({ span_id: "C", parent_span_id: "A", event_type: "TOOL_STARTING", tool_name: "c", timestamp: "2026-08-07T00:00:02Z" }),
  ];
  const perms = [
    [0, 1, 2], [0, 2, 1], [1, 0, 2], [1, 2, 0], [2, 0, 1], [2, 1, 0],
  ];
  const results = perms.map((order) => {
    const base = mk();
    const { spans } = buildSpans(order.map((i) => base[i]));
    return Object.fromEntries(spans.map((sp) => [sp.id, sp.depth]));
  });
  for (const r of results) {
    assert.equal(r.A, 0, "cycle member A");
    assert.equal(r.B, 0, "cycle member B");
    assert.equal(r.C, 1, "C hangs off the zeroed cycle, deterministically");
  }
});

test("non-finite latency is treated as absent, never NaN coordinates (#14-r10)", () => {
  const { spans } = buildSpans([
    ev({ span_id: "L", event_type: "LLM_RESPONSE", timestamp: "2026-08-07T00:00:05Z", latency_ms: NaN }),
    ev({ event_type: "USER_MESSAGE_RECEIVED", timestamp: "2026-08-07T00:00:01Z", latency_ms: Infinity }),
  ]);
  for (const sp of spans) {
    assert.ok(Number.isFinite(sp.startMs) && Number.isFinite(sp.endMs), `${sp.name} has finite coordinates`);
  }
});

import { mockTrace } from "../src/mock.js";

test("the mock trace demonstrates 4-deep nesting with true parent links", () => {
  const { spans } = buildSpans(mockTrace("trace4ea11f3a10"));
  const byId = Object.fromEntries(spans.filter((s) => s.id).map((s) => [s.id, s]));
  assert.equal(byId["s1"].depth, 0);
  assert.equal(byId["t0"].depth, 1);
  assert.equal(byId["d-llm"].depth, 2);
  assert.equal(byId["d-tool"].depth, 3);
  // parentId is the collapse chain: child → parent, one level at a time
  assert.equal(byId["d-tool"].parentId, "d-llm");
  assert.equal(byId["d-llm"].parentId, "t0");
  assert.equal(byId["t0"].parentId, "s1");
  assert.equal(byId["s1"].parentId, null);
});

test("cycle members never become collapse parents", () => {
  const { spans } = buildSpans([
    ev({ span_id: "A", parent_span_id: "B", event_type: "TOOL_STARTING", tool_name: "a" }),
    ev({ span_id: "B", parent_span_id: "A", event_type: "TOOL_STARTING", tool_name: "b", timestamp: "2026-08-07T00:00:01Z" }),
  ]);
  for (const sp of spans) assert.equal(sp.parentId, null, `${sp.id} must not nest under a cycle`);
});

test("deep chains keep full collapse ancestry past the display cap (#5-r13)", () => {
  const events = Array.from({ length: 9 }, (_, i) =>
    ev({
      span_id: `s${i}`,
      parent_span_id: i ? `s${i - 1}` : null,
      event_type: "TOOL_STARTING",
      tool_name: `t${i}`,
      timestamp: `2026-08-07T00:00:0${i}Z`,
    }),
  );
  const { spans } = buildSpans(events);
  const byId = Object.fromEntries(spans.map((s) => [s.id, s]));
  // display depth caps at 6...
  assert.equal(byId.s6.depth, 6);
  assert.equal(byId.s8.depth, 6);
  // ...but LOGICAL ancestry is intact all the way down
  for (let i = 1; i < 9; i++) assert.equal(byId[`s${i}`].parentId, `s${i - 1}`, `s${i} keeps its parent`);
  // so collapsing the root must be able to hide every descendant by walking parentId
  const reachable = new Set(["s0"]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const sp of spans) {
      if (sp.parentId && reachable.has(sp.parentId) && !reachable.has(sp.id)) {
        reachable.add(sp.id);
        grew = true;
      }
    }
  }
  assert.equal(reachable.size, 9, "the whole chain is reachable from the root");
});
