// UI primitives — formatting, DOM/SVG helpers, tooltip, charts, tiles,
// tables, and cards. STATELESS with respect to the dashboard: no scope
// generations, no host bridge, no view state live here (decomposition step 1,
// #4-r19). The two bits of local state are the tooltip element and the
// open-disclosure keys, both purely presentational.

import { WIDGET_MEASURES } from "./queries.js";
import type { DashboardData, TimeBucket } from "./types.js";

// Disclosure keys default to a per-view namespace; the app tells us which
// view is active without this module knowing view state.
let viewKey: () => string = () => "";
export function setViewKeyProvider(fn: () => string): void {
  viewKey = fn;
}

// ---------------------------------------------------------------- formatting

export const fmtInt = (v: number | null | undefined): string =>
  v == null ? "—" : Math.round(v).toLocaleString("en-US");

export const fmtCompact = (v: number | null | undefined): string => {
  if (v == null) return "—";
  const a = Math.abs(v);
  if (a >= 1e9) return `${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(1)}K`;
  return Math.round(v).toLocaleString("en-US");
};

export const fmtMs = (v: number | null | undefined): string => {
  if (v == null) return "—";
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(1)} s`;
  return `${(v / 60_000).toFixed(1)} min`;
};

export const fmtPct = (v: number | null | undefined): string => (v == null ? "—" : `${v}%`);

export const fmtUSD = (v: number | null | undefined): string => {
  if (v == null) return "—";
  if (v >= 1000) return `$${(v / 1000).toFixed(1)}K`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toFixed(4)}`;
};

export function widgetValueFmt(measure: string): (v: number | null) => string {
  const unit = WIDGET_MEASURES[measure]?.unit;
  if (unit === "ms") return fmtMs;
  if (unit === "pct") return (v) => fmtPct(v);
  return (v) => fmtCompact(v);
}

