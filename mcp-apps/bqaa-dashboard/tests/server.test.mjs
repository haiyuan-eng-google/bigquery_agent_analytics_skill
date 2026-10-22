// Integration tests: spawn the real server (mock data mode) and exercise the
// HTTP + MCP surfaces, including auth, Origin policy, and config validation.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, before, test } from "node:test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

function startServer(env, port) {
  const child = spawn(process.execPath, ["--import", "tsx", "server.ts"], {
    cwd: root,
    env: { ...process.env, BQAA_MOCK: "1", PORT: String(port), ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  child.stdout.on("data", (d) => (logs += d));
  child.stderr.on("data", (d) => (logs += d));
  return { child, logs: () => logs };
}

async function waitFor(url, ms = 15_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`server did not come up at ${url}`);
}

async function rpc(base, method, params, headers = {}) {
  const res = await fetch(`${base}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const PORT = 3800 + Math.floor(Math.random() * 100);
const BASE = `http://localhost:${PORT}`;
let main;

before(async () => {
  main = startServer({}, PORT);
  await waitFor(`${BASE}/healthz`);
});

after(() => {
  main?.child.kill();
});

test("healthz reports ok and mock mode", async () => {
  const res = await fetch(`${BASE}/healthz`);
  const body = await res.json();
  assert.equal(body.ok, true);
  assert.equal(body.mock, true);
});

test("root serves the dashboard shell", async () => {
  const res = await fetch(BASE);
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /Agent Analytics/);
});

test("/api/dashboard returns the full payload and clamps hours", async () => {
  const res = await fetch(`${BASE}/api/dashboard?time_range_hours=999999`);
  assert.equal(res.status, 200);
  const { data } = await res.json();
  assert.ok(data.overview);
  assert.ok(Array.isArray(data.timeseries));
  assert.ok(Array.isArray(data.topSessions));
  assert.ok(data.topSessions[0].trace_ids?.length, "sessions must carry drillable trace ids");
  const hours = (Date.parse(data.meta.end) - Date.parse(data.meta.start)) / 3_600_000;
  assert.ok(hours <= 2160 + 1, `hours clamped, got ${hours}`);
});

test("/api/trace validates trace_id and returns events", async () => {
  const bad = await fetch(`${BASE}/api/trace?trace_id=;drop`);
  assert.equal(bad.status, 400);
  const ok = await fetch(`${BASE}/api/trace?trace_id=abcd1234abcd1234`);
  assert.equal(ok.status, 200);
  const { data } = await ok.json();
  assert.ok(Array.isArray(data) && data.length > 0);
  assert.ok(data[0].event_type);
});

test("MCP initialize, tools/list, tools/call, resources/read", async () => {
  const init = await rpc(BASE, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test", version: "0" },
  });
  assert.equal(init.status, 200);

  const tools = await rpc(BASE, "tools/list", {});
  const names = tools.body.result.tools.map((t) => t.name);
  for (const expected of ["get_trace", "query_agent_metrics", "show_agent_dashboard", "query_widget", "render_widget", "list_error_traces"]) {
    assert.ok(names.includes(expected), `missing tool ${expected}`);
  }
  const dash = tools.body.result.tools.find((t) => t.name === "show_agent_dashboard");
  assert.equal(dash._meta?.ui?.resourceUri, "ui://bqaa/dashboard.html");

  const call = await rpc(BASE, "tools/call", {
    name: "query_agent_metrics",
    arguments: { time_range_hours: 24 },
  });
  assert.ok(call.body.result.structuredContent?.data?.overview);

  const res = await rpc(BASE, "resources/read", { uri: "ui://bqaa/dashboard.html" });
  assert.match(res.body.result.contents[0].mimeType, /^text\/html/);
});

test("MCP rejects invalid tool arguments", async () => {
  const call = await rpc(BASE, "tools/call", {
    name: "query_agent_metrics",
    arguments: { time_range_hours: 0 },
  });
  const failed = call.body.error != null || call.body.result?.isError === true;
  assert.ok(failed, "expected an error for out-of-range hours");
});

test("bearer auth guards data endpoints when configured", async () => {
  const port = PORT + 100;
  const srv = startServer({ BQAA_AUTH_TOKEN: "s3cret" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const noAuth = await fetch(`http://localhost:${port}/api/dashboard`);
    assert.equal(noAuth.status, 401);
    const mcpNoAuth = await rpc(`http://localhost:${port}`, "tools/list", {});
    assert.equal(mcpNoAuth.status, 401);
    const withAuth = await fetch(`http://localhost:${port}/api/dashboard`, {
      headers: { Authorization: "Bearer s3cret" },
    });
    assert.equal(withAuth.status, 200);
    // page shell stays reachable without auth (it holds no data)
    const page = await fetch(`http://localhost:${port}/`);
    assert.equal(page.status, 200);
  } finally {
    srv.child.kill();
  }
});

test("cross-origin requests require an allowlisted Origin", async () => {
  const port = PORT + 101;
  const srv = startServer({ BQAA_ALLOWED_ORIGINS: "https://ok.example" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const evil = await fetch(`http://localhost:${port}/api/dashboard`, {
      headers: { Origin: "https://evil.example" },
    });
    assert.equal(evil.status, 403);
    const ok = await fetch(`http://localhost:${port}/api/dashboard`, {
      headers: { Origin: "https://ok.example" },
    });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("access-control-allow-origin"), "https://ok.example");
    // no Origin header (server-to-server) passes
    const plain = await fetch(`http://localhost:${port}/api/dashboard`);
    assert.equal(plain.status, 200);
    // same-origin requests always pass (browsers send Origin on POSTs)
    const sameOrigin = await fetch(`http://localhost:${port}/api/dashboard`, {
      headers: { Origin: `http://localhost:${port}` },
    });
    assert.equal(sameOrigin.status, 200);
  } finally {
    srv.child.kill();
  }
});

test("invalid BQAA_DEFAULT_HOURS fails fast at startup", async () => {
  const srv = startServer({ BQAA_DEFAULT_HOURS: "abc" }, PORT + 102);
  const code = await new Promise((resolve) => srv.child.on("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(srv.logs(), /Invalid BQAA_DEFAULT_HOURS/);
});

// ---- parity + differentiator surfaces

test("/api/widget runs a widget and validates inputs", async () => {
  const bad = await fetch(`${BASE}/api/widget?measure=nope&dimension=time`);
  assert.equal(bad.status, 400);
  const ok = await fetch(`${BASE}/api/widget?measure=events&dimension=agent&time_range_hours=24`);
  assert.equal(ok.status, 200);
  const { data } = await ok.json();
  assert.equal(data.spec.measure, "events");
  assert.ok(Array.isArray(data.rows) && data.rows.length > 0);
  assert.ok(data.rows[0].dim != null);
});

test("/api/widget dry_run returns an estimate and no rows", async () => {
  const res = await fetch(`${BASE}/api/widget?measure=total_tokens&dimension=model&dry_run=1`);
  const { data } = await res.json();
  assert.equal(data.dry_run, true);
  assert.equal(data.rows.length, 0);
  assert.ok(data.estimated_bytes > 0);
});

test("dashboard payload includes prev_overview, hitl, delegation, freshness", async () => {
  const res = await fetch(`${BASE}/api/dashboard?time_range_hours=24`);
  const { data } = await res.json();
  assert.ok(data.prevOverview?.total_events > 0);
  assert.ok(Array.isArray(data.hitl) && data.hitl.length > 0);
  assert.ok(Array.isArray(data.delegation) && data.delegation.length > 0);
  assert.ok(data.overview.last_event_ts);
});

test("MCP exposes widget + error-trace tools; render_widget carries UI meta", async () => {
  const tools = await rpc(BASE, "tools/list", {});
  const byName = Object.fromEntries(tools.body.result.tools.map((t) => [t.name, t]));
  assert.ok(byName.query_widget);
  assert.ok(byName.list_error_traces);
  assert.equal(byName.render_widget?._meta?.ui?.resourceUri, "ui://bqaa/dashboard.html");

  const call = await rpc(BASE, "tools/call", {
    name: "query_widget",
    arguments: { measure: "p95_latency_ms", dimension: "agent", time_range_hours: 24 },
  });
  assert.ok(call.body.result.structuredContent?.data?.rows?.length > 0);

  const traces = await rpc(BASE, "tools/call", { name: "list_error_traces", arguments: {} });
  assert.ok(traces.body.result.structuredContent?.data?.length > 0);
  assert.match(traces.body.result.content[0].text, /trace/);
});

test("/api/ask answers via the conversational layer (mock) and validates input", async () => {
  const bad = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "hi" }),
  });
  assert.equal(bad.status, 400);
  const ok = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Which tool fails most?" }),
  });
  assert.equal(ok.status, 200);
  const { data } = await ok.json();
  assert.ok(data.answer.length > 10);
  assert.ok(data.sql);
  assert.ok(Array.isArray(data.rows) && data.rows.length > 0);
});

