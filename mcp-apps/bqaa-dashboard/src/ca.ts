// BigQuery Conversational Analytics (Gemini Data Analytics API) bridge.
// Server-side only — the webapp's Ask tab and the ask_data MCP tool both go
// through askConversational(), so the conversation layer needs no MCP host.
//
// Requires: geminidataanalytics.googleapis.com enabled and the caller identity
// holding roles/geminidataanalytics.dataAgentStatelessUser plus BigQuery read.

import { GoogleAuth } from "google-auth-library";
import type { AskExchange, AskResult } from "./types.js";

const MAX_ROWS = 100;

import { sqlStringLiteral } from "./sqltext.js"; // shared with the mock layer (#9-r9)
export { sqlStringLiteral };

// #4: the requested scope is NON-OVERRIDABLE — the UI labels answers with
// this scope, so the analysis must never silently escape it. Questions that
// ask beyond the scope are answered within it, with the restriction stated.
export function buildScopeInstruction(scope?: { startIso: string; endIso: string; agent?: string }): string {
  if (!scope) return "";
  return (
    ` SCOPE (MANDATORY): every SQL query you run MUST include the predicate` +
    ` timestamp BETWEEN '${scope.startIso}' AND '${scope.endIso}'` +
    (scope.agent ? ` AND agent = ${sqlStringLiteral(scope.agent)}` : "") +
    `. This applies even if the question asks for other ranges, agents, or the whole table —` +
    ` in that case answer within this scope and state that the analysis was restricted to it.`
  );
}

let auth: GoogleAuth | null = null;

async function accessToken(): Promise<string> {
  auth ??= new GoogleAuth({ scopes: ["https://www.googleapis.com/auth/cloud-platform"] });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token.token) throw new Error("Could not obtain Google access token (check ADC / service account)");
  return token.token;
}

export interface CaConfig {
  project: string;
  dataset: string;
  table: string;
  location?: string; // default "global"
  // Per-QUERY byte cap on each CA-generated BigQuery query. CA may generate
  // and retry several queries per question, so this is NOT an aggregate
  // per-request budget — bound aggregate spend with project/user quotas.
  maxBilledBytes?: number;
  scope?: { startIso: string; endIso: string; agent?: string }; // active filters
}

const SYSTEM_INSTRUCTION =
  "The table contains BigQuery Agent Analytics telemetry (agent_events): one row per agent event. " +
  "event_type values include LLM_REQUEST/LLM_RESPONSE/LLM_ERROR, TOOL_STARTING/TOOL_COMPLETED/TOOL_ERROR, " +
  "HITL_* and lifecycle events. JSON columns: content ($.tool, $.response), attributes ($.model or $.model_version, " +
  "$.usage_metadata token counts), latency_ms ($.total_ms, $.time_to_first_token_ms). status is OK or ERROR. " +
  "The table is partitioned on timestamp — always constrain timestamp in queries. Answer concisely with numbers.";

