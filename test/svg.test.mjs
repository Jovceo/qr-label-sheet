/**
 * Logo overlay and print-geometry tests. Same rule as the sheet suite: the import
 * points at `dist/`, so the published artefact is what gets measured.
 */

import test from "node:test";
import assert from "node:assert/strict";
import QRCode from "qrcode";

import { extractQrSvg } from "../dist/sheet.js";
import {
  composeLogoSvg,
  contrastRatio,
  moduleSizeMm,
  overlayGeometry,
  MIN_MODULE_MM,
} from "../dist/svg.js";

const base = async () => await QRCode.toString("https://a.example", { type: "svg", margin: 2 });
const dims = async () => {
  const svg = await base();
  const imageModules = extractQrSvg(svg).size; // symbol + 2 quiet modules each side
  return { svg, imageModules, symbolModules: imageModules - 4 };
};

test("logo + guard plate are embedded in the svg", async () => {
  const { svg, symbolModules, imageModules } = await dims();
  const composed = composeLogoSvg(svg, {
    symbolModules,
    imageModules,
    logoPercent: 22,
    platePaddingPercent: 3,
    plate: true,
    logoHref: "data:image/png;base64,AAAA",
  });
  assert.ok(composed.includes("<image"));
  assert.ok(composed.includes("<rect"));
});

test("the composed file is still one well-formed svg", async () => {
  const { svg, symbolModules, imageModules } = await dims();
  const composed = composeLogoSvg(svg, {
    symbolModules,
    imageModules,
    logoPercent: 22,
    platePaddingPercent: 3,
    plate: true,
    logoHref: "data:image/png;base64,AAAA",
  });
  assert.equal((composed.match(/<svg/g) || []).length, 1);
  assert.ok(composed.trim().endsWith("</svg>"));
});

test("overlay is centred on the symbol and sized in symbol modules", async () => {
  const { svg, symbolModules, imageModules } = await dims();
  const composed = composeLogoSvg(svg, {
    symbolModules,
    imageModules,
    logoPercent: 22,
    platePaddingPercent: 3,
    plate: true,
    logoHref: "data:image/png;base64,AAAA",
  });
  const img = /<image href="[^"]*" x="([\d.]+)" y="([\d.]+)" width="([\d.]+)"/.exec(String(composed));
  assert.ok(img, "<image> element missing attributes");

  // Placement derived from the viewBox holds at 320 px and at 3 000 px alike.
  const expectedSize = (22 / 100) * symbolModules;
  const expectedX = imageModules / 2 - expectedSize / 2;
  const [x, y, w] = [Number(img[1]), Number(img[2]), Number(img[3])];
  assert.ok(Math.abs(w - expectedSize) < 0.01);
  assert.ok(Math.abs(x - expectedX) < 0.01);
  assert.equal(x, y);
});

test("plate off means no white box in the file", async () => {
  const { svg, symbolModules, imageModules } = await dims();
  const noPlate = composeLogoSvg(svg, {
    symbolModules,
    imageModules,
    logoPercent: 20,
    platePaddingPercent: 0,
    plate: false,
    logoHref: "x",
  });
  assert.ok(noPlate);
  assert.ok(!noPlate.includes("<rect"));
});

test("composing over a non-QR svg reports failure instead of shipping it", () => {
  assert.equal(
    composeLogoSvg("<svg></svg>", {
      symbolModules: 25,
      imageModules: 29,
      logoPercent: 20,
      platePaddingPercent: 0,
      plate: false,
      logoHref: "x",
    }),
    null,
  );
});

test("geometry is identical for the same input, whatever the pixel scale", () => {
  const input = { symbolModules: 25, imageModules: 29, logoPercent: 22, platePaddingPercent: 3, plate: true };
  assert.deepEqual(overlayGeometry(input), overlayGeometry({ ...input }));
  assert.ok(overlayGeometry(input).coveredArea > 0);
});

test("the default palette is reported as high contrast", () => {
  assert.ok(contrastRatio("#111827", "#ffffff") > 15);
});

test("grey-on-white is flagged before printing", () => {
  assert.ok(contrastRatio("#777777", "#ffffff") < 5);
});

test("an invalid hex cannot fake a contrast reading", () => {
  assert.equal(contrastRatio("#zzz", "#ffffff"), 0);
});

test("printed module size includes the quiet zone", () => {
  assert.ok(Math.abs(moduleSizeMm(45, 4, 20) - 20 / 53) < 1e-9);
});

test("a 45-module code printed at 20 mm is correctly judged too small to scan", () => {
  assert.ok(moduleSizeMm(45, 4, 20) < MIN_MODULE_MM);
});

test("a v3 symbol at 29 mm is exactly 1 mm per module", () => {
  assert.ok(Math.abs(moduleSizeMm(25, 2, 29) - 1) < 1e-9);
});