test("MCP ask_data tool answers questions", async () => {
  const call = await rpc(BASE, "tools/call", {
    name: "ask_data",
    arguments: { question: "Which tool fails most?" },
  });
  const d = call.body.result.structuredContent?.data;
  assert.ok(d?.answer);
  assert.match(call.body.result.content[0].text, /failure|fail/i);
});

// ---- fresh-review fixes

test("concurrent MCP calls all succeed with request-local servers (#5)", async () => {
  const results = await Promise.all(
    Array.from({ length: 8 }, () =>
      rpc(BASE, "tools/call", { name: "query_agent_metrics", arguments: { time_range_hours: 24 } }),
    ),
  );
  for (const r of results) {
    assert.equal(r.status, 200);
    assert.ok(r.body?.result?.structuredContent?.data?.overview, "each concurrent call must return data");
  }
});

test("URL tokens are rejected; cookie login works (#6)", async () => {
  const port = PORT + 103;
  const srv = startServer({ BQAA_AUTH_TOKEN: "s3cret" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    // token in the URL must NOT authenticate
    const urlToken = await fetch(`http://localhost:${port}/api/dashboard?token=s3cret`);
    assert.equal(urlToken.status, 401);
    // wrong login rejected
    const badLogin = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "nope" }),
    });
    assert.equal(badLogin.status, 401);
    // correct login issues an HttpOnly cookie that authenticates
    const login = await fetch(`http://localhost:${port}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "s3cret" }),
    });
    assert.equal(login.status, 204);
    const cookie = login.headers.get("set-cookie") ?? "";
    assert.match(cookie, /HttpOnly/);
    const withCookie = await fetch(`http://localhost:${port}/api/dashboard`, {
      headers: { Cookie: cookie.split(";")[0] },
    });
    assert.equal(withCookie.status, 200);
  } finally {
    srv.child.kill();
  }
});

