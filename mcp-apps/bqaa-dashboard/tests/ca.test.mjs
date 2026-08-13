// CA bridge unit tests: response parsing and exact scope literals (#18-r5).
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseMessages, sqlStringLiteral } from "../src/ca.js";

test("sqlStringLiteral preserves exact values with quotes/newlines/backslashes", () => {
  assert.equal(sqlStringLiteral("billing-agent"), "'billing-agent'");
  assert.equal(sqlStringLiteral("O'Brien's agent"), "'O\\'Brien\\'s agent'");
  assert.equal(sqlStringLiteral("a\\b"), "'a\\\\b'");
  assert.equal(sqlStringLiteral("line1\nline2"), "'line1\\nline2'");
});

test("parseMessages folds the CA stream into one result", () => {
  const stream = [
    { systemMessage: { text: { parts: ["Analyzing context"], textType: "THOUGHT" } } },
    { systemMessage: { data: { generatedSql: "SELECT tool, COUNT(*) FROM t GROUP BY tool" } } },
    {
      systemMessage: {
        data: {
          result: {
            schema: { fields: [{ name: "tool" }, { name: "n" }] },
            data: [{ tool: "fetch_invoice", n: 196 }],
          },
        },
      },
    },
    { systemMessage: { text: { parts: ["**fetch_invoice** fails most."], textType: "FINAL_RESPONSE" } } },
    { systemMessage: { text: { parts: ["What about latency?"], textType: "FOLLOWUP_QUESTIONS" } } },
  ];
  const r = parseMessages("Which tool fails most?", stream);
  assert.match(r.answer, /fetch_invoice/);
  assert.equal(r.steps.length, 1);
  assert.match(r.sql, /GROUP BY tool/);
  assert.deepEqual(r.schema, ["tool", "n"]);
  assert.equal(r.rows.length, 1);
  assert.deepEqual(r.followups, ["What about latency?"]);
});

// ---- sixth-review: scope contract and pre-abort semantics

import { askConversational, buildScopeInstruction } from "../src/ca.js";

test("the Ask scope instruction is mandatory, not advisory (#4-r6)", () => {
  const scope = { startIso: "2026-08-05T00:00:00Z", endIso: "2026-08-06T00:00:00Z", agent: "billing-agent" };
  const instruction = buildScopeInstruction(scope);
  assert.match(instruction, /MANDATORY/);
  assert.match(instruction, /MUST include/);
  assert.ok(!/unless the user explicitly asks otherwise/.test(instruction), "scope must not be overridable");
  assert.match(instruction, /answer within this scope/);
  assert.match(instruction, /'billing-agent'/);
  assert.equal(buildScopeInstruction(undefined), "");
});

test("a pre-aborted Ask rejects synchronously, before credentials (#8-r6)", async () => {
  const ac = new AbortController();
  ac.abort();
  const started = Date.now();
  await assert.rejects(
    () =>
      askConversational(
        { project: "p", dataset: "d", table: "t" },
        "Which tool fails most?",
        [],
        ac.signal,
      ),
    /aborted before start/,
  );
  assert.ok(Date.now() - started < 200, "pre-aborted Ask must fail fast, not acquire credentials");
});

// ---- seventh-review: scope verification is earned, never assumed

import { verifyScope, withScope } from "../src/ca.js";

test("verifyScope confirms predicates in generated SQL or reports false (#3-r7)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z", agent: "billing-agent" };
  const good = "SELECT 1 FROM t WHERE timestamp BETWEEN '2026-08-06T00:00:00Z' AND '2026-08-07T00:00:00Z' AND agent = 'billing-agent'";
  assert.equal(verifyScope(good, scope), true);
  assert.equal(verifyScope("SELECT COUNT(*) FROM t", scope), false, "unscoped SQL must not verify");
  assert.equal(verifyScope(null, scope), false, "missing SQL cannot verify");
  assert.equal(verifyScope(good.replace("billing-agent", "other"), scope), false, "wrong agent must not verify");
  assert.equal(verifyScope(null, undefined), true, "no scope → nothing to verify");
});

