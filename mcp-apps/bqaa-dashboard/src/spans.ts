// Span reconstruction for the trace waterfall — pure and browser-safe, so the
// pairing/hierarchy rules are unit-testable without a DOM.
//
// agent_events logs spans as event pairs: TOOL_STARTING → TOOL_COMPLETED /
// TOOL_ERROR, LLM_REQUEST → LLM_RESPONSE / LLM_ERROR, sharing a span_id. Some
// producers log only the completion event with latency_ms; some events have
// no span at all. All three shapes must render truthfully.

import type { TraceEvent } from "./types.js";

export type SpanKind = "llm" | "tool" | "other";

export interface TraceSpan {
  id: string | null;
  name: string;
  kind: SpanKind;
  agent: string | null;
  startMs: number; // relative to trace start
  endMs: number;
  depth: number; // parent-chain nesting, capped
  // TRUE nesting parent only: set when the parent span exists in this trace
  // and sits exactly one level up — collapse/expand walks this chain, so
  // cycle members (depth 0) never parent each other
  parentId: string | null;
  error: boolean;
  instant: boolean; // no measurable duration — render as a point marker
  detail: string; // tooltip line: origin / error message / response snippet
}

const MAX_DEPTH = 6;
const START_TYPES = /(_STARTING|_REQUEST)$/;

function isErrorEvent(e: TraceEvent): boolean {
  return e.status === "ERROR" || e.event_type.endsWith("_ERROR") || e.error_message != null;
}

function kindOf(eventTypes: string[]): SpanKind {
  if (eventTypes.some((t) => t.startsWith("LLM"))) return "llm";
  if (eventTypes.some((t) => t.startsWith("TOOL"))) return "tool";
  return "other";
}