test("readiness reports the data backend; payload carries exact sums and truncation (#26,#7,#23)", async () => {
  const health = await fetch(`${BASE}/api/health`);
  assert.equal(health.status, 200);
  const h = await health.json();
  assert.equal(h.bigquery, "mock");

  const res = await fetch(`${BASE}/api/dashboard?time_range_hours=24`);
  const { data } = await res.json();
  assert.ok(data.modelComparison[0].total_prompt_tokens > 0, "exact prompt-token sums required for cost");
  assert.ok(data.modelComparison[0].total_completion_tokens > 0);

  const trace = await fetch(`${BASE}/api/trace?trace_id=abcd1234abcd1234`);
  const t = await trace.json();
  assert.equal(typeof t.truncated, "boolean");
});

test("resources/read serves the built bundle, not the raw Vite shell", async () => {
  const res = await rpc(BASE, "resources/read", { uri: "ui://bqaa/dashboard.html" });
  const html = res.body.result.contents[0].text;
  assert.ok(!html.includes('src="/src/mcp-app.ts"'), "must serve the bundled dist, not the dev shell");
  assert.match(html, /viz-root/);
});

// ---- production BigQuery branches via the injectable fake client (#8)

const FAKE_ENV = { BQAA_MOCK: "", BQAA_PROJECT: "fake-proj", BQAA_FAKE_BQ: "ok" };

test("production path: real query pipeline succeeds, bills bytes, and caches (#8)", async () => {
  const port = PORT + 104;
  const srv = startServer(FAKE_ENV, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const res = await fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`);
    assert.equal(res.status, 200);
    const { data } = await res.json();
    assert.equal(data.meta.section_errors, undefined);
    assert.ok(data.meta.bytes_processed > 0, "bytes accounting must run");
    assert.equal(data.overview.total_events, 1000);
    assert.match(data.meta.source, /FAKE_BQ/, "synthetic data must be labeled as such (#3)");
    const again = await fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`);
    const second = await again.json();
    assert.equal(second.data.meta.cache_hit, true, "healthy results are cacheable");
  } finally {
    srv.child.kill();
  }
});

test("production path: partial failure reports the section and is NOT cached (#2)", async () => {
  const port = PORT + 105;
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "fail_one" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const res = await fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`);
    const { data } = await res.json();
    assert.match(data.meta.section_errors?.models ?? "", /synthetic models-section failure/);
    assert.ok(data.overview.total_events > 0, "healthy sections still render");
    // degraded results must not be served from cache: the retry re-executes
    const again = await fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`);
    const second = await again.json();
    assert.notEqual(second.data.meta.cache_hit, true, "partial results must be evicted from cache");
  } finally {
    srv.child.kill();
  }
});

test("production path: stalled job hits the deadline, is cancelled, and releases its slot (#9)", async () => {
  const port = PORT + 106;
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "stall", BQAA_QUERY_TIMEOUT_MS: "600" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const res = await fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`);
    const { data } = await res.json();
    assert.match(data.meta.section_errors?.overview ?? "", /timed out/);
    // the stalled job was cancelled and its slot released — the server keeps serving
    await new Promise((r) => setTimeout(r, 200));
    assert.match(srv.logs(), /FAKE_BQ_JOB_CANCELLED/);
    const widget = await fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent`);
    assert.equal(widget.status, 200);
  } finally {
    srv.child.kill();
  }
});

test("budget below BigQuery's 10-query minimum fails fast at startup (#4)", async () => {
  const srv = startServer({ ...FAKE_ENV, BQAA_MAX_BYTES_BILLED: "10000000" }, PORT + 107);
  const code = await new Promise((resolve) => srv.child.on("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(srv.logs(), /Invalid BQAA_MAX_BYTES_BILLED/);
});

test("ask_data accepts bounded history (#16)", async () => {
  const call = await rpc(BASE, "tools/call", {
    name: "ask_data",
    arguments: {
      question: "What about the second-worst tool?",
      history: [{ question: "Which tool fails most?", answer: "fetch_invoice at 7.1%" }],
    },
  });
  assert.ok(call.body.result.structuredContent?.data?.answer);
});

// ---- fourth-review fixes

import http from "node:http";

function rawRequest(port, { origin, host, path: reqPath = "/api/dashboard" }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port, path: reqPath, method: "GET", setHost: false,
        headers: { Host: host, Origin: origin } },
      (res) => resolve(res.statusCode),
    );
    req.on("error", reject);
    req.end();
  });
}