test("withScope reports verified truthfully and annotates unverified answers (#3-r7)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z" };
  const base = { question: "q", answer: "42", steps: [], sql: "SELECT 1", schema: [], rows: [], followups: [] };
  const unverified = withScope(base, scope);
  assert.equal(unverified.scope?.verified, false);
  assert.match(unverified.answer, /Scope not verified/);
  const verified = withScope(
    { ...base, sql: `SELECT 1 FROM t WHERE timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'` },
    scope,
  );
  assert.equal(verified.scope?.verified, true);
  assert.ok(!/Scope not verified/.test(verified.answer));
});

// ---- eighth-review: multi-query provenance and structural validation

test("multi-query streams keep SQL/result pairs together and fail closed (#1-r8)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z" };
  const scopedSql = `SELECT 1 FROM t WHERE timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'`;
  // rows come from an UNSCOPED first query; a later scoped query has no rows
  const stream = [
    { systemMessage: { data: { generatedSql: "SELECT COUNT(*) FROM t" } } },
    { systemMessage: { data: { result: { schema: { fields: [{ name: "n" }] }, data: [{ n: 100004 }] } } } },
    { systemMessage: { data: { generatedSql: scopedSql } } },
    { systemMessage: { text: { parts: ["answer"], textType: "FINAL_RESPONSE" } } },
  ];
  const r = withScope(parseMessages("q", stream), scope);
  assert.equal(r.sql, "SELECT COUNT(*) FROM t", "displayed SQL must be the one that produced the rows");
  assert.equal(r.rows[0].n, 100004);
  assert.equal(r.scope?.verified, false, "an unscoped data-bearing query must poison verification");
  assert.equal(r.queries?.length, 2);
});

test("a result with no owning SQL is ambiguous and fails closed (#1-r8)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z" };
  const stream = [
    { systemMessage: { data: { result: { schema: { fields: [{ name: "n" }] }, data: [{ n: 1 }] } } } },
    { systemMessage: { text: { parts: ["answer"], textType: "FINAL_RESPONSE" } } },
  ];
  const r = withScope(parseMessages("q", stream), scope);
  assert.equal(r.scope?.verified, false);
});

test("every data-bearing query must verify — all scoped passes (#1-r8)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z" };
  const scopedSql = (n) => `SELECT ${n} FROM t WHERE timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'`;
  const stream = [
    { systemMessage: { data: { generatedSql: scopedSql(1) } } },
    { systemMessage: { data: { result: { schema: { fields: [{ name: "a" }] }, data: [{ a: 1 }] } } } },
    { systemMessage: { data: { generatedSql: scopedSql(2) } } },
    { systemMessage: { data: { result: { schema: { fields: [{ name: "b" }] }, data: [{ b: 2 }] } } } },
  ];
  const r = withScope(parseMessages("q", stream), scope);
  assert.equal(r.scope?.verified, true);
  assert.match(r.sql, /SELECT 2/, "display pair is the last data-bearing query");
});

test("structural validation rejects lookalike text (#2-r8)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z", agent: "billing" };
  const good = `SELECT 1 FROM t WHERE timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}' AND agent = 'billing'`;
  assert.equal(verifyScope(good, scope), true);
  // prefix-matched agent must fail
  assert.equal(verifyScope(good.replace("'billing'", "'billing-old'"), scope), false);
  // predicates only in comments must fail
  const comment = `SELECT 1 FROM t -- timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}' agent = 'billing'`;
  assert.equal(verifyScope(comment, scope), false);
  // projected literal without an agent predicate must fail
  const projected = `SELECT 'billing' AS x FROM t WHERE timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'`;
  assert.equal(verifyScope(projected, scope), false);
  // an extra predicate on a DIFFERENT agent must fail even if the right one exists
  assert.equal(verifyScope(`${good} OR agent = 'other'`, scope), false);
  // TIMESTAMP() wrapper is accepted
  const wrapped = `SELECT 1 FROM t WHERE timestamp BETWEEN TIMESTAMP('${scope.startIso}') AND TIMESTAMP('${scope.endIso}') AND agent = 'billing'`;
  assert.equal(verifyScope(wrapped, scope), true);
});

