export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function fmtUsd(v: number): string {
  if (v === 0) return "$0";
  if (v < 0.01) return `$${v.toPrecision(2)}`;
  if (v < 100) return `$${v.toFixed(3)}`;
  return `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
}

export function fmtTime(s: number): string {
  if (s < 90) return `${Math.round(s)} s`;
  if (s < 5400) return `${(s / 60).toFixed(1)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} h`;
  return `${(s / 86400).toFixed(1)} d`;
}

export function fmtKg(v: number): string {
  if (v === 0) return "0";
  if (v < 0.001) return v.toExponential(1);
  if (v < 10) return v.toFixed(4);
  return v.toFixed(1);
}

export function fmtPct(p: number): string {
  return `${(p * 100).toFixed(2)}%`;
}

export function shortHex(h: string, n = 6): string {
  return h.length > 2 * n + 2 ? `${h.slice(0, n + 2)}…${h.slice(-n)}` : h;
}

export function ago(unix: number | undefined): string {
  if (!unix) return "";
  const d = Date.now() / 1000 - unix;
  if (d < 90) return `${Math.max(1, Math.round(d))} s ago`;
  if (d < 5400) return `${Math.round(d / 60)} min ago`;
  if (d < 172800) return `${Math.round(d / 3600)} h ago`;
  return `${Math.round(d / 86400)} d ago`;
}

export function utc(unix: number): string {
  return new Date(unix * 1000).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}