test("forged Host matching Origin no longer passes as same-origin (#10)", async () => {
  const port = PORT + 108;
  const srv = startServer({ BQAA_ALLOWED_ORIGINS: "https://ok.example" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    // attacker forges BOTH Origin and Host to the same value → must be refused
    const forged = await rawRequest(port, { origin: "https://attacker.test", host: "attacker.test" });
    assert.equal(forged, 403);
    // the operator-configured canonical origin IS trusted
    const srv2 = startServer({ BQAA_CANONICAL_ORIGIN: "https://myapp.example" }, port + 100);
    try {
      await waitFor(`http://localhost:${port + 100}/healthz`);
      const canonical = await fetch(`http://localhost:${port + 100}/api/dashboard`, {
        headers: { Origin: "https://myapp.example" },
      });
      assert.equal(canonical.status, 200);
    } finally {
      srv2.child.kill();
    }
  } finally {
    srv.child.kill();
  }
});

test("BQAA_FAKE_BQ is refused in production builds (#3)", async () => {
  const srv = startServer({ ...FAKE_ENV, NODE_ENV: "production" }, PORT + 109);
  const code = await new Promise((resolve) => srv.child.on("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(srv.logs(), /test-only/);
});

test("HTTP widget arguments share MCP validation (#4)", async () => {
  const badGranularity = await fetch(`${BASE}/api/widget?measure=events&dimension=time&granularity=weekly`);
  assert.equal(badGranularity.status, 400);
  const badLimit = await fetch(`${BASE}/api/widget?measure=events&dimension=agent&limit=abc`);
  assert.equal(badLimit.status, 400);
  const badDryRun = await fetch(`${BASE}/api/widget?measure=events&dimension=agent&dry_run=maybe`);
  assert.equal(badDryRun.status, 400);
  const trueDryRun = await fetch(`${BASE}/api/widget?measure=events&dimension=agent&dry_run=true`);
  assert.equal(trueDryRun.status, 200);
  const { data } = await trueDryRun.json();
  assert.equal(data.dry_run, true, "dry_run=true must be a dry run, not a billable query");
});

test("deadline covers job CREATION, not just polling (#1)", async () => {
  const port = PORT + 110;
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "stall_create", BQAA_QUERY_TIMEOUT_MS: "600" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const res = await fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`);
    const { data } = await res.json();
    assert.match(data.meta.section_errors?.overview ?? "", /timed out/);
    // slot released: subsequent work still runs
    const widget = await fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent`);
    assert.equal(widget.status, 200);
  } finally {
    srv.child.kill();
  }
});

test("permanently hung creations hold their slots — the cap never lies (#5-r11)", async () => {
  const port = PORT + 111;
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "stall_create_all", BQAA_QUERY_TIMEOUT_MS: "600" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    // r21: refreshes RESERVE atomically and queue, so saturate the pool with
    // twenty weight-1 widgets whose creations hang forever
    await Promise.all(
      Array.from({ length: 20 }, () =>
        fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent`).then((r) => r.json()),
      ),
    );
    const probe = await fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent`);
    const body = await probe.json();
    assert.match(body.error ?? "", /busy/i, "request 21 must be refused");
    // and it STAYS refused — no timer may hand out slots the transport still holds
    await new Promise((r) => setTimeout(r, 1600));
    const again = await fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent`);
    const againBody = await again.json();
    assert.match(againBody.error ?? "", /busy/i, "a timer valve must not defeat the cap");
  } finally {
    srv.child.kill();
  }
});

test("a malformed auth cookie is an absent credential, never a 500 (#3-r12)", async () => {
  const port = PORT + 112;
  const srv = startServer({ BQAA_AUTH_TOKEN: "s3cret" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const api = await fetch(`http://localhost:${port}/api/dashboard`, { headers: { Cookie: "bqaa_token=%" } });
    assert.equal(api.status, 401, "API route: undecodable cookie → unauthorized");
    const mcp = await rpc(`http://localhost:${port}`, "tools/list", {}, { Cookie: "bqaa_token=%" });
    assert.equal(mcp.status, 401, "MCP route: undecodable cookie → unauthorized");
    // a VALID cookie still authenticates
    const ok = await fetch(`http://localhost:${port}/api/dashboard`, { headers: { Cookie: "bqaa_token=s3cret" } });
    assert.equal(ok.status, 200);
  } finally {
    srv.child.kill();
  }
});

test("two concurrent refreshes never trade panels for admission (#1-r20)", async () => {
  const port = PORT + 113;
  // every creation is slow, so the two 11-job fan-outs genuinely overlap
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "slow_create_all", BQAA_QUERY_TIMEOUT_MS: "8000" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const [a, b] = await Promise.all([
      fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`).then((r) => r.json()),
      fetch(`http://localhost:${port}/api/dashboard?time_range_hours=48`).then((r) => r.json()),
    ]);
    for (const [name, resp] of [["first", a], ["second", b]]) {
      const errs = Object.values(resp.data?.meta?.section_errors ?? {});
      assert.ok(
        !errs.some((e) => /busy/i.test(e)),
        `${name} refresh must queue, not fail panels: ${errs.join("; ")}`,
      );
    }
  } finally {
    srv.child.kill();
  }
});