test("fail-closed grammar rejects OR/UNION/multi-statement/quoting tricks (#2-r9)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z", agent: "billing" };
  const good = `SELECT 1 FROM t WHERE timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}' AND agent = 'billing'`;
  assert.equal(verifyScope(good, scope), true);
  // OR TRUE nullifies every predicate — grammar must reject any top-level OR
  assert.equal(verifyScope(`${good} OR TRUE`, scope), false);
  // UNION smuggles an unscoped branch
  assert.equal(verifyScope(`${good} UNION ALL SELECT 1 FROM t`, scope), false);
  // second statement after ; is unverifiable
  assert.equal(verifyScope(`${good}; SELECT 2 FROM t`, scope), false);
  // triple-quoted strings defeat the literal tokenizer — fail closed
  const tq = "'''";
  assert.equal(verifyScope(`SELECT ${tq}x${tq} FROM t WHERE timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}' AND agent = 'billing'`, scope), false);
  // negated agent forms must fail even with the equality present
  assert.equal(verifyScope(`${good} AND agent != 'other'`, scope), false);
  assert.equal(verifyScope(`${good} AND agent NOT IN ('other')`, scope), false);
  // BETWEEN literals must exactly equal the scope window
  assert.equal(verifyScope(good.replace(scope.endIso, "2026-08-08T00:00:00Z"), scope), false);
});

test("groupId pairs SQL with its own result in interleaved streams (#5-r9)", () => {
  const stream = [
    { systemMessage: { groupId: "g1", data: { generatedSql: "SELECT a" } } },
    { systemMessage: { groupId: "g2", data: { generatedSql: "SELECT b" } } },
    // results arrive out of order — g2's rows first
    { systemMessage: { groupId: "g2", data: { result: { schema: { fields: [{ name: "x" }] }, data: [{ x: 2 }] } } } },
    { systemMessage: { groupId: "g1", data: { result: { schema: { fields: [{ name: "x" }] }, data: [{ x: 1 }] } } } },
    { systemMessage: { text: { parts: ["done"], textType: "FINAL_RESPONSE" } } },
  ];
  const r = parseMessages("q", stream);
  // arrival-order pairing would attach x:2 to "SELECT b" and orphan x:1 into a
  // third sql:null pair; groupId pairing keeps exactly two owned pairs
  assert.deepEqual(
    r.queries.map((q) => [q.sql, q.data_bearing]),
    [["SELECT a", true], ["SELECT b", true]],
    "each result found its own SQL despite out-of-order arrival",
  );
  assert.equal(r.sql, "SELECT b", "display pair is the last data-bearing query");
  assert.equal(r.rows[0].x, 2, "display rows come from that same pair");
});

