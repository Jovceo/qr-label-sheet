/**
 * Sheet tests — run against the built package, not the TypeScript source.
 *
 * That is deliberate: `npm test` builds first and imports from `dist/`, so a broken
 * build, a missing export or a wrong `exports` map fails here instead of in a user's
 * project. A test that imports `src/*.ts` would pass all of this and still ship broken.
 */

import test from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";

import {
  parseTable,
  extractQrSvg,
  buildSheetSvg,
  buildManifestCsv,
  BATCH_LIMIT,
} from "../dist/sheet.js";

/* ---------- CSV parsing ---------- */

test("csv: CRLF, header row and a quoted comma all survive", () => {
  const csv = parseTable('label,url\r\n"Desk, east",https://a.example\r\nDesk west,https://b.example\r\n');
  assert.deepEqual(csv.headers, ["label", "url"]);
  assert.equal(csv.rows.length, 2);
  assert.equal(csv.rows[0][0], "Desk, east", "a quoted comma stays inside its field");
  assert.equal(csv.rows[0][1], "https://a.example", "no column shift after a quoted field");
});

test("csv: a pasted single column of URLs needs no header", () => {
  const oneCol = parseTable("https://a.example\nhttps://b.example\n\n");
  assert.equal(oneCol.rows.length, 2);
  assert.equal(oneCol.rows[1][0], "https://b.example");
});

test("csv: tabs are auto-detected", () => {
  const tsv = parseTable("a\thttps://x.example\nb\thttps://y.example");
  assert.equal(tsv.rows.length, 2);
  assert.equal(tsv.rows[1][1], "https://y.example");
});

test('csv: doubled quotes unescape to a single quote', () => {
  const quotes = parseTable('label,url\n"He said ""hi""",https://q.example');
  assert.equal(quotes.rows[0][0], 'He said "hi"');
});

test("csv: semicolons are detected as a delimiter too", () => {
  const semi = parseTable("a;https://x.example\nb;https://y.example");
  assert.equal(semi.rows.length, 2);
  assert.equal(semi.rows[1][1], "https://y.example");
});

/* ---------- SVG extraction ---------- */

test("extractQrSvg keeps the viewBox that equals modules + quiet zone", async () => {
  const sampleSvg = await QRCode.toString("https://a.example", { type: "svg", margin: 2 });
  const extracted = extractQrSvg(sampleSvg);
  const sampleModules = QRCode.create("https://a.example", { errorCorrectionLevel: "M" }).modules.size + 4;
  assert.ok(extracted, "a real symbol must extract");
  assert.equal(extracted.size, sampleModules);
});

test("extractQrSvg keeps the stroked module path, not only the background rect", async () => {
  const sampleSvg = await QRCode.toString("https://a.example", { type: "svg", margin: 2 });
  const extracted = extractQrSvg(sampleSvg);
  // The renderer's FIRST path is the white background. Taking it produces a sheet of
  // solid black squares that still passes a naive "did it render?" check.
  assert.match(extracted.inner, /<path[^>]*stroke/);
});

test("a background-only svg is rejected instead of printed as a black box", () => {
  assert.equal(extractQrSvg('<svg viewBox="0 0 25 25"><path fill="#fff" d="M0 0h25v25H0z"/></svg>'), null);
});

test("non-QR markup is refused, not silently blanked", () => {
  assert.equal(extractQrSvg("<svg><rect/></svg>"), null);
});

/* ---------- pagination and placement ---------- */

const rows = (n) => Array.from({ length: n }, (_, i) => ({ payload: `https://a.example/${i}`, caption: `Row ${i + 1}` }));

async function svgProvider(items) {
  const cache = new Map();
  for (const item of items) {
    if (!cache.has(item.payload)) {
      cache.set(item.payload, await QRCode.toString(item.payload, { type: "svg", margin: 2 }));
    }
  }
  return (payload) => cache.get(payload) || "";
}

test("71 labels at 25 mm spill onto a second A4 page", async () => {
  const many = rows(71);
  const sheet = buildSheetSvg(many, await svgProvider(many), { cellMm: 25, dpi: 300, showCaption: true });
  const pages = (sheet.match(/id="page-/g) || []).length;
  assert.equal(pages, 2, "7x10 grid = 70 per page, so the 71st must land on page 2");
});

test("every batch row is placed as a scaled symbol, none dropped at the page break", async () => {
  const many = rows(71);
  const sheet = buildSheetSvg(many, await svgProvider(many), { cellMm: 25, dpi: 300, showCaption: true });
  const cells = (sheet.match(/preserveAspectRatio="xMidYMid meet"/g) || []).length;
  assert.equal(cells, 71);
});

test("cells are centred in the label box and keep their own viewBox", async () => {
  const many = rows(3);
  const sheet = buildSheetSvg(many, await svgProvider(many), { cellMm: 25, dpi: 300, showCaption: true });
  const sampleCell = /<svg x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" viewBox="0 0 (\d+) \d+"/.exec(sheet);
  assert.ok(sampleCell, "no nested symbol found in the sheet");

  const cellPx = Math.round((25 / 25.4) * 300);
  const marginPx = Math.round((8 / 25.4) * 300);
  const qrSize = cellPx - Math.round(cellPx * 0.16);
  const inset = Math.round((cellPx - qrSize) / 2);
  const [, x, y, w, h, vb] = sampleCell.map(Number);
  assert.equal(x, marginPx + inset);
  assert.equal(y, marginPx + inset);
  assert.equal(w, qrSize);
  assert.equal(h, qrSize);
  assert.ok(vb >= 21);
});

test("captions off leaves only the page footer text", async () => {
  const many = rows(3);
  const small = buildSheetSvg(many, await svgProvider(many), { cellMm: 50, dpi: 300, showCaption: false });
  assert.equal((small.match(/<text/g) || []).length, 1);
});

test("a blank render fails loudly instead of printing empty labels", () => {
  assert.throws(() =>
    buildSheetSvg([{ payload: "x", caption: "" }], () => "not svg", { cellMm: 25, dpi: 300, showCaption: false }),
  );
});

test("the footer carries a caller-supplied label instead of a hard-coded brand", async () => {
  const many = rows(1);
  const plain = buildSheetSvg(many, await svgProvider(many), { cellMm: 40, dpi: 300, showCaption: false });
  const branded = buildSheetSvg(many, await svgProvider(many), {
    cellMm: 40,
    dpi: 300,
    showCaption: false,
    pageLabel: "ACME Stores",
  });
  assert.match(plain, /qr-label-sheet/);
  assert.match(branded, /ACME Stores/);
});

/* ---------- manifest ---------- */

test("manifest csv escapes commas and quotes", () => {
  const manifest = buildManifestCsv([{ payload: 'a,"b"', caption: "Desk, east" }]);
  assert.match(manifest, /"Desk, east"/);
  assert.match(manifest, /"a,""b"""/);
});

test("manifest records row order and the payload byte length", () => {
  const manifest = buildManifestCsv([{ payload: 'a,"b"', caption: "Desk, east" }]);
  assert.equal(manifest.split("\r\n").length, 2);
  assert.match(manifest, /,5,"a,""b"""/);
});

test("batch cap is 200 rows", () => {
  assert.equal(BATCH_LIMIT, 200);
});