test("dashboard payload publishes explicit cost-truncation state (#1-r22)", async () => {
  const res = await fetch(`${BASE}/api/dashboard?time_range_hours=24`);
  const { data } = await res.json();
  assert.equal(typeof data.cost_buckets_truncated, "boolean", "every consumer sees the flag");
  assert.equal(data.cost_buckets_truncated, false, "the small fake series is complete");
});

test("admission pressure answers 503 with Retry-After, never 500 (#2-r22)", async () => {
  const port = PORT + 115;
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "stall_create_all", BQAA_QUERY_TIMEOUT_MS: "600" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    // saturate the pool with twenty hung weight-1 widgets
    await Promise.all(
      Array.from({ length: 20 }, () =>
        fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent`).then((r) => r.json()),
      ),
    );
    const probe = await fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent`);
    assert.equal(probe.status, 503, "overload is retryable, not an internal error");
    assert.ok(Number(probe.headers.get("retry-after")) >= 1, "Retry-After is present");
    const body = await probe.json();
    assert.match(body.error ?? "", /busy/i);
  } finally {
    srv.child.kill();
  }
});

test("Ask saturation answers 503 with Retry-After (#2-r23, hermetic via #3-r24)", async () => {
  const port = PORT + 116;
  // #3(r24): BQAA_FAKE_CA=slow holds each Ask slot ~1.5s WITHOUT touching
  // ADC or googleapis — the test is deterministic with no credentials at all
  const srv = startServer(
    { ...FAKE_ENV, BQAA_FAKE_BQ: "ok", BQAA_FAKE_CA: "slow", GOOGLE_APPLICATION_CREDENTIALS: "/nonexistent/creds.json" },
    port,
  );
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const ask = () =>
      fetch(`http://localhost:${port}/api/ask`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ question: "Which tool fails most?" }),
      });
    const three = [ask(), ask(), ask()];
    await new Promise((r) => setTimeout(r, 150));
    const fourth = await ask();
    assert.equal(fourth.status, 503, "the fourth concurrent Ask is retryable overload");
    assert.ok(Number(fourth.headers.get("retry-after")) >= 1, "Retry-After present");
    const body = await fourth.json();
    assert.match(body.error ?? "", /busy/i);
    await Promise.all(three);
  } finally {
    srv.child.kill();
  }
});

test("only the app tool claims rendering; data-only metrics stay neutral (#3-r23)", async () => {
  const dash = await rpc(BASE, "tools/call", { name: "show_agent_dashboard", arguments: { time_range_hours: 24 } });
  assert.match(dash.body.result.content[0].text, /will render the interactive dashboard/);
  const data = await rpc(BASE, "tools/call", { name: "query_agent_metrics", arguments: { time_range_hours: 24 } });
  assert.ok(
    !/will render/.test(data.body.result.content[0].text),
    "a data-only tool must not promise a rendered dashboard",
  );
});

test("public binds do not trust loopback origins (#2-r24)", async () => {
  const port = PORT + 117;
  const srv = startServer(
    { ...FAKE_ENV, BQAA_FAKE_BQ: "ok", BQAA_HOST: "0.0.0.0", BQAA_ALLOWED_ORIGINS: "https://ok.example" },
    port,
  );
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const loopback = await fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`, {
      headers: { Origin: "http://localhost:7777" },
    });
    assert.equal(loopback.status, 403, "a publicly bound server must not trust forged loopback origins");
    const allowed = await fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`, {
      headers: { Origin: "https://ok.example" },
    });
    assert.equal(allowed.status, 200, "the allowlist still works");
  } finally {
    srv.child.kill();
  }
});