test("a result without any owning group fails closed as sql:null (#5-r9)", () => {
  const stream = [
    { systemMessage: { groupId: "ghost", data: { result: { schema: { fields: [{ name: "x" }] }, data: [{ x: 9 }] } } } },
    { systemMessage: { text: { parts: ["ans"], textType: "FINAL_RESPONSE" } } },
  ];
  const r = parseMessages("q", stream);
  assert.equal(r.queries.length, 1);
  assert.equal(r.queries[0].sql, null, "orphan result has no provable SQL");
  const scoped = withScope(r, { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z" });
  assert.equal(scoped.scope.verified, false, "unowned data can never verify");
});

// ---- tenth-review: dominating-predicate grammar, sticky ambiguity

test("grammar rejects every reproduced round-10 bypass (#1-r10)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z", agent: "billing" };
  const conj = `timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}' AND agent = 'billing'`;
  assert.equal(verifyScope(`SELECT 1 FROM t WHERE ${conj}`, scope), true, "baseline still verifies");
  // negated predicates
  assert.equal(verifyScope(`SELECT 1 FROM t WHERE NOT (${conj})`, scope), false, "NOT-wrapped scope");
  assert.equal(verifyScope(`SELECT 1 FROM t WHERE (${conj}) IS FALSE`, scope), false, "(pred) IS FALSE");
  // predicate only in the SELECT list
  assert.equal(verifyScope(`SELECT ${conj} AS in_scope FROM t`, scope), false, "projection-only predicate");
  // scoped scan hidden in an unused CTE while the real scan is unscoped
  assert.equal(
    verifyScope(`WITH unused AS (SELECT 1 FROM t WHERE ${conj}) SELECT COUNT(*) FROM t`, scope),
    false,
    "unused scoped CTE beside an unscoped scan",
  );
  // predicate only inside an EXISTS subquery
  assert.equal(
    verifyScope(`SELECT 1 FROM t WHERE EXISTS (SELECT 1 FROM t WHERE ${conj})`, scope),
    false,
    "EXISTS is not provably constraining",
  );
  // joins and comma-joins are unprovable
  assert.equal(verifyScope(`SELECT 1 FROM t JOIN u ON t.id = u.id WHERE ${conj}`, scope), false, "JOIN");
  assert.equal(verifyScope(`SELECT 1 FROM t, u WHERE ${conj}`, scope), false, "comma join");
  // set operations beyond UNION
  assert.equal(verifyScope(`SELECT 1 FROM t WHERE ${conj} INTERSECT DISTINCT SELECT 1 FROM t`, scope), false);
  // an unscoped second scan in a derived table
  assert.equal(
    verifyScope(`SELECT 1 FROM (SELECT * FROM t) WHERE ${conj}`, scope),
    false,
    "derived-table scan has no WHERE of its own",
  );
  // no table scan at all cannot certify a scope
  assert.equal(verifyScope("SELECT 1", scope), false, "scanless query");
});

test("grammar accepts scoped scans inside CTE bodies (#1-r10)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z", agent: "billing" };
  const conj = `timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}' AND agent = 'billing'`;
  const cte = `WITH stats AS (SELECT agent, COUNT(*) AS n FROM \`p.d.agent_events\` WHERE ${conj} GROUP BY agent) SELECT * FROM stats ORDER BY n DESC`;
  assert.equal(verifyScope(cte, scope), true, "the real CA shape: scoped scan in a CTE, outer query over the CTE");
  assert.equal(verifyScope("SELECT error_message FROM t WHERE " + conj + " AND error_message IS NOT NULL", scope), true, "IS NOT NULL stays legal");
});

test("agent names containing comment delimiters verify correctly (#5-r10)", () => {
  const mk = (agent) => ({ startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z", agent });
  for (const agent of ["billing--prod", "billing/*prod*/"]) {
    const scope = mk(agent);
    const sql = `SELECT 1 FROM t WHERE timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}' AND agent = '${agent}'`;
    assert.equal(verifyScope(sql, scope), true, `${agent} must survive comment stripping`);
  }
});

test("group ambiguity is sticky - a third SQL cannot restore trust (#4-r10)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z" };
  const scoped = `SELECT 1 FROM t WHERE timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'`;
  const stream = [
    { systemMessage: { groupId: "g", data: { generatedSql: scoped } } },
    { systemMessage: { groupId: "g", data: { generatedSql: scoped } } }, // ambiguity
    { systemMessage: { groupId: "g", data: { generatedSql: scoped } } }, // must NOT restore trust
    { systemMessage: { groupId: "g", data: { result: { schema: { fields: [{ name: "x" }] }, data: [{ x: 1 }] } } } },
  ];
  const r = withScope(parseMessages("q", stream), scope);
  assert.equal(r.scope?.verified, false, "a multi-SQL group stays unprovable forever");
  // and a LATER cycle in the same poisoned group is also untrusted
  const later = [
    ...stream,
    { systemMessage: { groupId: "g", data: { generatedSql: scoped } } },
    { systemMessage: { groupId: "g", data: { result: { schema: { fields: [{ name: "y" }] }, data: [{ y: 2 }] } } } },
  ];
  const r2 = withScope(parseMessages("q", later), scope);
  assert.equal(r2.scope?.verified, false, "poisoning survives result boundaries");
});