export function toCSV(head: string[], rows: string[][]): string {
  const esc = (s: string): string => {
    // formula-leading cells would execute in spreadsheet apps — neutralize
    const guarded = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
    return /[",\n]/.test(guarded) ? `"${guarded.replaceAll('"', '""')}"` : guarded;
  };
  return [head, ...rows].map((r) => r.map(esc).join(",")).join("\n");
}

export function csvButton(filename: string, get: () => { head: string[]; rows: string[][] }): HTMLElement {
  const b = el("button", "link-btn", "CSV");
  b.setAttribute("aria-label", `Download ${filename} as CSV`);
  b.addEventListener("click", () => {
    const { head, rows } = get();
    const url = URL.createObjectURL(new Blob([toCSV(head, rows)], { type: "text/csv" }));
    const a = el("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
  return b;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function bucketLabel(iso: string, granularity: "hour" | "day"): string {
  const d = new Date(iso);
  const md = `${MONTHS[d.getMonth()]} ${d.getDate()}`;
  if (granularity === "day") return md;
  return `${md}, ${String(d.getHours()).padStart(2, "0")}:00`;
}

// ---------------------------------------------------------------- DOM utils

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

const NS = "http://www.w3.org/2000/svg";
export function svgEl<K extends keyof SVGElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | number> = {},
): SVGElementTagNameMap[K] {
  const n = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
  return n;
}

// ---------------------------------------------------------------- tooltip

const tooltipEl = document.getElementById("tooltip") as HTMLDivElement;

export interface TooltipRow {
  name: string;
  value: string;
  cssVar?: string;
}

export function showTooltip(title: string, rows: TooltipRow[], clientX: number, clientY: number): void {
  tooltipEl.replaceChildren();
  tooltipEl.appendChild(el("div", "tt-title", title));
  for (const r of rows) {
    const row = el("div", "tt-row");
    const key = el("span", "tt-key");
    key.style.background = r.cssVar ? `var(${r.cssVar})` : "transparent";
    row.appendChild(key);
    row.appendChild(el("span", "tt-val", r.value));
    row.appendChild(el("span", "tt-name", r.name));
    tooltipEl.appendChild(row);
  }
  tooltipEl.hidden = false;
  const rect = tooltipEl.getBoundingClientRect();
  let x = clientX + 14;
  let y = clientY + 14;
  if (x + rect.width > window.innerWidth - 8) x = clientX - rect.width - 14;
  if (y + rect.height > window.innerHeight - 8) y = clientY - rect.height - 14;
  tooltipEl.style.left = `${Math.max(4, x)}px`;
  tooltipEl.style.top = `${Math.max(4, y)}px`;
}

export function hideTooltip(): void {
  tooltipEl.hidden = true;
}

// ---------------------------------------------------------------- scales

export function niceMax(raw: number): number {
  if (raw <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (raw <= m * mag) return m * mag;
  }
  return 10 * mag;
}

// ---------------------------------------------------------------- line chart

export interface LineSeries {
  name: string;
  cssVar: string;
  values: Array<number | null>;
}

export function lineChart(
  container: HTMLElement,
  buckets: TimeBucket[],
  series: LineSeries[],
  opts: {
    yFmt: (v: number | null) => string;
    granularity: "hour" | "day";
    height?: number;
    ariaLabel: string;
    areaFirst?: boolean; // ~10% wash under the first series
    sectionError?: string;
  },
): void {
  const H = opts.height ?? 236;
  const W = Math.max(280, container.clientWidth || 560);
  const n = buckets.length;
  if (n === 0) {
    emptyNote(container, opts.sectionError);
    return;
  }

  const maxVal = niceMax(Math.max(1, ...series.flatMap((s) => s.values.filter((v): v is number => v != null))));
  // left margin sized to the widest y-tick label so units like "16.7 min" fit
  const TICKS = 4;
  const tickLabels = Array.from({ length: TICKS }, (_, k) => opts.yFmt((maxVal / TICKS) * (k + 1)));
  const m = {
    top: 10,
    right: 46,
    bottom: 22,
    left: Math.max(40, 12 + Math.max(...tickLabels.map((t) => t.length)) * 6.6),
  };
  const pw = W - m.left - m.right;
  const ph = H - m.top - m.bottom;
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.ariaLabel });

  const x = (i: number) => m.left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
  const y = (v: number) => m.top + ph - (v / maxVal) * ph;

  // gridlines + y ticks (clean numbers)
  for (let t = 1; t <= TICKS; t++) {
    const v = (maxVal / TICKS) * t;
    const gy = y(v);
    const line = svgEl("line", { x1: m.left, x2: m.left + pw, y1: gy, y2: gy });
    line.setAttribute("class", "gridline");
    svg.appendChild(line);
    const label = svgEl("text", { x: m.left - 6, y: gy + 3, "text-anchor": "end" });
    label.textContent = tickLabels[t - 1];
    svg.appendChild(label);
  }
  const base = svgEl("line", { x1: m.left, x2: m.left + pw, y1: m.top + ph, y2: m.top + ph });
  base.setAttribute("class", "baseline");
  svg.appendChild(base);

  // x ticks — at most 6
  const step = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += step) {
    const label = svgEl("text", { x: x(i), y: H - 6, "text-anchor": "middle" });
    label.textContent = bucketLabel(buckets[i].ts, opts.granularity);
    svg.appendChild(label);
  }

  // series paths, end dots, selective end labels
  const endLabelYs: number[] = [];
  series.forEach((s, si) => {
    let d = "";
    let pen = false;
    let firstIdx = -1;
    let lastIdx = -1;
    s.values.forEach((v, i) => {
      if (v == null) {
        pen = false;
        return;
      }
      if (firstIdx < 0) firstIdx = i;
      lastIdx = i;
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
      pen = true;
    });
    if (d && si === 0 && opts.areaFirst && firstIdx >= 0 && lastIdx > firstIdx) {
      const wash = svgEl("path", {
        d: `${d}L${x(lastIdx).toFixed(1)},${(m.top + ph).toFixed(1)}L${x(firstIdx).toFixed(1)},${(m.top + ph).toFixed(1)}Z`,
      });
      wash.style.fill = "var(--wash)";
      svg.appendChild(wash);
    }
    if (d) {
      const path = svgEl("path", {
        d,
        fill: "none",
        "stroke-width": 2,
        "stroke-linejoin": "round",
        "stroke-linecap": "round",
      });
      path.style.stroke = `var(${s.cssVar})`;
      svg.appendChild(path);
    }
    let last = -1;
    for (let i = n - 1; i >= 0; i--) {
      if (s.values[i] != null) {
        last = i;
        break;
      }
    }
    if (last >= 0) {
      const vy = y(s.values[last] as number);
      const dot = svgEl("circle", { cx: x(last), cy: vy, r: 4, "stroke-width": 2 });
      dot.style.fill = `var(${s.cssVar})`;
      dot.style.stroke = "var(--surface-1)";
      svg.appendChild(dot);
      // end label only when it won't collide with an earlier series' label
      if (!endLabelYs.some((py) => Math.abs(py - vy) < 13)) {
        endLabelYs.push(vy);
        const label = svgEl("text", { x: x(last) + 8, y: vy + 3 });
        label.textContent = opts.yFmt(s.values[last]);
        label.style.fill = "var(--ink-2)";
        svg.appendChild(label);
      }
    }
  });

  // crosshair + hover/focus layer
  const cross = svgEl("line", { y1: m.top, y2: m.top + ph, x1: 0, x2: 0, visibility: "hidden" });
  cross.setAttribute("class", "crosshair");
  svg.appendChild(cross);

  const overlay = svgEl("rect", {
    x: m.left,
    y: m.top,
    width: pw,
    height: ph,
    fill: "transparent",
    tabindex: 0,
  });
  overlay.setAttribute("class", "hit-overlay");
  let focusIdx = n - 1;

  const present = (i: number, cx: number, cy: number) => {
    cross.setAttribute("x1", String(x(i)));
    cross.setAttribute("x2", String(x(i)));
    cross.setAttribute("visibility", "visible");
    showTooltip(
      bucketLabel(buckets[i].ts, opts.granularity),
      series.map((s) => ({ name: s.name, value: opts.yFmt(s.values[i]), cssVar: s.cssVar })),
      cx,
      cy,
    );
  };
  overlay.addEventListener("pointermove", (e) => {
    const rect = svg.getBoundingClientRect();
    // #21(r5): the SVG may render scaled (max-width guard) — map client
    // coordinates into viewBox space before picking a bucket
    const px = (e.clientX - rect.left) * (W / rect.width) - m.left;
    const i = Math.max(0, Math.min(n - 1, Math.round((px / pw) * (n - 1))));
    focusIdx = i;
    present(i, e.clientX, e.clientY);
  });
  overlay.addEventListener("pointerleave", () => {
    cross.setAttribute("visibility", "hidden");
    hideTooltip();
  });
  const presentFocus = () => {
    const rect = svg.getBoundingClientRect();
    const scale = rect.width / W;
    present(focusIdx, rect.left + x(focusIdx) * scale, rect.top + (m.top + ph / 2) * scale);
  };
  overlay.addEventListener("focus", presentFocus);
  overlay.addEventListener("blur", () => {
    cross.setAttribute("visibility", "hidden");
    hideTooltip();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "ArrowLeft") focusIdx = Math.max(0, focusIdx - 1);
    else if (e.key === "ArrowRight") focusIdx = Math.min(n - 1, focusIdx + 1);
    else return;
    e.preventDefault();
    presentFocus();
  });
  svg.appendChild(overlay);
  container.appendChild(svg);
}