test("loopback binds keep the local-development exemption (#2-r24)", async () => {
  // BASE binds 127.0.0.1 — localhost origins stay trusted for local dev
  const res = await fetch(`${BASE}/api/dashboard?time_range_hours=24`, {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(res.status, 200);
});

test("model breakdown truncation is measured and published (#4-r24)", async () => {
  const res = await fetch(`${BASE}/api/dashboard?time_range_hours=24`);
  const { data } = await res.json();
  assert.equal(typeof data.models_truncated, "boolean", "every consumer sees the flag");
  assert.equal(data.models_truncated, false, "the small fake model list is complete");
});

test("a refresh queues behind mixed widget traffic — no failed panels (#1-r21)", async () => {
  const port = PORT + 114;
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "slow_create_all", BQAA_QUERY_TIMEOUT_MS: "8000" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    // the exact round-21 repro: ten slow weight-1 widgets occupy half the
    // pool, then a dashboard needs 11 permits — it must WAIT and succeed,
    // never start a partial fan-out that fails arbitrary sections
    const widgets = Promise.all(
      Array.from({ length: 10 }, () =>
        fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent`).then((r) => r.json()),
      ),
    );
    await new Promise((r) => setTimeout(r, 150)); // widgets hold their slots
    const dash = await fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`).then((r) => r.json());
    const errs = Object.values(dash.data?.meta?.section_errors ?? {});
    assert.ok(!errs.some((e) => /busy/i.test(e)), `refresh must queue, not fail panels: ${errs.join("; ")}`);
    const widgetBodies = await widgets;
    assert.ok(widgetBodies.every((w) => w.data), "every widget completes too");
  } finally {
    srv.child.kill();
  }
});

test("malformed JSON keeps the API error contract (#19)", async () => {
  const res = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{not json",
  });
  assert.equal(res.status, 400);
  const body = await res.json();
  assert.match(body.error, /Malformed JSON/);
});

test("ask_data accepts scope arguments (#5)", async () => {
  const call = await rpc(BASE, "tools/call", {
    name: "ask_data",
    arguments: { question: "Which tool fails most?", time_range_hours: 24, agent: "coder" },
  });
  assert.ok(call.body.result.structuredContent?.data?.answer);
});

// ---- fifth-review merge gate

test("a job created after the deadline is cancelled and never polled (#1-r5)", async () => {
  const port = PORT + 111;
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "slow_create", BQAA_QUERY_TIMEOUT_MS: "600" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const res = await fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`);
    const { data } = await res.json();
    assert.match(data.meta.section_errors?.overview ?? "", /timed out/);
    await new Promise((r) => setTimeout(r, 1600)); // let the late creation land
    assert.match(srv.logs(), /FAKE_BQ_JOB_CANCELLED/, "late job must be cancelled");
    assert.ok(!srv.logs().includes("FAKE_BQ_LATE_POLL"), "late job must never be polled");
  } finally {
    srv.child.kill();
  }
});

test("widget and trace results carry provenance; production without a project fails fast (#2-r5)", async () => {
  const port = PORT + 112;
  const srv = startServer(FAKE_ENV, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const widget = await (await fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent`)).json();
    assert.match(widget.data.source ?? "", /FAKE_BQ/);
    const trace = await (await fetch(`http://localhost:${port}/api/trace?trace_id=abcd1234abcd1234`)).json();
    assert.match(trace.source ?? "", /FAKE_BQ/);
  } finally {
    srv.child.kill();
  }
  const bad = startServer({ BQAA_MOCK: "", BQAA_PROJECT: "", NODE_ENV: "production" }, PORT + 113);
  const code = await new Promise((resolve) => bad.child.on("exit", resolve));
  assert.notEqual(code, 0);
  assert.match(bad.logs(), /BQAA_PROJECT is required in production/);
});

test("normal non-mock Ask POSTs are not falsely aborted after body parsing (#3-r5)", async () => {
  const port = PORT + 114;
  const srv = startServer(FAKE_ENV, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const res = await fetch(`http://localhost:${port}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Which tool fails most?" }),
    });
    // the CA call itself may fail (fake project / missing credentials), but it
    // must never fail with the false-abort signature from req 'close'
    const body = await res.json().catch(() => ({}));
    assert.ok(!/aborted while acquiring credentials/i.test(body.error ?? ""), `false abort: ${body.error}`);
  } finally {
    srv.child.kill();
  }
});

test("MCP client disconnect cancels stalled backend work (#11-r5)", async () => {
  const port = PORT + 115;
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "stall", BQAA_QUERY_TIMEOUT_MS: "60000" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const ac = new AbortController();
    const call = fetch(`http://localhost:${port}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 1, method: "tools/call",
        params: { name: "query_agent_metrics", arguments: { time_range_hours: 24 } },
      }),
      signal: ac.signal,
    }).catch(() => null);
    await new Promise((r) => setTimeout(r, 500)); // let the stalled job start
    ac.abort();
    await call;
    await new Promise((r) => setTimeout(r, 700));
    assert.match(srv.logs(), /FAKE_BQ_JOB_CANCELLED/, "disconnect must cancel the stalled job");
  } finally {
    srv.child.kill();
  }
});

test("the Ask disable flag outranks mock mode (#12-r5)", async () => {
  const port = PORT + 116;
  const srv = startServer({ BQAA_CA_DISABLED: "1" }, port); // mock mode
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const res = await fetch(`http://localhost:${port}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Which tool fails most?" }),
    });
    assert.equal(res.status, 500);
    const body = await res.json();
    assert.match(body.error, /disabled/);
  } finally {
    srv.child.kill();
  }
});

// ---- sixth-review merge items

test("disconnect during slow creation cancels the late job and never polls it (#6-r6)", async () => {
  const port = PORT + 117;
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "slow_create", BQAA_QUERY_TIMEOUT_MS: "60000" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const ac = new AbortController();
    const req = fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`, { signal: ac.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 300)); // creations in flight
    ac.abort();
    await req;
    await new Promise((r) => setTimeout(r, 1800)); // late creations land and self-cancel
    assert.match(srv.logs(), /FAKE_BQ_JOB_CANCELLED/, "late job must be cancelled after disconnect");
    assert.ok(!srv.logs().includes("FAKE_BQ_LATE_POLL"), "a cancelled lifecycle must never poll");
  } finally {
    srv.child.kill();
  }
});