export async function askConversational(
  cfg: CaConfig,
  question: string,
  history: AskExchange[] = [],
  callerSignal?: AbortSignal,
): Promise<AskResult> {
  const location = cfg.location ?? "global";
  const parent = `projects/${cfg.project}/locations/${location}`;
  const messages: unknown[] = [];
  for (const h of history.slice(-3)) {
    messages.push({ userMessage: { text: h.question.slice(0, 2000) } });
    messages.push({ systemMessage: { text: { parts: [h.answer.slice(0, 4000)] } } });
  }
  messages.push({ userMessage: { text: question.slice(0, 2000) } });

  // #20: one deadline covers the WHOLE request — including ADC token
  // acquisition, which would otherwise be able to hold Ask slots forever.
  // #8: an already-aborted signal must reject NOW, before credentials — a
  // listener alone would never fire for a pre-aborted signal.
  if (callerSignal?.aborted) throw new Error("Ask aborted before start");
  const timeout = AbortSignal.timeout(150_000);
  const signal = callerSignal ? AbortSignal.any([timeout, callerSignal]) : timeout;
  if (signal.aborted) throw new Error("Ask aborted before start");
  const token = await Promise.race([
    accessToken(),
    new Promise<never>((_, reject) => {
      const fail = (): void => reject(new Error("Ask aborted while acquiring credentials"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    }),
  ]);

  const scopeInstruction = buildScopeInstruction(cfg.scope);

  const res = await fetch(`https://geminidataanalytics.googleapis.com/v1beta/${parent}:chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      parent,
      messages,
      inlineContext: {
        systemInstruction: SYSTEM_INSTRUCTION + scopeInstruction,
        // The Ask path must honor the same cost boundary as the dashboard:
        // cap the bytes CA-generated queries may bill.
        ...(cfg.maxBilledBytes
          ? { options: { datasource: { bigQueryMaxBilledBytes: String(cfg.maxBilledBytes) } } }
          : {}),
        datasourceReferences: {
          bq: {
            tableReferences: [{ projectId: cfg.project, datasetId: cfg.dataset, tableId: cfg.table }],
          },
        },
      },
    }),
    signal,
  });

  const raw = await res.text();
  if (!res.ok) {
    let detail = raw.slice(0, 400);
    try {
      detail = JSON.parse(raw)?.error?.message ?? detail;
    } catch {
      /* keep raw slice */
    }
    throw new Error(`Conversational Analytics API ${res.status}: ${detail}`);
  }

  let parsed: any[];
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Conversational Analytics returned a non-JSON stream");
  }
  // #2(r11): certification is bound to the configured telemetry table
  return withScope(parseMessages(question, parsed), cfg.scope, `${cfg.project}.${cfg.dataset}.${cfg.table}`);
}

export function parseMessages(question: string, parsed: any[]): AskResult {
  const answers: string[] = [];
  const steps: string[] = [];
  const followups: string[] = [];
  // #1(r8): SQL/result provenance is preserved as PAIRS. CA runs several
  // queries per question; displayed rows must come from the same query as the
  // displayed SQL, and scope verification must cover every data-bearing pair.
  interface QueryPair {
    sql: string | null;
    schema: string[];
    rows: Array<Record<string, unknown>>;
    hasResult: boolean;
  }
  const pairs: QueryPair[] = [];
  let current: QueryPair | null = null; // arrival-order fallback pointer
  // #5(r9): the Message contract defines groupId for logically related
  // messages — interleaved query groups must pair by IDENTITY, never by
  // arrival order. Arrival pairing remains only for streams with no groupIds,
  // and anything ambiguous pairs as sql:null so verification fails closed.
  const byGroup = new Map<string, QueryPair>();
  // #4(r10): once a group has shown two SQL statements, ownership inside it
  // is permanently unprovable - later SQL must NOT restore trust
  const ambiguousGroups = new Set<string>();
  // #1(r11): the gid-less fallback has the same sticky rule as groups
  let gidlessAmbiguous = false;

  for (const m of parsed) {
    const sm = m?.systemMessage;
    if (!sm) continue;
    if (sm.text) {
      const parts: string[] = sm.text.parts ?? [];
      if (sm.text.textType === "FINAL_RESPONSE" || sm.text.textType == null) answers.push(parts.join(""));
      else if (sm.text.textType === "FOLLOWUP_QUESTIONS") followups.push(...parts);
      else if (sm.text.textType === "THOUGHT" && parts.length) steps.push(parts[0].slice(0, 120));
    }
    // the documented location is SystemMessage.groupId; tolerate wrapper-level
    const gidRaw = sm.groupId ?? m?.groupId;
    const gid: string | null = gidRaw != null ? String(gidRaw) : null;
    if (sm.data?.generatedSql) {
      if (gid != null) {
        let p = byGroup.get(gid);
        if (!p || p.hasResult) {
          p = { sql: null, schema: [], rows: [], hasResult: false };
          byGroup.set(gid, p);
          pairs.push(p);
        } else if (p.sql != null) {
          // a second SQL in an open group makes ownership ambiguous -
          // permanently, for the whole group (#4-r10)
          ambiguousGroups.add(gid);
          p.sql = null;
        }
        if (!ambiguousGroups.has(gid) && p.sql == null && !p.hasResult) {
          p.sql = sm.data.generatedSql;
        }
      } else {
        // #1(r11): a second gid-less SQL while one is still OPEN makes every
        // later gid-less pairing permanently unprovable — rows that arrive
        // after a retry could belong to either statement
        if (current && !current.hasResult) {
          gidlessAmbiguous = true;
          current.sql = null;
        }
        current = { sql: gidlessAmbiguous ? null : sm.data.generatedSql, schema: [], rows: [], hasResult: false };
        pairs.push(current);
      }
    }
    if (sm.data?.result) {
      let target: QueryPair;
      if (gid != null) {
        const p = byGroup.get(gid);
        if (p && !p.hasResult) {
          target = p;
        } else {
          // result with no open owning group — ambiguous, fail closed
          target = { sql: null, schema: [], rows: [], hasResult: false };
          byGroup.set(gid, target);
          pairs.push(target);
        }
      } else if (current && !current.hasResult) {
        target = current;
      } else {
        target = { sql: null, schema: [], rows: [], hasResult: false };
        pairs.push(target);
      }
      target.schema = (sm.data.result.schema?.fields ?? []).map((f: any) => f.name);
      target.rows = (sm.data.result.data ?? []).slice(0, MAX_ROWS);
      target.hasResult = true;
    }
  }

  const dataPairs = pairs.filter((p) => p.hasResult);
  const display = dataPairs.length ? dataPairs[dataPairs.length - 1] : null;
  const lastSql = [...pairs].reverse().find((p) => p.sql)?.sql ?? null;
  return {
    question,
    answer: answers.join("\n\n").trim() || "The analysis completed without a final text answer.",
    steps,
    // the displayed SQL is the one that PRODUCED the displayed rows
    sql: display ? display.sql : lastSql,
    schema: display?.schema ?? [],
    rows: display?.rows ?? [],
    followups: followups.filter(Boolean).slice(0, 3),
    queries: pairs.map((p) => ({ sql: p.sql, row_count: p.hasResult ? p.rows.length : 0, data_bearing: p.hasResult })),
  };
}

// #3(r7): the scope instruction is prompt-level, so the label must be earned:
// the generated SQL is checked for the scope's predicates, and the result
// reports verified: true only when every check passes.
// #1(r10)/#2(r11): verification is a CLOSED grammar that must prove the scope
// DOMINATES EVERY telemetry scan, not merely that predicate text exists:
//   1. ONE character-level lexer handles comments and string literals in a
//      single pass (#3-r11: two regex passes let quotes inside comments hide
//      active SQL); prefixed (r'', b''), triple-quoted, or unterminated
//      strings are unprovable
//   2. constructs that can widen, negate, or hide a scan are rejected
//      outright: OR, NOT, IS TRUE/FALSE, UNION/INTERSECT/EXCEPT, EXISTS,
//      JOIN, CASE, TABLESAMPLE, multiple statements
//   3. every base-table FROM (recursively, through CTE bodies and derived
//      tables) must reference the CONFIGURED table when one is given, be
//      followed only by an optional alias and then a known clause keyword
//      (so comma-joins and unmodeled clauses cannot hide a second scan), and
//      carry a WHERE whose top-level conjuncts include
//      `timestamp BETWEEN <start> AND <end>` and the agent equality —
//      qualified only by that scan's own alias or table name (#2-r11:
//      struct fields named timestamp/agent must not count)
// Anything the grammar cannot prove is reported as NOT verified.
const SUBEXPR = "";
const LIT_RE = "\\u0000(\\d+)\\u0000";
const CLAUSE_KEYWORDS = /^(WHERE|GROUP|HAVING|ORDER|LIMIT|WINDOW|QUALIFY)$/i;

// One pass over the raw SQL: comments become spaces, string literals become
// numbered placeholders. Returns null when the text cannot be lexed the way
// BigQuery would read it — which must always FAIL verification.
function lexSql(sql: string): { code: string; literals: string[] } | null {
  const literals: string[] = [];
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const two = sql.slice(i, i + 2);
    const c = sql[i];
    if (two === "--" || c === "#") {
      // #1(r12): GoogleSQL also treats '#' as a line comment
      while (i < n && sql[i] !== "\n") i++;
      out += " ";
    } else if (two === "/*") {
      const end = sql.indexOf("*/", i + 2);
      if (end < 0) return null; // unterminated comment
      out += " ";
      i = end + 2;
    } else if (c === "'" || c === '"') {
      if (/[A-Za-z0-9_]$/.test(out)) return null; // r'..'/b'..' prefixes change escape rules
      if (sql.slice(i, i + 3) === c + c + c) return null; // triple-quoted: unprovable
      let j = i + 1;
      let lit = "";
      let closed = false;
      while (j < n) {
        if (sql[j] === "\\") {
          lit += sql[j + 1] ?? "";
          j += 2;
        } else if (sql[j] === c) {
          closed = true;
          j++;
          break;
        } else {
          lit += sql[j];
          j++;
        }
      }
      if (!closed) return null; // unterminated string
      literals.push(lit);
      out += ` ${literals.length - 1} `;
      i = j;
    } else if (c === "`") {
      const end = sql.indexOf("`", i + 1);
      if (end < 0) return null;
      out += sql.slice(i, end + 1);
      i = end + 1;
    } else {
      out += c;
      i++;
    }
  }
  return { code: out, literals };
}

function flattenTopLevel(text: string): { flat: string; groups: string[] } {
  // Replace each top-level (...) group with a marker, EXCEPT TIMESTAMP(...)
  // wrappers, which stay inline so literal conjuncts keep their shape.
  const groups: string[] = [];
  let flat = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "(") {
      let depth = 1;
      let j = i + 1;
      while (j < text.length && depth > 0) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") depth--;
        j++;
      }
      const inner = text.slice(i + 1, j - 1);
      const before = flat.replace(/\s+$/, "");
      if (/\btimestamp$/i.test(before) && !inner.includes("(")) {
        flat += `(${inner})`; // TIMESTAMP('...') wrapper stays inline
      } else {
        groups.push(inner);
        flat += ` ${SUBEXPR}${groups.length - 1} `;
      }
      i = j;
    } else {
      flat += ch;
      i++;
    }
  }
  return { flat, groups };
}