// ------------------------------------------------------------ stacked columns

export interface ColumnSegment {
  name: string;
  cssVar: string;
  values: number[];
}

export function roundedTopRect(x: number, y: number, w: number, h: number, r: number): string {
  r = Math.min(r, h, w / 2);
  return `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + r} L${x + w},${y + h} Z`;
}

export function stackedColumns(
  container: HTMLElement,
  buckets: TimeBucket[],
  segments: ColumnSegment[],
  opts: {
    yFmt: (v: number | null) => string;
    granularity: "hour" | "day";
    height?: number;
    ariaLabel: string;
    sectionError?: string;
  },
): void {
  const H = opts.height ?? 210;
  const W = Math.max(280, container.clientWidth || 560);
  const n = buckets.length;
  if (n === 0) {
    emptyNote(container, opts.sectionError);
    return;
  }

  const totals = buckets.map((_, i) => segments.reduce((a, s) => a + (s.values[i] ?? 0), 0));
  const maxVal = niceMax(Math.max(1, ...totals));
  // left margin sized to the widest y-tick label
  const TICKS = 4;
  const tickLabels = Array.from({ length: TICKS }, (_, k) => opts.yFmt((maxVal / TICKS) * (k + 1)));
  const m = {
    top: 10,
    right: 10,
    bottom: 22,
    left: Math.max(40, 12 + Math.max(...tickLabels.map((t) => t.length)) * 6.6),
  };
  const pw = W - m.left - m.right;
  const ph = H - m.top - m.bottom;
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": opts.ariaLabel });

  const band = pw / n;
  const colW = Math.min(24, Math.max(3, band * 0.6));
  const yOf = (v: number) => m.top + ph - (v / maxVal) * ph;

  for (let t = 1; t <= TICKS; t++) {
    const v = (maxVal / TICKS) * t;
    const gy = yOf(v);
    const line = svgEl("line", { x1: m.left, x2: m.left + pw, y1: gy, y2: gy });
    line.setAttribute("class", "gridline");
    svg.appendChild(line);
    const label = svgEl("text", { x: m.left - 6, y: gy + 3, "text-anchor": "end" });
    label.textContent = tickLabels[t - 1];
    svg.appendChild(label);
  }
  const base = svgEl("line", { x1: m.left, x2: m.left + pw, y1: m.top + ph, y2: m.top + ph });
  base.setAttribute("class", "baseline");
  svg.appendChild(base);

  const tickStep = Math.max(1, Math.ceil(n / 6));
  for (let i = 0; i < n; i += tickStep) {
    const label = svgEl("text", { x: m.left + band * i + band / 2, y: H - 6, "text-anchor": "middle" });
    label.textContent = bucketLabel(buckets[i].ts, opts.granularity);
    svg.appendChild(label);
  }

  const GAP = 2; // surface gap between stacked segments
  for (let i = 0; i < n; i++) {
    const g = svgEl("g");
    (g as SVGGElement).classList.add("col");
    const cx = m.left + band * i + (band - colW) / 2;
    let cursor = m.top + ph;
    const visible = segments.filter((s) => (s.values[i] ?? 0) > 0);
    visible.forEach((s, si) => {
      const v = s.values[i] ?? 0;
      let h = (v / maxVal) * ph;
      const isTop = si === visible.length - 1;
      const yTop = cursor - h;
      if (si > 0) h = Math.max(0.5, h - GAP);
      const shape = isTop
        ? svgEl("path", { d: roundedTopRect(cx, cursor - ((s.values[i] ?? 0) / maxVal) * ph + (si > 0 ? GAP : 0), colW, h, 4) })
        : svgEl("rect", { x: cx, y: yTop + (si > 0 ? GAP : 0), width: colW, height: h });
      shape.style.fill = `var(${s.cssVar})`;
      g.appendChild(shape);
      cursor = yTop;
    });
    const hit = svgEl("rect", {
      x: m.left + band * i,
      y: m.top,
      width: band,
      height: ph,
      fill: "transparent",
      tabindex: 0,
    });
    hit.setAttribute("class", "hit-col");
    const presentAt = (cxp: number, cyp: number) => {
      const rows: TooltipRow[] = segments.map((s) => ({
        name: s.name,
        value: opts.yFmt(s.values[i] ?? 0),
        cssVar: s.cssVar,
      }));
      rows.push({ name: "Total", value: opts.yFmt(totals[i]) });
      showTooltip(bucketLabel(buckets[i].ts, opts.granularity), rows, cxp, cyp);
    };
    hit.addEventListener("pointermove", (e) => presentAt(e.clientX, e.clientY));
    hit.addEventListener("pointerleave", hideTooltip);
    hit.addEventListener("focus", () => {
      const r = svg.getBoundingClientRect();
      presentAt(r.left + cx, r.top + m.top + ph / 2);
    });
    hit.addEventListener("blur", hideTooltip);
    g.addEventListener("pointerenter", () => ((g as SVGGElement).style.filter = "brightness(1.08)"));
    g.addEventListener("pointerleave", () => ((g as SVGGElement).style.filter = ""));
    g.appendChild(hit);
    svg.appendChild(g);
  }
  container.appendChild(svg);
}

