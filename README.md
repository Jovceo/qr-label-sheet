# qr-label-sheet

**CSV in, printable A4 QR label sheet out.** Pure string and SVG output — no canvas, no
image upload, no runtime dependencies, nothing leaves the process.

Your spreadsheet has 200 URLs, a printer, and a sheet of A4 sticker paper. That is the
whole input. This turns it into a paginated sheet of codes in one call, with a manifest
CSV so a printed label can always be traced back to its row.

```js
import QRCode from "qrcode";
import { readFile, writeFile } from "node:fs/promises";
import { parseTable, buildSheetSvg, buildManifestCsv } from "qr-label-sheet/sheet";

const { rows } = parseTable(await readFile("labels.csv", "utf8"));
const items = rows.map(([caption, payload]) => ({ caption, payload }));

// svgOf is a SYNC lookup, so pre-render with your (async) encoder first
const rendered = new Map();
for (const { payload } of items) {
  rendered.set(payload, await QRCode.toString(payload, { type: "svg", margin: 2 }));
}

const sheet = buildSheetSvg(items, (p) => rendered.get(p), {
  cellMm: 25,
  dpi: 300,
  showCaption: true,
});

await writeFile("labels.svg", sheet);          // every page, ready to print
await writeFile("manifest.csv", buildManifestCsv(items));
```

`qrcode` is not a dependency — you pass in whatever SVG renderer you already use. The
package only owns the parts that are hard to get right: the pagination, the label
geometry, and the "is this actually scannable" maths.

## Why another QR package

There are QR encoders, and there are PDF/print libraries. What was missing was the join:
a spreadsheet in, a page-marked-up label sheet out, with the print geometry treated as
the real problem rather than an afterthought.

What that means concretely:

- **Pagination that doesn't drop the last row.** 71 labels at 25 mm on A4 is 2 pages, not
  1.5. The page break is computed from the same box model that places the cells.
- **The symbol survives extraction.** The obvious shortcut — take the renderer's first
  `<path>` — hands you its white background, i.e. a sheet of solid black squares that
  still passes a "did it render?" check. This keeps the whole inner markup in a nested
  `<svg>` so one cell scales from a 25 mm label to a poster.
- **A blank render throws.** Half a page of empty boxes is worse than an error.
- **Print size is in millimetres, not pixels.** `moduleSizeMm()` answers the only question
  that decides whether a phone camera can read the code at arm's length.

A full UI built on this package: <https://jsgenerator.com/tools/qr-code-generator-with-logo>

## Install

Not on the npm registry yet — install straight from GitHub (a `prepare` script
builds the package on your machine, no prebuilt artifacts shipped):

```sh
npm i github:Jovceo/qr-label-sheet
```

It will land on `npm i qr-label-sheet` once there is real demand for it.

Node 18+. ESM only.

## Entry points

| Import | What is in it |
|---|---|
| `qr-label-sheet/sheet` | `parseTable`, `buildSheetSvg`, `extractQrSvg`, `buildManifestCsv`, `BATCH_LIMIT` |
| `qr-label-sheet/svg` | `composeLogoSvg`, `overlayGeometry`, `contrastRatio`, `moduleSizeMm`, `MIN_MODULE_MM`, `EXPORT_SIZES` |
| `qr-label-sheet/payloads` | `buildPayload` (url / text / wifi / vcard / email / sms), `safeZoneReport`, `BYTE_CAPACITY` |

### `parseTable(text)`

RFC 4180-ish CSV/TSV reader: quoted fields, doubled quotes, CRLF or LF. The delimiter
(comma, tab, semicolon) is chosen by counting which one appears outside quotes on the
first line — guessing from the whole file breaks the moment one field contains a comma.

A first row is treated as a header only when every cell reads like a column name, so a
pasted column of bare URLs is not silently swallowed as a header and loses a code.

### `buildSheetSvg(items, svgOf, options)`

`items` is `{ payload, caption }[]`; `svgOf` maps a payload to the renderer's SVG string;
`options` is `{ cellMm, dpi, showCaption, pageLabel? }`. Returns one `<svg>` document per
page, joined by newlines. Throws if any symbol cannot be read back — refusing to print
blank labels.

### `composeLogoSvg(svg, input)`

Places a centred logo (and optional white guard plate) **in module units**, derived from
the renderer's own `viewBox`. That is what keeps the overlay proportionally identical at
320 px and at 3 000 dpi — the thing raster-only generators get wrong when someone prints
the result on a poster.

### `safeZoneReport(input)`

Answers "will this overlay still scan?" before you print 200 of them. `coveredArea` is
`(logo + 2 × plate)²` — the plate counts, which is easy to forget.

## The number everyone quotes is wrong

You have seen "a QR code holds up to 4,296 characters". That figure is real, but it is
v40 / level L in **alphanumeric** mode. Byte mode — what a URL, a vCard or a Wi-Fi string
actually is — tops out at **2,953 bytes** in the same symbol.

The test suite pins all three at the encoder boundary: 7,089 numeric, 4,296 alphanumeric,
2,953 byte. Measuring it is fiddly for a reason worth knowing: a probe built from mixed
case text gets silently re-segmented by the encoder into optimised runs, so the number you
measure stops being a byte-mode measurement at all. Hence the rule: single segment or no
claim.

## Tested by decoding, not by looking

`npm test` builds the package and then imports **`dist/`** — not `src/`. A test that
imports the TypeScript source passes even when the build is broken or an `exports` entry
points at a file that was never emitted.

The payload tests build each mode, render it to a module matrix, decode it with a real
reader (`jsqr`) and compare byte-for-byte. A Wi-Fi code with an unescaped `;`, or a vCard
joined with LF instead of CRLF, looks perfectly normal and simply does not work on a
phone — no human can eyeball that, and no amount of copy review catches it.

## Print cheat sheet

| Label | Typical use | Module edge at 25 mm |
|---|---|---|
| 25 mm | address / inventory sticker | ~0.8 mm |
| 40 mm | product label | ~1.3 mm |
| 50 mm | shipping label | ~1.7 mm |

Below `MIN_MODULE_MM` (0.7 mm) most phone cameras start failing at arm's length;
`moduleSizeMm()` warns you before the printer runs.

## License

MIT
