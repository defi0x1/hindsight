import type { ReportResult } from "./types.js";
import { shortAddress } from "./report.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function fmtUsd(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}$${Math.abs(n).toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

function fmtPct(n: number): string {
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(1)}%`;
}

/**
 * Renders the share card: a single self-contained HTML file, 1200x675,
 * embedded CSS and data, no network, no CDN. Meant to be opened from
 * file:// and screenshotted.
 */
export function renderCard(r: ReportResult): string {
  const since = r.since ?? "genesis";
  const rows = r.benchmarks
    .map((b) => {
      const cls = b.isCeiling ? "ceiling" : b.key === "actual" ? "actual" : "";
      const pctCls = b.pctChange >= 0 ? "pos" : "neg";
      const detail = b.isCeiling
        ? `<span class="note">the ceiling, not a target</span>`
        : `<span class="usd">${esc(fmtUsd(b.startUsd))} &rarr; ${esc(fmtUsd(b.endUsd))}</span>`;
      return `<div class="row ${cls}">
        <span class="label">${esc(b.label)}</span>
        <span class="pct ${pctCls}">${esc(fmtPct(b.pctChange))}</span>
        ${detail}
      </div>`;
    })
    .join("\n");

  const moneyLine =
    r.moneyLeftOnTableUsd != null
      ? `<div class="headline">you left ${esc(fmtUsd(r.moneyLeftOnTableUsd))} on the table.</div>`
      : "";

  const patternLines = r.pattern
    .split("\n")
    .map((l) => `<div>${esc(l)}</div>`)
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>hindsight · ${esc(shortAddress(r.address))}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body {
    margin: 0; padding: 0;
    width: 1200px; height: 675px;
    background: #0a0e0c;
    color: #d7e5dd;
    font-family: "SF Mono", "Menlo", "Consolas", "Courier New", monospace;
    overflow: hidden;
  }
  .card {
    width: 1200px; height: 675px;
    padding: 48px 56px;
    background:
      radial-gradient(circle at 15% 0%, rgba(60, 220, 140, 0.08), transparent 45%),
      #0a0e0c;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
  }
  .header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    border-bottom: 1px solid #1c2b23;
    padding-bottom: 20px;
  }
  .brand {
    font-size: 22px;
    letter-spacing: 0.08em;
    color: #7de8a4;
    font-weight: 700;
  }
  .meta {
    font-size: 15px;
    color: #6d8478;
  }
  .rows {
    display: flex;
    flex-direction: column;
    gap: 10px;
    margin-top: 8px;
  }
  .row {
    display: grid;
    grid-template-columns: 260px 130px 1fr;
    align-items: baseline;
    font-size: 20px;
    padding: 6px 0;
  }
  .row.actual { color: #f2f6f3; }
  .row.ceiling { color: #7f9186; }
  .label { color: inherit; }
  .pct { font-weight: 700; text-align: right; padding-right: 24px; }
  .pct.pos { color: #5be08a; }
  .pct.neg { color: #ef6f6f; }
  .usd { color: #93a89c; font-size: 17px; }
  .note { color: #6d8478; font-style: italic; font-size: 16px; }
  .headline {
    font-size: 26px;
    color: #f2f6f3;
    font-weight: 700;
    margin: 22px 0 6px;
  }
  .pattern-block {
    background: #0f1611;
    border: 1px solid #1c2b23;
    border-radius: 6px;
    padding: 16px 20px;
    font-size: 16px;
    line-height: 1.5;
    color: #b9c9bf;
  }
  .pattern-title {
    color: #7de8a4;
    letter-spacing: 0.08em;
    font-size: 13px;
    margin-bottom: 8px;
  }
  .footer {
    display: flex;
    justify-content: space-between;
    font-size: 14px;
    color: #55665c;
  }
</style>
</head>
<body>
  <div class="card">
    <div class="header">
      <div class="brand">HINDSIGHT</div>
      <div class="meta">${esc(shortAddress(r.address))} on ${esc(r.chain.displayName)} &middot; ${esc(since)} &rarr; ${esc(r.until)}</div>
    </div>

    <div class="rows">
${rows}
    </div>

    ${moneyLine}

    <div class="pattern-block">
      <div class="pattern-title">PATTERN</div>
      ${patternLines}
    </div>

    <div class="footer">
      <span>${r.positionCount} positions &middot; ${r.unpricedCount} unpriced and excluded</span>
      <span>it re-trades your wallet without you</span>
    </div>
  </div>
</body>
</html>
`;
}