// ---------------------------------------------------------------- h-bars

export interface HBarSeg {
  cssVar: string;
  value: number;
}

export interface HBarRow {
  label: string;
  segs: HBarSeg[];
  display: string;
  tooltipTitle: string;
  tooltipRows: TooltipRow[];
}

export function hBars(container: HTMLElement, rows: HBarRow[], sectionError?: string): void {
  if (rows.length === 0) {
    emptyNote(container, sectionError);
    return;
  }
  const max = Math.max(1, ...rows.map((r) => r.segs.reduce((a, s) => a + s.value, 0)));
  const wrap = el("div", "hbar-rows");
  for (const r of rows) {
    const row = el("div", "hbar-row");
    row.tabIndex = 0;
    row.appendChild(el("div", "hbar-label", r.label));
    const track = el("div", "hbar-track");
    const visible = r.segs.filter((s) => s.value > 0);
    visible.forEach((s, i) => {
      const seg = el("div", `hbar-seg ${i === visible.length - 1 ? "end" : "start"}`);
      seg.style.width = `${(s.value / max) * 100}%`;
      seg.style.background = `var(${s.cssVar})`;
      track.appendChild(seg);
    });
    row.appendChild(track);
    row.appendChild(el("div", "hbar-value", r.display));
    row.addEventListener("pointermove", (e) => showTooltip(r.tooltipTitle, r.tooltipRows, e.clientX, e.clientY));
    row.addEventListener("pointerleave", hideTooltip);
    row.addEventListener("focus", () => {
      const rect = row.getBoundingClientRect();
      showTooltip(r.tooltipTitle, r.tooltipRows, rect.left + rect.width / 2, rect.bottom);
    });
    row.addEventListener("blur", hideTooltip);
    wrap.appendChild(row);
  }
  container.appendChild(wrap);
}

