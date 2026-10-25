/**
 * Batch → print sheet, as pure string functions.
 *
 * No DOM, no canvas, no zip library: the sheet is one SVG document per page, and the
 * QR geometry comes from the `qrcode` SVG renderer's own path data. That keeps the
 * "nothing leaves your browser" claim intact (a zip would mean another dependency and
 * a bigger bundle for a page whose job is to stay openable on a phone on hotel Wi-Fi),
 * and it keeps this file unit-testable from Node — see test/sheet.test.mjs.
 */

export interface ParsedTable {
  headers: string[];
  rows: string[][];
}

/**
 * RFC 4180-ish CSV/TSV reader: quoted fields, doubled quotes, CRLF or LF, trailing
 * blank line tolerated. Comma, tab or semicolon is chosen by counting which delimiter
 * appears outside quotes on the first line — guessing from the whole file breaks the
 * moment one field contains a comma.
 */
export function parseTable(text: string, opts: { header?: boolean } = {}): ParsedTable {
  const lines = splitLines(text);
  if (lines.length === 0) return { headers: [], rows: [] };

  const delimited = detectDelimiter(lines[0]);
  const table = lines.map((line) => splitLine(line, delimited));

  const width = Math.max(...table.map((r) => r.length));
  const padded = table.map((r) => (r.length === width ? r : [...r, ...Array(width - r.length).fill("")]));

  // A first row is only a header when every one of its cells reads like a column name.
  // `a<TAB>https://x.example` is two data rows, and guessing wrong silently deletes one
  // of the codes someone came here to print.
  const nameLike = (c: string) => /^[A-Za-z][A-Za-z ._'-]{0,39}$/.test(c.trim());
  const looksPayload = (c: string) =>
    /^(https?:|mailto:|smsto:|SMSTO:|WIFI:|BEGIN:VCARD|tel:)/i.test(c.trim());
  const guessed =
    width > 1 &&
    padded.length > 1 &&
    padded[0].every(nameLike) &&
    !padded[0].some(looksPayload);
  const hasHeader = opts.header ?? guessed;

  if (!hasHeader && width <= 1) {
    return { headers: ["value"], rows: padded.map((r) => [r[0]]) };
  }
  return hasHeader
    ? { headers: padded[0].map((h, i) => h.trim() || `Column ${i + 1}`), rows: padded.slice(1) }
    : { headers: padded[0].map((_, i) => `Column ${i + 1}`), rows: padded };
}

function splitLines(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n")
    .filter((l, i, all) => l.trim() !== "" || i === all.length - 1)
    .filter((l) => l.trim() !== "");
}

function detectDelimiter(line: string): string {
  const counts: Record<string, number> = {};
  let quoted = false;
  for (const ch of line) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "," || ch === "\t" || ch === ";")) counts[ch] = (counts[ch] || 0) + 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? best[0] : ",";
}

function splitLine(line: string, delimiter: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === delimiter) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map((c) => c.trim());
}

export interface SheetItem {
  /** The exact string encoded into the QR symbol. */
  payload: string;
  /** Printed under the code, if the sheet shows captions. */
  caption: string;
}

export interface SheetOptions {
  /** Label edge in millimetres. */
  cellMm: number;
  dpi: number;
  /** Leave room for the caption line inside each cell. */
  showCaption: boolean;
  pageLabel?: string;
}

const A4_MM = { width: 210, height: 297 };
const mmToPx = (mm: number, dpi: number) => Math.round((mm / 25.4) * dpi);

/**
 * Pull the drawable content out of a `qrcode` SVG string.
 *
 * The renderer emits `viewBox="0 0 N N"` where N counts the quiet zone, then a
 * background `<path fill>` and a modules `<path stroke>`. Taking the *first* path — the
 * tempting shortcut — gives you the background rectangle, i.e. a sheet of solid black
 * squares that still passes a "did it render?" test. So the whole inner markup is kept and
 * re-hosted in a nested `<svg>`, which preserves the renderer's own attributes exactly and
 * lets one cell scale from a 25 mm label to a poster without re-encoding.
 */
