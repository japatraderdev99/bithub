// format.mjs — formatadores deterministicos, sem locale dependente.
//
// Regras:
// - Numeros financeiros sempre com tabular-nums (CSS) — aqui formatamos
//   o STRING; CSS aplica o variant.
// - Datas em ISO-8601 UTC e relativo curto ("3m ago", "2h ago", "1d ago").
// - Sem inferir tendencia. Sem cor por sinal. Sem emoji.

const MINUTE_S = 60;
const HOUR_S = 60 * 60;
const DAY_S = 24 * HOUR_S;

/** "1234567.89" -> "1,234,567.89" com 2 casas; preserva sinal. */
export function fmtNumber(value, { precision = 2 } = {}) {
  if (value === null || value === undefined || value === "") return "—";
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n)) return "—";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  const fixed = abs.toFixed(precision);
  const [intPart, fracPart] = fixed.split(".");
  const intGrouped = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return fracPart ? `${sign}${intGrouped}.${fracPart}` : `${sign}${intGrouped}`;
}

/** "0.0042" -> "42 bps" se quisermos. Phase 0 nao usa. */

export function fmtMs(value) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  return `${fmtNumber(n, { precision: 0 })} ms`;
}

export function fmtSeconds(value) {
  if (value === null || value === undefined) return "—";
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n < MINUTE_S) return `${fmtNumber(n, { precision: 0 })}s`;
  if (n < HOUR_S) return `${fmtNumber(n / MINUTE_S, { precision: 1 })}m`;
  if (n < DAY_S) return `${fmtNumber(n / HOUR_S, { precision: 1 })}h`;
  return `${fmtNumber(n / DAY_S, { precision: 1 })}d`;
}

/** ISO UTC -> "YYYY-MM-DD HH:MM:SS UTC". Determinista (sem locale). */
export function fmtIso(value) {
  if (typeof value !== "string") return "—";
  const m = value.match(
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z$/
  );
  if (!m) return value;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]}:${m[6]} UTC`;
}

/**
 * Relativo a `now` (ISO ou Date). Default: now = new Date().
 * "12s ago", "3m ago", "2h ago", "1d ago".
 * Para futuro: "in 12s".
 */
export function fmtRelative(value, now) {
  if (typeof value !== "string") return "—";
  const t = Date.parse(value);
  if (Number.isNaN(t)) return value;
  const ref =
    now instanceof Date
      ? now.getTime()
      : typeof now === "string"
        ? Date.parse(now)
        : Date.now();
  const deltaSec = Math.round((ref - t) / 1000);
  const abs = Math.abs(deltaSec);
  const suffix = deltaSec >= 0 ? "ago" : "from now";
  let body;
  if (abs < MINUTE_S) body = `${abs}s`;
  else if (abs < HOUR_S) body = `${Math.round(abs / MINUTE_S)}m`;
  else if (abs < DAY_S) body = `${Math.round(abs / HOUR_S)}h`;
  else body = `${Math.round(abs / DAY_S)}d`;
  return `${body} ${suffix}`;
}

/** chip truncado: "01HZX...AB". */
export function fmtTruncated(value, { head = 6, tail = 2 } = {}) {
  if (typeof value !== "string") return "—";
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}…${value.slice(-tail)}`;
}

export const STATUS_GLYPH = Object.freeze({
  ok: "●",
  degraded: "▲",
  stale: "◷",
  error: "✕",
  loading: "◌",
  empty: "○",
  unknown: "?",
});

export function statusGlyph(status) {
  return STATUS_GLYPH[status] || STATUS_GLYPH.unknown;
}