// ---- eleventh-review: lexer boundary, table binding, gid-less ambiguity

test("comment quotes cannot hide widening SQL from the lexer (#3-r11)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z" };
  const conj = `timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'`;
  // two line comments each containing a quote: a regex pass that tokenizes
  // literals first would swallow the active OR TRUE between them
  const hidden = `SELECT 1 FROM t WHERE ${conj} -- x'\nOR TRUE -- '\n`;
  assert.equal(verifyScope(hidden, scope), false, "OR TRUE between comment quotes must stay visible");
  // a quote inside a comment must not unbalance an otherwise good query
  const benign = `SELECT 1 FROM t WHERE ${conj} -- O'Brien wrote this\n`;
  assert.equal(verifyScope(benign, scope), true, "comment content is ignored, not lexed as SQL");
});

test("certification binds to the configured table (#2-r11)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z" };
  const conj = `timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'`;
  const table = "proj.data.agent_events";
  assert.equal(verifyScope(`SELECT 1 FROM \`proj.data.agent_events\` WHERE ${conj}`, scope, table), true);
  assert.equal(verifyScope(`SELECT 1 FROM agent_events WHERE ${conj}`, scope, table), true, "short spelling of the same table");
  assert.equal(
    verifyScope(`SELECT 1 FROM \`proj.data.other_table\` WHERE ${conj}`, scope, table),
    false,
    "an unconfigured table can never certify the scope",
  );
});

test("scan predicates must belong to the scan, and FROM tails are closed (#2-r11)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z", agent: "billing" };
  const conj = `timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}' AND agent = 'billing'`;
  // predicates qualified by something other than the scan's alias are structs
  const struct = `SELECT 1 FROM t WHERE s.timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}' AND s.agent = 'billing'`;
  assert.equal(verifyScope(struct, scope), false, "a foreign qualifier cannot constrain this scan");
  const aliased = `SELECT 1 FROM t AS ev WHERE ev.timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}' AND ev.agent = 'billing'`;
  assert.equal(verifyScope(aliased, scope), true, "the scan's own alias binds");
  // TABLESAMPLE (and anything else between the table and WHERE) is unprovable
  assert.equal(verifyScope(`SELECT 1 FROM t TABLESAMPLE SYSTEM (10 PERCENT) WHERE ${conj}`, scope), false);
  assert.equal(verifyScope(`SELECT 1 FROM t x, u WHERE ${conj}`, scope), false, "aliased comma join");
});

test("gid-less retries make later pairings permanently ambiguous (#1-r11)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z" };
  const scoped = `SELECT 2 FROM t WHERE timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'`;
  // unscoped SQL, then a scoped retry, THEN rows: the rows could belong to
  // either statement, so nothing may certify
  const stream = [
    { systemMessage: { data: { generatedSql: "SELECT 1 FROM t" } } },
    { systemMessage: { data: { generatedSql: scoped } } },
    { systemMessage: { data: { result: { schema: { fields: [{ name: "x" }] }, data: [{ x: 1 }] } } } },
    { systemMessage: { text: { parts: ["ans"], textType: "FINAL_RESPONSE" } } },
  ];
  const r = withScope(parseMessages("q", stream), scope);
  assert.equal(r.scope?.verified, false, "ambiguous ownership can never verify");
  assert.equal(r.sql, null, "no SQL may be presented beside rows it may not own");
});

// ---- twelfth-review: '#' comments and expression field access

test("'#' comments cannot hide widening SQL (#1-r12)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z", agent: "billing" };
  // the exact published repro: '#' tails hide OR TRUE from a two-pass lexer
  const hidden =
    `SELECT 1 FROM t WHERE timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'\n` +
    `  AND agent = 'billing' # '\nOR TRUE # '\n`;
  assert.equal(verifyScope(hidden, scope), false, "BigQuery executes the OR TRUE — we must see it");
  // and a benign '#' comment does not unbalance a good query
  const benign = `SELECT 1 FROM t WHERE timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}' AND agent = 'billing' # note's\n`;
  assert.equal(verifyScope(benign, scope), true);
});