export function buildSpans(events: TraceEvent[]): { spans: TraceSpan[]; totalMs: number } {
  if (!events.length) return { spans: [], totalMs: 0 };

  // group by span_id; span-less events become their own instant rows
  const groups = new Map<string, TraceEvent[]>();
  const orphans: TraceEvent[] = [];
  for (const e of events) {
    if (e.span_id) {
      const g = groups.get(e.span_id) ?? [];
      g.push(e);
      groups.set(e.span_id, g);
    } else {
      orphans.push(e);
    }
  }

  // parent map for depth resolution
  const parentOf = new Map<string, string | null>();
  for (const [id, g] of groups) {
    parentOf.set(id, g.find((e) => e.parent_span_id)?.parent_span_id ?? null);
  }
  // #11(r9): cyclic parent links are malformed hierarchy — members of a cycle
  // get depth 0. #15(r10): ONLY the members actually on the cycle are zeroed;
  // a chain that merely leads INTO a cycle resolves off it (parent depth + 1),
  // so permuting event order can never change any span's depth.
  const depthCache = new Map<string, number>();
  // #5(r13): cycle membership is tracked separately so LOGICAL ancestry
  // (parentId, used for collapse) survives the display-depth cap — only
  // cycle-tainted links are severed, never merely-deep ones
  const cycleMembers = new Set<string>();
  const depthOf = (id: string): number => {
    if (depthCache.has(id)) return depthCache.get(id)!;
    const chain: string[] = [];
    const seen = new Set<string>();
    let cur: string | null = id;
    while (cur && groups.has(cur) && !depthCache.has(cur)) {
      if (seen.has(cur)) {
        for (const c of chain.slice(chain.indexOf(cur))) {
          depthCache.set(c, 0); // the cycle itself
          cycleMembers.add(c);
        }
        break;
      }
      seen.add(cur);
      chain.push(cur);
      const parent: string | null = parentOf.get(cur) ?? null;
      cur = parent && groups.has(parent) ? parent : null;
      if (cur === null) depthCache.set(chain[chain.length - 1], 0);
    }
    for (let i = chain.length - 1; i >= 0; i--) {
      const c = chain[i];
      if (depthCache.has(c)) continue;
      const parent = parentOf.get(c)!;
      depthCache.set(c, Math.min(MAX_DEPTH, (depthCache.get(parent) ?? 0) + 1));
    }
    return depthCache.get(id) ?? 0;
  };

  // #12(r9): compute ABSOLUTE inferred bounds first — a completion-only span
  // whose back-computed start precedes every logged event must move the trace
  // origin, not be clamped into a zero-length bar.
  interface RawBounds {
    startAbs: number;
    endAbs: number;
  }
  const boundsOf = new Map<string, RawBounds>();
  for (const [id, g] of groups) {
    const times = g.map((e) => Date.parse(e.timestamp));
    const starts = g.filter((e) => START_TYPES.test(e.event_type));
    // residual #14(r10): malformed latency (NaN/Infinity from bad JSON) must
    // never reach coordinate math — treat it as absent
    const latency = g.map((e) => e.latency_ms).find((l) => l != null && Number.isFinite(l)) ?? null;
    if (starts.length) {
      boundsOf.set(id, {
        startAbs: Math.min(...starts.map((e) => Date.parse(e.timestamp))),
        endAbs: Math.max(...times),
      });
    } else if (latency != null) {
      const endAbs = Math.max(...times);
      boundsOf.set(id, { startAbs: endAbs - latency, endAbs });
    } else {
      const at = Math.min(...times);
      boundsOf.set(id, { startAbs: at, endAbs: at });
    }
  }
  const orphanBounds = orphans.map((e) => {
    const at = Date.parse(e.timestamp);
    // spanless completion events get the same latency fallback (finite only)
    return e.latency_ms != null && Number.isFinite(e.latency_ms)
      ? { startAbs: at - e.latency_ms, endAbs: at }
      : { startAbs: at, endAbs: at };
  });
  const t0 = Math.min(
    ...events.map((e) => Date.parse(e.timestamp)),
    ...[...boundsOf.values()].map((b) => b.startAbs),
    ...orphanBounds.map((b) => b.startAbs),
  );

  const spans: TraceSpan[] = [];
  for (const [id, g] of groups) {
    const { startAbs, endAbs } = boundsOf.get(id)!;
    const startMs = startAbs - t0;
    const endMs = endAbs - t0;
    const types = g.map((e) => e.event_type);
    const kind = kindOf(types);
    const tool = g.map((e) => e.tool_name).find(Boolean) ?? null;
    const err = g.find(isErrorEvent);
    const depth = depthOf(id);
    const parent = parentOf.get(id);
    spans.push({
      id,
      name: tool ?? (kind === "llm" ? "LLM call" : types[0]),
      kind,
      agent: g.map((e) => e.agent).find(Boolean) ?? null,
      startMs,
      endMs: Math.max(endMs, startMs),
      depth,
      // #5(r13): logical parent whenever the parent exists and neither end is
      // cycle-tainted — deep chains past the DISPLAY cap keep full ancestry,
      // so collapsing a root hides every descendant
      parentId: parent && groups.has(parent) && !cycleMembers.has(parent) && !cycleMembers.has(id) ? parent : null,
      error: !!err,
      instant: endMs <= startMs,
      detail:
        err?.error_message ??
        g.map((e) => e.tool_origin).find(Boolean) ??
        g.map((e) => e.llm_response).find(Boolean)?.slice(0, 120) ??
        "",
    });
  }
  orphans.forEach((e, i) => {
    const { startAbs, endAbs } = orphanBounds[i];
    spans.push({
      id: null,
      name: e.tool_name ?? e.event_type,
      kind: kindOf([e.event_type]),
      agent: e.agent,
      startMs: startAbs - t0,
      endMs: endAbs - t0,
      depth: 0,
      parentId: null,
      error: isErrorEvent(e),
      instant: endAbs <= startAbs,
      detail: e.error_message ?? "",
    });
  });

  spans.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const totalMs = Math.max(1, ...spans.map((s) => s.endMs), Math.max(...events.map((e) => Date.parse(e.timestamp))) - t0);
  return { spans, totalMs };
}