test("abandoned creations keep counting against admission (#2-r6)", async () => {
  const port = PORT + 118;
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "slow_create_all", BQAA_QUERY_TIMEOUT_MS: "500" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    // r21: saturate with twenty weight-1 widgets — each times out at 500ms
    // leaving its slow creation pending in abandoned-creation accounting
    const saturating = Promise.all(
      Array.from({ length: 20 }, () =>
        fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent`).then((r) => r.json()),
      ),
    );
    await new Promise((r) => setTimeout(r, 700)); // deadlines fired, creations still pending
    const widget = await fetch(`http://localhost:${port}/api/widget?measure=tool_calls&dimension=tool`);
    const widgetBody = await widget.json();
    assert.match(widgetBody?.data ? "" : (widgetBody.error ?? ""), /busy/i, "abandoned creations must occupy the cap");
    await saturating;
    await new Promise((r) => setTimeout(r, 1600)); // abandoned creations settle
    // in this scenario every creation is slow, so the recovery probe itself
    // times out — recovery means it is ADMITTED (timeout), no longer refused (busy)
    const after = await fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent`);
    const afterBody = await after.json();
    assert.ok(!/busy/i.test(afterBody.error ?? ""), "admission must recover once abandoned work settles");
    assert.match(afterBody.error ?? "", /timed out|abandoned/, "the recovered slot runs and hits its own deadline");
  } finally {
    srv.child.kill();
  }
});

test("an aborted dashboard pipeline is never reused by a retry (#3-r6)", async () => {
  const port = PORT + 119;
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "slow_create_all", BQAA_QUERY_TIMEOUT_MS: "5000" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const ac = new AbortController();
    const first = fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`, { signal: ac.signal }).catch(() => null);
    await new Promise((r) => setTimeout(r, 200));
    ac.abort(); // last subscriber gone → pipeline aborted and evicted
    await first;
    const retry = await fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`);
    assert.equal(retry.status, 200);
    const { data } = await retry.json();
    assert.notEqual(data.meta.cache_hit, true, "retry must get a fresh pipeline, not the aborted one");
    assert.equal(data.overview.total_events, 1000, "fresh pipeline must produce real results");
  } finally {
    srv.child.kill();
  }
});

// ---- seventh-review merge items

test("timed-out dry runs stay inside admission accounting (#2-r7)", async () => {
  const port = PORT + 120;
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "slow_dry", BQAA_QUERY_TIMEOUT_MS: "500" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    // 20 slow dry runs: all time out at 500ms while creation stays pending
    const dryRuns = Array.from({ length: 20 }, () =>
      fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent&dry_run=true`).then((r) => r.json()),
    );
    await new Promise((r) => setTimeout(r, 700)); // deadlines fired, creations pending
    const probe = await (await fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent`)).json();
    assert.match(probe.error ?? "", /busy/i, "request 21 must be refused while abandoned dry runs count");
    await Promise.all(dryRuns);
    await new Promise((r) => setTimeout(r, 1200)); // abandoned creations settle
    const after = await fetch(`http://localhost:${port}/api/widget?measure=events&dimension=agent`);
    assert.equal(after.status, 200, "admission must recover after dry-run creations settle");
  } finally {
    srv.child.kill();
  }
});

test("mock Ask is scope-consistent with explicit provenance (#7-r7)", async () => {
  const res = await fetch(`${BASE}/api/ask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ question: "Which tool fails most?", time_range_hours: 24, agent: "coder" }),
  });
  const { data } = await res.json();
  assert.match(data.sql, /timestamp BETWEEN '/, "sample SQL must carry the actual window");
  assert.match(data.sql, /agent = 'coder'/, "sample SQL must carry the agent scope");
  assert.ok(!/INTERVAL 30 DAY/.test(data.sql), "fixed 30-day sample SQL must be gone when scoped");
  assert.equal(data.scope?.verified, true);
  assert.match(data.answer, /mock data/i, "sample provenance must be explicit");
});

// ---- eighth-review merge items

test("mock Ask values are scope-derived — disjoint scopes differ (#6-r8)", async () => {
  const askWith = async (body) => {
    const res = await fetch(`${BASE}/api/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question: "Which tool fails most?", ...body }),
    });
    return (await res.json()).data;
  };
  const a = await askWith({ time_range_hours: 24, agent: "coder" });
  const b = await askWith({ time_range_hours: 720 });
  assert.notDeepEqual(a.rows, b.rows, "disjoint scopes must not return byte-identical sample rows");
  assert.match(a.sql, /agent = 'coder'/);
  assert.equal(a.scope?.verified, true);
});