test("parenthesized STRUCT field access never certifies (#2-r12)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z", agent: "billing" };
  // the exact published repro: both predicates are CONSTANTS over struct
  // fields named timestamp/agent — they constrain nothing
  const struct =
    "SELECT * FROM `proj.data.agent_events`\n" +
    `WHERE (STRUCT(TIMESTAMP('${scope.startIso}') AS timestamp)).timestamp\n` +
    `      BETWEEN '${scope.startIso}' AND '${scope.endIso}'\n` +
    `  AND (STRUCT('billing' AS agent)).agent = 'billing'`;
  assert.equal(verifyScope(struct, scope, "proj.data.agent_events"), false);
});

// ---- fourteenth-review: conjuncts must be complete expressions

test("widening expression suffixes never verify (#1-r14)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z", agent: "billing" };
  const good = `SELECT 1 FROM t WHERE timestamp BETWEEN TIMESTAMP('${scope.startIso}') AND TIMESTAMP('${scope.endIso}') AND agent = 'billing'`;
  assert.equal(verifyScope(good, scope), true, "the anchored form still verifies");
  // the exact published repros: BigQuery-valid SQL whose conjuncts CONTAIN
  // the required literals but evaluate wider
  const widerTime = good.replace(
    `TIMESTAMP('${scope.endIso}') AND agent`,
    `TIMESTAMP('${scope.endIso}') + INTERVAL 1 DAY AND agent`,
  );
  assert.equal(verifyScope(widerTime, scope), false, "+ INTERVAL widens the window");
  const widerAgent = `${good} || SUBSTR(agent, 8)`;
  assert.equal(verifyScope(widerAgent, scope), false, "|| concatenation widens the agent");
  // arithmetic BEFORE the column is not this conjunct either
  const prefixed = `SELECT 1 FROM t WHERE 1 + timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}' AND agent = 'billing'`;
  assert.equal(verifyScope(prefixed, scope), false, "left-side arithmetic is not the raw column");
});

// ---- fifteenth-review: declaration-ordered CTE visibility

test("a self-shadowing CTE cannot hide an unscoped base scan (#1-r15)", () => {
  const scope = { startIso: "2026-08-06T00:00:00Z", endIso: "2026-08-07T00:00:00Z" };
  const conj = `timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'`;
  const table = "proj.data.agent_events";
  // the exact reviewed bypass: the CTE named after the table scans the RAW
  // table (its own name is not visible to its body in non-recursive
  // GoogleSQL), unscoped, while a scoped decoy scan certifies the text
  const shadow =
    `WITH agent_events AS (SELECT * FROM agent_events), ` +
    `decoy AS (SELECT 1 AS n FROM agent_events WHERE ${conj}) ` +
    `SELECT COUNT(*) AS leaked_n FROM agent_events`;
  assert.equal(verifyScope(shadow, scope, table), false, "the shadowed body's scan is unscoped");
  // declaration order is respected: a later CTE referencing an EARLIER one
  // is a CTE reference, and the single base scan carries the scope
  const ordered =
    `WITH base AS (SELECT * FROM agent_events WHERE ${conj}), ` +
    `agg AS (SELECT COUNT(*) AS n FROM base) SELECT * FROM agg`;
  assert.equal(verifyScope(ordered, scope, table), true);
  // an EARLIER CTE referencing a LATER name is a raw base-table scan — with
  // a bound table config, an unknown name fails outright
  const forward =
    `WITH agg AS (SELECT COUNT(*) AS n FROM base), ` +
    `base AS (SELECT * FROM agent_events WHERE ${conj}) SELECT * FROM agg`;
  assert.equal(verifyScope(forward, scope, table), false, "forward references are not CTE references");
  // recursive CTEs have visibility this grammar does not model — fail closed
  assert.equal(
    verifyScope(`WITH RECURSIVE r AS (SELECT 1 FROM t WHERE ${conj}) SELECT * FROM r`, scope),
    false,
  );
});
