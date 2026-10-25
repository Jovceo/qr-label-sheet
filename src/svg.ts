/**
 * SVG composition for a QR code with a centred logo.
 *
 * Why strings instead of a canvas: a PNG at 3 000 px and an SVG that stays crisp at
 * 3 000 dpi must come from the same geometry, or the page would be showing one file and
 * shipping another. Working from the renderer's own `viewBox` means the logo is placed in
 * module units, so the overlay keeps its proportions at every export size — which is the
 * one thing a raster-only generator gets wrong when people print it on a poster.
 */

import { extractQrSvg } from "./sheet.js";

export interface OverlayInput {
  /** Modules per side of the symbol itself, e.g. 25 for version 3. */
  symbolModules: number;
  /** Modules per side of the whole image, i.e. symbol + quiet zone on both sides. */
  imageModules: number;
  /** Percent of the *symbol* edge the logo covers — the convention people expect. */
  logoPercent: number;
  /** Percent of the symbol edge added as white plate padding on each side. */
  platePaddingPercent: number;
  /** Draw the white plate behind the logo. */
  plate: boolean;
}

export interface OverlayBox {
  logo: { x: number; y: number; size: number };
  plate: { x: number; y: number; size: number } | null;
  /** Share of the symbol's area hidden by logo + plate, 0–1. */
  coveredArea: number;
}

/**
 * Where the overlay goes, in image-module units.
 *
 * One function for both renderers on purpose: the canvas preview, the PNG export and the
 * SVG file are three different pixel scales of the same placement. If they ever used
 * percentages of *their own* width, the logo would drift off-centre relative to the
 * symbol's quiet zone between preview and download — which is invisible on screen and
 * fatal on a print sheet.
 */
export function overlayGeometry(input: OverlayInput): OverlayBox {
  const symbol = Math.max(21, input.symbolModules || 21);
  const image = Math.max(symbol, input.imageModules || symbol);
  const centre = image / 2;

  const logoSide = (input.logoPercent / 100) * symbol;
  const pad = input.plate ? (input.platePaddingPercent / 100) * symbol : 0;
  const coveredSide = Math.min(image, logoSide + pad * 2);

  return {
    logo: { x: round(centre - logoSide / 2), y: round(centre - logoSide / 2), size: round(logoSide) },
    plate:
      input.plate && pad > 0
        ? {
            x: round(centre - coveredSide / 2),
            y: round(centre - coveredSide / 2),
            size: round(coveredSide),
          }
        : input.plate
          ? { x: round(centre - logoSide / 2), y: round(centre - logoSide / 2), size: round(logoSide) }
          : null,
    coveredArea: Math.min(1, (coveredSide / symbol) ** 2),
  };
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * Insert a logo (and optional guard plate) into a `qrcode` SVG string.
 *
 * Returns null when the input is not a QR SVG, so the caller can say "could not
 * compose" instead of handing out a code with an invisible logo.
 */
export function composeLogoSvg(
  svg: string,
  input: OverlayInput & { logoHref: string; fit?: "meet" | "slice"; background?: string },
): string | null {
  const extracted = extractQrSvg(svg);
  if (!extracted) return null;
  const geometry = overlayGeometry({ ...input, imageModules: extracted.size });

  const plateRect = geometry.plate
    ? `<rect x="${geometry.plate.x}" y="${geometry.plate.y}" width="${geometry.plate.size}" height="${
        geometry.plate.size
      }" rx="${round(Math.min(geometry.plate.size * 0.08, 1))}" fill="${
        input.background || "#ffffff"
      }"/>`
    : "";
  const image = `<image href="${input.logoHref}" x="${geometry.logo.x}" y="${geometry.logo.y}" width="${
    geometry.logo.size
  }" height="${geometry.logo.size}" preserveAspectRatio="xMidYMid ${
    input.fit === "slice" ? "slice" : "meet"
  }"/>`;

  return svg.replace("</svg>", `${plateRect}${image}</svg>`);
}

/**
 * Relative luminance ratio, for the "will a phone tell these apart?" hint.
 * Returns 0 for anything it cannot parse, so an invalid swatch can never read as
 * high contrast in the UI.
 */
export function contrastRatio(a: string, b: string): number {
  const rgbA = parseHex(a);
  const rgbB = parseHex(b);
  if (!rgbA || !rgbB) return 0;
  const lum = (rgb: number[]) => {
    const ch = rgb.map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
  };
  const la = lum(rgbA);
  const lb = lum(rgbB);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

export function parseHex(value: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(value.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Print sizes worth offering: `printMm` is the edge at 300 dpi. */
export const EXPORT_SIZES = [
  { px: 320, printMm: 27, label: "320 px", use: "screen, chat, docs" },
  { px: 800, printMm: 68, label: "800 px", use: "social, slide decks" },
  { px: 1200, printMm: 102, label: "1200 px", use: "A6 flyer, tent card" },
  { px: 3000, printMm: 254, label: "3000 px", use: "A4 poster, vinyl, projected screens" },
] as const;

/** Minimum printed module edge most phone cameras resolve at arm's length. */
export const MIN_MODULE_MM = 0.7;

/**
 * Printed module edge in millimetres, given the physical size of the whole symbol
 * including its quiet zone. This — not the pixel count — is what decides whether a
 * phone camera can resolve the code.
 */
export function moduleSizeMm(symbolModules: number, margin: number, printMm: number): number {
  const imageModules = symbolModules + margin * 2;
  if (!imageModules || !printMm) return 0;
  return printMm / imageModules;
}