test("a disconnected coalesced caller releases while the survivor completes (#4-r8)", async () => {
  const port = PORT + 121;
  const srv = startServer({ ...FAKE_ENV, BQAA_FAKE_BQ: "slow_create_all", BQAA_QUERY_TIMEOUT_MS: "5000" }, port);
  try {
    await waitFor(`http://localhost:${port}/healthz`);
    const ac = new AbortController();
    const doomed = fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`, { signal: ac.signal }).catch(() => "aborted");
    const survivor = fetch(`http://localhost:${port}/api/dashboard?time_range_hours=24`).then((r) => r.json());
    await new Promise((r) => setTimeout(r, 300));
    ac.abort(); // NOT the last subscriber — shared work must survive
    assert.equal(await doomed, "aborted");
    const { data } = await survivor;
    assert.equal(data.overview.total_events, 1000, "the surviving subscriber must still get real results");
  } finally {
    srv.child.kill();
  }
});

// ---- trace explorer: list_traces is the tab's data source

test("list_traces returns summary rows consistent with trace drill-downs", async () => {
  const call = await rpc(BASE, "tools/call", { name: "list_traces", arguments: { time_range_hours: 720 } });
  const rows = call.body.result.structuredContent?.data;
  assert.ok(Array.isArray(rows) && rows.length > 0);
  for (const r of rows) {
    assert.equal(typeof r.trace_id, "string");
    assert.equal(typeof r.events, "number");
    assert.equal(typeof r.error_events, "number");
    assert.equal(typeof r.duration_ms, "number");
  }
  // errors_only keeps exactly the traces with errors
  const errs = await rpc(BASE, "tools/call", { name: "list_traces", arguments: { time_range_hours: 720, errors_only: true } });
  const errRows = errs.body.result.structuredContent?.data;
  assert.ok(errRows.length > 0 && errRows.length < rows.length, "errors_only must narrow the list");
  assert.ok(errRows.every((r) => r.error_events > 0));
  // each listed trace round-trips: get_trace shows the SAME error count
  const first = errRows[0];
  const trace = await rpc(BASE, "tools/call", { name: "get_trace", arguments: { trace_id: first.trace_id, time_range_hours: 720 } });
  const events = trace.body.result.structuredContent?.data?.events;
  const errCount = events.filter((e) => e.status === "ERROR" || e.event_type.endsWith("_ERROR") || e.error_message != null).length;
  assert.equal(errCount, first.error_events, "list and drill-down must agree");
});

test("GET /api/traces mirrors the tool", async () => {
  const res = await fetch(`${BASE}/api/traces?time_range_hours=720&errors_only=1`);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body.data) && body.data.every((r) => r.error_events > 0));
  assert.ok(body.source, "payload carries provenance");
});

// ---- render_trace: the waterfall is model-invokable

test("every tool declares read-only annotations so hosts can skip confirmation", async () => {
  const tools = await rpc(BASE, "tools/list", {});
  const list = tools.body.result.tools;
  assert.equal(list.length, 9);
  for (const t of list) {
    assert.equal(t.annotations?.readOnlyHint, true, `${t.name} must be marked read-only`);
    assert.equal(t.annotations?.destructiveHint, false, `${t.name} must be marked non-destructive`);
  }
});

test("render_trace carries UI metadata and a renderable trace payload", async () => {
  const tools = await rpc(BASE, "tools/list", {});
  const rt = tools.body.result.tools.find((t) => t.name === "render_trace");
  assert.equal(rt?._meta?.ui?.resourceUri, "ui://bqaa/dashboard.html", "render_trace must declare the app UI");
  const call = await rpc(BASE, "tools/call", {
    name: "render_trace",
    arguments: { trace_id: "abcd1234abcd1234" },
  });
  const d = call.body.result.structuredContent?.data;
  assert.equal(d?.trace_id, "abcd1234abcd1234", "payload must identify the trace for the UI");
  assert.ok(Array.isArray(d?.events) && d.events.length > 0);
  assert.equal(typeof d?.truncated, "boolean");
  assert.match(call.body.result.content[0].text, /Compatible MCP App hosts will render the waterfall/);
});

test("render_trace payload carries the requested window so the UI adopts it (#1-r9)", async () => {
  const call = await rpc(BASE, "tools/call", {
    name: "render_trace",
    arguments: { trace_id: "abcd1234abcd1234", time_range_hours: 72 },
  });
  const d = call.body.result.structuredContent?.data;
  assert.equal(d?.time_range_hours, 72, "non-default window must ride along with the trace");
  const dflt = await rpc(BASE, "tools/call", {
    name: "render_trace",
    arguments: { trace_id: "abcd1234abcd1234" },
  });
  assert.equal(typeof dflt.body.result.structuredContent?.data?.time_range_hours, "number", "default window is explicit, not implied");
});