// ---------------------------------------------------------------- table/tile

export interface Col<T> {
  label: string;
  get: (r: T) => string;
  cell?: (r: T) => HTMLElement; // custom cell content (e.g. drill-down button)
}

export function emptyNote(container: HTMLElement, sectionError?: string): void {
  container.appendChild(
    sectionError
      ? el("div", "empty error", `Query failed: ${sectionError}`)
      : el("div", "empty", "No data in this window"),
  );
}

export function table<T>(container: HTMLElement, cols: Col<T>[], rows: T[], sectionError?: string): void {
  if (rows.length === 0) {
    emptyNote(container, sectionError);
    return;
  }
  const scroll = el("div", "table-scroll");
  const t = el("table");
  const thead = el("thead");
  const hr = el("tr");
  for (const c of cols) hr.appendChild(el("th", undefined, c.label));
  thead.appendChild(hr);
  t.appendChild(thead);
  const tbody = el("tbody");
  for (const r of rows) {
    const tr = el("tr");
    for (const c of cols) {
      const td = el("td");
      if (c.cell) td.appendChild(c.cell(r));
      else td.textContent = c.get(r);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  t.appendChild(tbody);
  scroll.appendChild(t);
  container.appendChild(scroll);
}

// 12-point stat-tile sparkline: de-emphasis stroke, current period as accent dot
export function sparkline(values: Array<number | null>): SVGSVGElement | null {
  const nums = values.map((v) => v ?? 0);
  if (nums.length < 2) return null;
  const pts: number[] = [];
  const N = Math.min(12, nums.length);
  for (let i = 0; i < N; i++) {
    const lo = Math.floor((i / N) * nums.length);
    const hi = Math.max(lo + 1, Math.floor(((i + 1) / N) * nums.length));
    pts.push(nums.slice(lo, hi).reduce((a, b) => a + b, 0) / (hi - lo));
  }
  const W = 76;
  const H = 26;
  const max = Math.max(1, ...pts);
  const x = (i: number) => 2 + (i / (N - 1)) * (W - 8);
  const y = (v: number) => H - 3 - (v / max) * (H - 7);
  const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, "aria-hidden": "true" });
  svg.classList.add("spark");
  const path = svgEl("path", {
    d: pts.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(""),
    fill: "none",
    "stroke-width": 1.5,
    "stroke-linecap": "round",
    "stroke-linejoin": "round",
  });
  path.style.stroke = "var(--spark-line)";
  svg.appendChild(path);
  const dot = svgEl("circle", { cx: x(N - 1), cy: y(pts[N - 1]), r: 2.5 });
  dot.style.fill = "var(--accent)";
  svg.appendChild(dot);
  return svg;
}

// Period-over-period delta chip: signed % change vs the preceding window.
// direction semantics: "bad" = an increase is a regression (errors, latency),
// "neutral" = informational only (volume metrics).
export interface TileDelta {
  cur: number | null | undefined;
  prev: number | null | undefined;
  upIs: "bad" | "neutral";
}