// Does this base-table reference match the configured table? Accepts the
// full `project.dataset.table`, `dataset.table`, or bare `table` spellings.
function matchesTable(name: string, expected: string): boolean {
  const parts = expected.toLowerCase().split(".");
  const got = name.toLowerCase().split(".");
  if (got.length > parts.length) return false;
  return parts.slice(parts.length - got.length).join(".") === got.join(".");
}

function checkBlock(
  text: string,
  scope: { startIso: string; endIso: string; agent?: string },
  literals: string[],
  cteNames: Set<string>,
  seen: { scans: number },
  expectedTable?: string,
): boolean {
  const { flat, groups } = flattenTopLevel(text);
  // #1(r15): CTE visibility is DECLARATION-ORDERED, exactly like
  // non-recursive GoogleSQL — a CTE body sees only the outer names and the
  // CTEs declared BEFORE it, never itself or later ones. Collecting every
  // name up front let `WITH agent_events AS (SELECT * FROM agent_events)`
  // hide an unscoped base scan behind its own shadow.
  const cteDecls: Array<{ name: string; groupIdx: number }> = [];
  for (const m of flat.matchAll(new RegExp(`(?:\\bWITH\\b|,)\\s*([A-Za-z_]\\w*)\\s+AS\\s+${SUBEXPR}(\\d+)`, "gi"))) {
    cteDecls.push({ name: m[1].toLowerCase(), groupIdx: Number(m[2]) });
  }
  // the MAIN query (and any non-CTE subexpression at this level) sees them all
  const names = new Set(cteNames);
  for (const d of cteDecls) names.add(d.name);
  const fromRe = new RegExp(`\\bFROM\\s+(${SUBEXPR}\\d+|\`[^\`]+\`|[A-Za-z_][\\w.]*)`, "gi");
  let fm: RegExpExecArray | null;
  while ((fm = fromRe.exec(flat))) {
    const src = fm[1];
    if (src.startsWith(SUBEXPR)) continue; // derived table — verified recursively
    const name = src.replace(/`/g, "");
    if (/^UNNEST$/i.test(name)) continue; // array scan, not the table
    if (names.has(name.toLowerCase()) && !name.includes(".")) continue; // CTE reference
    seen.scans++;
    // #2(r11): only the configured telemetry table may be scanned at all
    if (expectedTable && !matchesTable(name, expectedTable)) return false;
    // parse the FROM tail as a CLOSED grammar: an optional alias, then a
    // known clause keyword or end of block — anything else (a comma join,
    // TABLESAMPLE, a second source) is unprovable
    let after = flat.slice(fm.index + fm[0].length);
    let alias: string | null = null;
    const aliasM = /^\s+(?:AS\s+)?([A-Za-z_]\w*)/i.exec(after);
    if (aliasM && !CLAUSE_KEYWORDS.test(aliasM[1])) {
      alias = aliasM[1].toLowerCase();
      after = after.slice(aliasM[0].length);
    }
    const nextTok = /^\s*(\S+)/.exec(after)?.[1];
    if (nextTok && !CLAUSE_KEYWORDS.test(nextTok)) return false; // unmodeled FROM tail
    // its clause region runs to the next top-level clause keyword
    const region = after.split(/\b(?:GROUP|HAVING|ORDER|LIMIT|WINDOW|QUALIFY)\b/i)[0];
    const whereAt = region.search(/\bWHERE\b/i);
    if (whereAt < 0) return false; // unconstrained scan
    const where = region.slice(whereAt);
    // #2(r11): a qualified column must belong to THIS scan — its alias or its
    // table name — so constant structs named timestamp/agent never count
    const ownQualifiers = new Set([alias, name.toLowerCase().split(".").pop() ?? null].filter(Boolean) as string[]);
    const qualifierOk = (q: string | undefined): boolean => q == null || ownQualifiers.has(q.toLowerCase());
    // #2(r12): the column is either qualified by an IDENTIFIER (checked
    // against this scan's alias below) or NOT preceded by a dot at all —
    // `(STRUCT(...)).timestamp` is a constant field access, not this scan's
    // column, and must never count.
    // #1(r14): each conjunct must be COMPLETE — anchored between WHERE/AND
    // and the next AND or the end of the clause. A prefix match is not a
    // proof: `TIMESTAMP(<end>) + INTERVAL 1 DAY` widens the window and
    // `'billing' || SUBSTR(agent, 8)` widens the agent, and both contain the
    // required literals as prefixes.
    const CONJ_START = `(?:\\bWHERE\\b|\\bAND\\b)\\s+`;
    const CONJ_END = `(?=\\s+AND\\b|\\s*$)`;
    const timeRe = new RegExp(
      `${CONJ_START}(?:\\b([A-Za-z_]\\w*)\\.|(?<![.\\w]))\\btimestamp\\b\\s+BETWEEN\\s+(?:TIMESTAMP\\s*\\(\\s*)?${LIT_RE}\\s*\\)?\\s+AND\\s+(?:TIMESTAMP\\s*\\(\\s*)?${LIT_RE}\\s*\\)?${CONJ_END}`,
      "i",
    );
    const tm = timeRe.exec(where);
    if (!tm || !qualifierOk(tm[1]) || literals[Number(tm[2])] !== scope.startIso || literals[Number(tm[3])] !== scope.endIso) {
      return false;
    }
    if (scope.agent) {
      const am = new RegExp(
        `${CONJ_START}(?:\\b([A-Za-z_]\\w*)\\.|(?<![.\\w]))\\bagent\\b\\s*=\\s*${LIT_RE}${CONJ_END}`,
        "i",
      ).exec(where);
      if (!am || !qualifierOk(am[1]) || literals[Number(am[2])] !== scope.agent) return false;
    }
  }
  return groups.every((g, gi) => {
    const declPos = cteDecls.findIndex((d) => d.groupIdx === gi);
    if (declPos >= 0) {
      // this group IS a CTE body: outer names + strictly earlier CTEs only
      const visible = new Set(cteNames);
      for (let j = 0; j < declPos; j++) visible.add(cteDecls[j].name);
      return checkBlock(g, scope, literals, visible, seen, expectedTable);
    }
    return checkBlock(g, scope, literals, names, seen, expectedTable);
  });
}

export function verifyScope(
  sql: string | null,
  scope?: { startIso: string; endIso: string; agent?: string },
  expectedTable?: string,
): boolean {
  if (!scope) return true;
  if (!sql) return false; // nothing to verify against
  const lexed = lexSql(sql);
  if (!lexed) return false; // not provably lexable the way BigQuery reads it
  const { literals } = lexed;
  let code = lexed.code;
  if (code.includes("'") || code.includes('"')) return false; // unbalanced quoting: unprovable
  if (/;\s*\S/.test(code)) return false; // multiple statements
  // IS NOT NULL is a benign narrowing predicate; strip it so the global NOT
  // rejection below doesn't have to reason about it
  code = code.replace(/\bIS\s+NOT\s+NULL\b/gi, " __ISNOTNULL__ ");
  // constructs that can widen, negate, split, or hide a scan → unprovable
  if (/\b(OR|NOT|UNION|INTERSECT|EXCEPT|EXISTS|JOIN|CASE|TABLESAMPLE|RECURSIVE)\b/i.test(code)) return false; // RECURSIVE: unmodeled CTE visibility (#1-r15)
  if (/\bIS\s+(TRUE|FALSE)\b/i.test(code)) return false; // (pred) IS FALSE inverts it
  if (/\bagent\b\s*(?:!=|<>|\bIN\b|\bLIKE\b)/i.test(code)) return false; // only equality is provable
  // a predicate on a DIFFERENT agent anywhere poisons the statement
  if (scope.agent) {
    const agentRe = new RegExp(`\\bagent\\b\\s*=\\s*${LIT_RE}`, "gi");
    let am: RegExpExecArray | null;
    while ((am = agentRe.exec(code))) {
      if (literals[Number(am[1])] !== scope.agent) return false;
    }
  }
  // an answer must come from at least one PROVABLY scoped telemetry scan -
  // a query with no table scan at all cannot certify the scope
  const seen = { scans: 0 };
  return checkBlock(code, scope, literals, new Set(), seen, expectedTable) && seen.scans > 0;
}

export function withScope(
  result: AskResult,
  scope?: { startIso: string; endIso: string; agent?: string },
  expectedTable?: string,
): AskResult {
  if (!scope) return result;
  // #1(r8): EVERY data-bearing query must pass — one unscoped result row set
  // poisons the whole answer. Streams with results but no owning SQL fail
  // closed; a purely textual answer verifies against the final SQL if any.
  const dataPairs = (result.queries ?? []).filter((q) => q.data_bearing);
  const verified = dataPairs.length
    ? dataPairs.every((q) => q.sql != null && verifyScope(q.sql, scope, expectedTable))
    : verifyScope(result.sql, scope, expectedTable);
  return {
    ...result,
    scope: { ...scope, verified },
    answer: verified
      ? result.answer
      : `${result.answer}\n\n⚠ Scope not verified: the generated SQL could not be confirmed to contain the selected time window${scope.agent ? " and agent filter" : ""}. Treat this answer as potentially covering a different slice.`,
  };
}