export function extractQrSvg(svg: string): { inner: string; size: number } | null {
  const viewBox = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
  if (!viewBox) return null;
  const w = Number(viewBox[1]);
  const h = Number(viewBox[2]);
  if (w !== h || w < 21) return null;

  const open = /<svg[^>]*>/.exec(svg);
  if (!open) return null;
  const start = (open.index ?? 0) + open[0].length;
  const end = svg.lastIndexOf("</svg>");
  if (end <= start) return null;

  const inner = svg.slice(start, end).trim();
  const paths = (inner.match(/<path/g) || []).length;
  // A real symbol is two paths minimum: the light background and the dark modules.
  if (paths < 2 || inner.length < 120) return null;
  return { inner, size: w };
}

/** One A4-sized SVG page of labels, ready to print or drop into a design file. */
export function buildSheetSvg(
  items: SheetItem[],
  svgOf: (payload: string) => string,
  opts: SheetOptions,
): string {
  const { cellMm, dpi, showCaption } = opts;
  const cell = mmToPx(cellMm, dpi);
  const gap = mmToPx(3, dpi);
  const margin = mmToPx(8, dpi);
  const caption = showCaption ? Math.round(cell * 0.16) : 0;
  const pageW = mmToPx(A4_MM.width, dpi);
  const pageH = mmToPx(A4_MM.height, dpi);

  const cols = Math.max(1, Math.floor((pageW - margin * 2 + gap) / (cell + gap)));
  const rowsPerPage = Math.max(1, Math.floor((pageH - margin * 2 + gap) / (cell + gap)));
  const perPage = cols * rowsPerPage;

  const blocks = items.map((item) => ({ ...item, qr: extractQrSvg(svgOf(item.payload)) }));
  const missing = blocks.filter((b) => !b.qr).length;
  if (missing) {
    throw new Error(
      `${missing} of ${blocks.length} codes could not be read back from the SVG renderer — refusing to print blank labels`,
    );
  }

  const pages: string[] = [];
  const pageCount = Math.max(1, Math.ceil(blocks.length / perPage));
  for (let p = 0; p < pageCount; p++) {
    const slice = blocks.slice(p * perPage, (p + 1) * perPage);
    const cells = slice.map((b, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = margin + col * (cell + gap);
      const y = margin + row * (cell + gap);
      const qrSize = cell - (showCaption ? caption : 0);
      const inset = Math.round((cell - qrSize) / 2);
      const label = showCaption
        ? `<text x="${x + cell / 2}" y="${y + cell - Math.round(caption * 0.3)}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(
            caption * 0.62,
          )}" text-anchor="middle" fill="#111827">${escapeXml(b.caption).slice(0, 120)}</text>`
        : "";
      const nested = `<svg x="${x + inset}" y="${y + inset}" width="${qrSize}" height="${qrSize}" viewBox="0 0 ${
        b.qr!.size
      } ${b.qr!.size}" preserveAspectRatio="xMidYMid meet">${b.qr!.inner}</svg>`;
      return `<g><rect x="${x}" y="${y}" width="${cell}" height="${cell}" fill="#ffffff" stroke="#e5e7eb"/>${nested}${label}</g>`;
    });

    pages.push(
      `<svg id="page-${p + 1}" xmlns="http://www.w3.org/2000/svg" width="${pageW}" height="${pageH}" viewBox="0 0 ${pageW} ${pageH}">` +
        `<rect width="${pageW}" height="${pageH}" fill="#ffffff"/>${cells.join("")}` +
        `<text x="${margin}" y="${pageH - Math.round(margin / 2)}" font-family="Helvetica, Arial, sans-serif" font-size="${Math.round(
          dpi / 14,
        )}" fill="#6b7280">${escapeXml(
          `${opts.pageLabel || "qr-label-sheet"} · page ${p + 1} of ${pageCount} · ${cellMm} mm labels · ${dpi} dpi · cut or peel along the boxes`,
        )}</text></svg>`,
    );
  }
  return pages.join("\n");
}

function escapeXml(value: string): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** The manifest that goes next to the sheet, so a label can always be traced back. */
export function buildManifestCsv(items: SheetItem[], extraColumns: string[] = []): string {
  const head = ["index", "caption", "payload_bytes", "payload", ...extraColumns.filter(Boolean)];
  const lines = [head.join(",")];
  items.forEach((item, i) => {
    lines.push(
      [
        String(i + 1),
        csvCell(item.caption),
        String(new TextEncoder().encode(item.payload).length),
        csvCell(item.payload),
      ].join(","),
    );
  });
  return lines.join("\r\n");
}

function csvCell(value: string): string {
  const v = String(value ?? "");
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

export const BATCH_LIMIT = 200;