export function deltaChip(d: TileDelta): HTMLElement | null {
  if (d.cur == null || d.prev == null || d.prev === 0) return null;
  const pct = ((d.cur - d.prev) / Math.abs(d.prev)) * 100;
  if (!Number.isFinite(pct)) return null;
  const up = pct >= 0;
  const cls = d.upIs === "neutral" ? "neutral" : up ? "bad" : "good";
  const chip = el("span", `chip ${cls}`, `${up ? "▲" : "▼"} ${Math.abs(pct) < 10 ? Math.abs(pct).toFixed(1) : Math.round(Math.abs(pct))}%`);
  chip.title = "vs previous period";
  return chip;
}

export function tile(
  label: string,
  value: string,
  detail?: string,
  spark?: Array<number | null>,
  delta?: TileDelta,
): HTMLElement {
  const card = el("div", "card tile");
  card.appendChild(el("div", "label", label));
  const valueRow = el("div", "value-row");
  valueRow.appendChild(el("div", "value", value));
  if (delta) {
    const chip = deltaChip(delta);
    if (chip) valueRow.appendChild(chip);
  }
  card.appendChild(valueRow);
  if (detail) card.appendChild(el("div", "detail", detail));
  if (spark) {
    const s = sparkline(spark);
    if (s) card.appendChild(s);
  }
  return card;
}

// #2: a failed section must never render as an authoritative zero — KPIs
// derived from it show an explicit unavailable state instead.
export function unavailableTile(label: string): HTMLElement {
  return tile(label, "—", "unavailable — query failed");
}

export function sectionsFailed(d: DashboardData, ...names: string[]): string | null {
  for (const n of names) {
    const e = d.meta.section_errors?.[n];
    if (e) return e;
  }
  return null;
}

export function tileRow(...tiles: HTMLElement[]): HTMLElement {
  const row = el("div", "tile-row");
  tiles.forEach((t) => row.appendChild(t));
  return row;
}

export interface LegendItem {
  name: string;
  cssVar: string;
  kind: "line" | "rect";
}

// Every chart card can expose its exact numbers as an accessible table.
export interface ChartData {
  head: string[];
  rows: string[][];
}

// #22: open/closed disclosure state survives re-renders (resize, refresh)
const openDisclosures = new Set<string>();

export function statefulDetails(cls: string, summaryText: string, key: string): HTMLElement {
  const details = el("details", cls);
  details.appendChild(el("summary", undefined, summaryText));
  if (openDisclosures.has(key)) (details as HTMLDetailsElement).open = true;
  details.addEventListener("toggle", () => {
    if ((details as HTMLDetailsElement).open) openDisclosures.add(key);
    else openDisclosures.delete(key);
  });
  return details;
}

export function dataTable(dt: ChartData, stateKey?: string): HTMLElement {
  const details = statefulDetails("data-table", "Show data", stateKey ?? `${viewKey()}:${dt.head.join("|")}`);
  const scroll = el("div", "table-scroll");
  const t = el("table");
  const thead = el("thead");
  const hr = el("tr");
  dt.head.forEach((h) => hr.appendChild(el("th", undefined, h)));
  thead.appendChild(hr);
  t.appendChild(thead);
  const tbody = el("tbody");
  dt.rows.forEach((r) => {
    const tr = el("tr");
    r.forEach((cell) => tr.appendChild(el("td", undefined, cell)));
    tbody.appendChild(tr);
  });
  t.appendChild(tbody);
  scroll.appendChild(t);
  details.appendChild(scroll);
  return details;
}

export function chartCard(
  title: string,
  sub: string | null,
  legend: LegendItem[],
  span: "full" | "half" = "full",
  csv?: { filename: string; get: () => { head: string[]; rows: string[][] } },
): { card: HTMLElement; body: HTMLElement } {
  const card = el("div", `card${span === "full" ? " span-full" : ""}`);
  if (csv) {
    const head = el("div", "card-head");
    head.appendChild(el("h2", undefined, title));
    head.appendChild(csvButton(csv.filename, csv.get));
    card.appendChild(head);
  } else {
    card.appendChild(el("h2", undefined, title));
  }
  if (sub) card.appendChild(el("div", "sub", sub));
  if (legend.length >= 2) {
    const lg = el("div", "legend");
    for (const item of legend) {
      const it = el("span", "item");
      const key = el("span", item.kind === "line" ? "key-line" : "key-rect");
      key.style.background = `var(${item.cssVar})`;
      it.appendChild(key);
      it.appendChild(document.createTextNode(item.name));
      lg.appendChild(it);
    }
    card.appendChild(lg);
  }
  const body = el("div");
  card.appendChild(body);
  return { card, body };
}

