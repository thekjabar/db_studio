// Result-set export helpers shared by the SQL editor and table view.
// Covers the formats analysts ask for daily: CSV, JSON, Excel-compatible
// (tab-separated .xls that Excel opens natively), markdown table for pasting
// into docs/PRs, and SQL INSERT statements for moving data between DBs.

type Row = Record<string, unknown>;

function cellToString(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function download(content: string, mime: string, filename: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");

export function exportCsv(cols: string[], rows: Row[], base = "query") {
  const esc = (s: string) => (/[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const csv = [
    cols.join(","),
    ...rows.map((r) => cols.map((c) => esc(cellToString(r[c]))).join(",")),
  ].join("\n");
  download(csv, "text/csv;charset=utf-8", `${base}-${stamp()}.csv`);
}

export function exportJson(cols: string[], rows: Row[], base = "query") {
  // Re-project to the column order the user sees.
  const projected = rows.map((r) => {
    const o: Row = {};
    for (const c of cols) o[c] = r[c] ?? null;
    return o;
  });
  download(JSON.stringify(projected, null, 2), "application/json", `${base}-${stamp()}.json`);
}

export function exportExcel(cols: string[], rows: Row[], base = "query") {
  // Tab-separated values inside a minimal HTML table — Excel/LibreOffice open
  // this natively as a spreadsheet with typed columns, no SheetJS dependency.
  const escHtml = (s: string) =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const head = `<tr>${cols.map((c) => `<th>${escHtml(c)}</th>`).join("")}</tr>`;
  const body = rows
    .map((r) => `<tr>${cols.map((c) => `<td>${escHtml(cellToString(r[c]))}</td>`).join("")}</tr>`)
    .join("");
  const html =
    `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel">` +
    `<head><meta charset="utf-8"></head><body><table>${head}${body}</table></body></html>`;
  download(html, "application/vnd.ms-excel", `${base}-${stamp()}.xls`);
}

export function toMarkdownTable(cols: string[], rows: Row[]): string {
  const escPipe = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");
  const header = `| ${cols.map(escPipe).join(" | ")} |`;
  const sep = `| ${cols.map(() => "---").join(" | ")} |`;
  const body = rows
    .map((r) => `| ${cols.map((c) => escPipe(cellToString(r[c]))).join(" | ")} |`)
    .join("\n");
  return [header, sep, body].join("\n");
}

export function toInsertStatements(
  cols: string[],
  rows: Row[],
  tableName = "your_table",
): string {
  const lit = (v: unknown): string => {
    if (v === null || v === undefined) return "NULL";
    if (typeof v === "number" || typeof v === "boolean") return String(v);
    const s = typeof v === "object" ? JSON.stringify(v) : String(v);
    return `'${s.replace(/'/g, "''")}'`;
  };
  const colList = cols.map((c) => `"${c}"`).join(", ");
  return rows
    .map(
      (r) =>
        `INSERT INTO ${tableName} (${colList}) VALUES (${cols.map((c) => lit(r[c])).join(", ")});`,
    )
    .join("\n");
}

export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
