/**
 * Payload round-trip tests.
 *
 * For every payload mode: build the string with the shipped code, render it to a module
 * matrix, decode the result with a real reader, and compare byte-for-byte.
 *
 * Why this exists: the failure mode of a payload builder is invisible. A Wi-Fi code with
 * an unescaped `;`, or a vCard joined with LF instead of CRLF, renders a perfectly
 * normal-looking QR code that simply does not work on a phone. No human can eyeball that,
 * and no amount of copy review would catch it.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import QRCode from "qrcode";
import jsQR from "jsqr";

import { QR_MODES, buildPayload, safeZoneReport, ECL_RECOVERY, BYTE_CAPACITY } from "../dist/payloads.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(HERE, "fixtures.json"), "utf8"));

const show = (s) => JSON.stringify(String(s).replace(/\r/g, "\\r").replace(/\n/g, "\\n"));

/**
 * Paint the symbol the way a printer would — modules scaled to pixels, 4-module quiet
 * zone — then hand the pixels to a real decoder. No canvas, no snapshot files.
 */
function decode(payload, ecl) {
  const qr = QRCode.create(payload, { errorCorrectionLevel: ecl });
  const size = qr.modules.size;
  const scale = 8;
  const quiet = 4 * scale;
  const px = size * scale + quiet * 2;

  const rgba = new Uint8ClampedArray(px * px * 4).fill(255);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!qr.modules.get(x, y)) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = ((quiet + y * scale + dy) * px + (quiet + x * scale + dx)) * 4;
          rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
        }
      }
    }
  }

  const found = jsQR(rgba, px, px);
  return { text: found?.data ?? null, version: qr.version, modules: size };
}

/* ---------- every mode survives a real decoder, byte for byte ---------- */

for (const sample of fixtures.modes) {
  test(`${sample.mode} payload round-trips through a real decoder`, () => {
    const spec = QR_MODES.find((m) => m.mode === sample.mode);
    assert.ok(spec, `mode "${sample.mode}" has no spec — the fixture is out of sync`);

    const ecl = sample.ecl || "M";
    const expected = buildPayload(sample.mode, sample.values);
    assert.ok(expected, "builder returned an empty string for the fixture");

    const { text } = decode(expected, ecl);
    assert.equal(
      text,
      expected,
      `decoded bytes differ — escaping or line endings are being mangled\n        sent ${show(
        expected,
      )}\n        got  ${show(text)}`,
    );
  });
}

/* ---------- the rules that make a QR code work, asserted not described ---------- */

test("wifi metacharacters are escaped", () => {
  const wifi = buildPayload("wifi", { ssid: "net;work", password: 'p,a:ss"w', security: "WPA" });
  assert.equal(wifi, 'WIFI:T:WPA;S:net\\;work;P:p\\,a\\:ss\\"w;;');
});

test("wifi payload ends with the empty-field terminator", () => {
  const wifi = buildPayload("wifi", { ssid: "net;work", password: 'p,a:ss"w', security: "WPA" });
  assert.ok(wifi.endsWith(";;"));
});

test("an open network omits the password field", () => {
  const open = buildPayload("wifi", { ssid: "Cafe", security: "nopass", password: "ignored" });
  assert.ok(!open.includes("P:"));
});

test("a hidden network sets H:true", () => {
  const hidden = buildPayload("wifi", { ssid: "A", password: "B", security: "WPA", hidden: "true" });
  assert.ok(hidden.includes("H:true"));
});

test("an enterprise payload carries T:EAP and I:", () => {
  const eap = buildPayload("wifi", { ssid: "Corp", password: "x", security: "EAP", identity: "me@co.io" });
  assert.ok(eap.includes("T:EAP"));
  assert.ok(eap.includes("I:me@co.io"));
});

test("vCard lines are CRLF with no bare LF", () => {
  const card = buildPayload("vcard", { first: "Ada", last: "Lovelace", email: "a@b.c" });
  assert.ok(card.includes("\r\n"));
  assert.ok(!card.replace(/\r\n/g, "").includes("\n"));
});

test("vCard frame is BEGIN → VERSION → … → END", () => {
  const card = buildPayload("vcard", { first: "Ada", last: "Lovelace", email: "a@b.c" });
  assert.ok(card.startsWith("BEGIN:VCARD\r\nVERSION:3.0\r\n"));
  assert.ok(card.endsWith("\r\nEND:VCARD"));
});

test("vCard carries both N: and FN:", () => {
  const card = buildPayload("vcard", { first: "Ada", last: "Lovelace", email: "a@b.c" });
  assert.ok(card.includes("N:Lovelace;Ada;;;"));
  assert.ok(card.includes("FN:Ada Lovelace"));
});

test("vCard escapes , ; and backslash", () => {
  const vescape = buildPayload("vcard", { first: "A, B; C\\D", last: "E" });
  assert.ok(vescape.includes("N:E;A\\, B\\; C\\\\D;;;"));
});

test("bare domains get https://", () => {
  assert.equal(buildPayload("url", { value: "example.com/x" }), "https://example.com/x");
});

test("an existing scheme is preserved", () => {
  assert.equal(buildPayload("url", { value: "mailto:a@b.c" }), "mailto:a@b.c");
});

test("mailto parts are URL-encoded", () => {
  const mail = buildPayload("email", { to: "a@b.c", subject: "hi there", body: "line1\nline2" });
  assert.ok(mail.startsWith("mailto:a@b.c?"));
  assert.ok(mail.includes("subject=hi+there"));
});

test("newlines in the mail body are percent-encoded", () => {
  const mail = buildPayload("email", { to: "a@b.c", subject: "hi there", body: "line1\nline2" });
  assert.ok(mail.includes("body=line1%0Aline2"));
});

test("sms uses SMSTO:<number>:<text>", () => {
  assert.equal(buildPayload("sms", { number: "+44 7946 000000", message: "Hi" }), "SMSTO:+44 7946 000000:Hi");
});

test("an sms payload without a body stays dialable", () => {
  assert.equal(buildPayload("sms", { number: "+1 555 0100" }), "smsto:+1 555 0100");
});

/* ---------- safe-zone maths ---------- */

test("the default overlay (22% width, H) is reported as safe", () => {
  const sz = safeZoneReport({ logoPercent: 22, platePaddingPercent: 3, modules: 33, errorCorrectionLevel: "H" });
  assert.equal(sz.verdict, "safe");
});

test("the same overlay on level L is called risky", () => {
  const szL = safeZoneReport({ logoPercent: 22, platePaddingPercent: 3, modules: 33, errorCorrectionLevel: "L" });
  assert.equal(szL.verdict, "risky");
});

test("a 40%-width overlay is flagged tight at H, not waved through", () => {
  const big = safeZoneReport({ logoPercent: 40, platePaddingPercent: 4, modules: 33, errorCorrectionLevel: "H" });
  assert.equal(big.verdict, "tight");
});

test("a 60%-width overlay is rejected even at H", () => {
  const huge = safeZoneReport({ logoPercent: 60, platePaddingPercent: 4, modules: 33, errorCorrectionLevel: "H" });
  assert.equal(huge.verdict, "risky");
});

test("covered area is (logo + 2×plate)², not logo²", () => {
  const sz = safeZoneReport({ logoPercent: 22, platePaddingPercent: 3, modules: 33, errorCorrectionLevel: "H" });
  assert.ok(Math.abs(sz.coveredArea - Math.pow((22 + 6) / 100, 2)) < 1e-9);
});

test("recovery shares match ISO/IEC 18004", () => {
  assert.equal(ECL_RECOVERY.H, 0.3);
  assert.equal(ECL_RECOVERY.L, 0.07);
});

/* ---------- the capacity table, verified cell by cell ---------- */

// Byte mode, because that is what these payloads are. Uppercase-only probes silently
// switch the encoder into alphanumeric mode and read 40% higher — which is how the
// "4,296 bytes" myth gets repeated by tools that never measured anything.
const fitsBytes = (bytes, ecl, version) => {
  try {
    QRCode.create("a".repeat(bytes), { errorCorrectionLevel: ecl, version });
    return true;
  } catch {
    return false;
  }
};

const maxBytes = (version, ecl) => {
  let lo = 1;
  let hi = 3000;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (fitsBytes(mid, ecl, version)) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return best;
};

test("every capacity cell matches what the encoder actually accepts", () => {
  const wrong = [];
  for (const row of BYTE_CAPACITY) {
    for (const level of ["L", "M", "Q", "H"]) {
      const measured = maxBytes(row.version, level);
      if (measured !== row[level]) wrong.push(`v${row.version}/${level}: table says ${row[level]}, encoder says ${measured}`);
    }
  }
  assert.deepEqual(wrong, []);
});

test("2,953 bytes is the real ceiling — one more byte fits nowhere", () => {
  assert.ok(fitsBytes(2953, "L", 40));
  assert.ok(!fitsBytes(2954, "L", 40));
});

test("a maximum-size symbol still renders and decodes (177×177 modules)", () => {
  const maxSymbol = decode("a".repeat(2953), "L");
  assert.notEqual(maxSymbol.text, null);
  assert.equal(maxSymbol.modules, 177);
});

/* ---------- the number everyone quotes ---------- */

// "A QR code holds up to 4,296 characters" is pasted across the web. It is true only for
// v40/L in *alphanumeric* mode; byte mode — what real payloads use — tops out at 2,953.
const boundary = (ecl, version, seed, expectMode) => {
  let lo = 1;
  let hi = 8000;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let qr;
    try {
      qr = QRCode.create(seed(mid), { errorCorrectionLevel: ecl, version });
    } catch {
      hi = mid - 1;
      continue;
    }
    const segs = qr.segments?.length ?? 0;
    const mode = String(qr.segments?.[0]?.mode?.id ?? "").toLowerCase();
    // The encoder optimises modes: a mixed-case string stops being a byte-mode
    // measurement at all. Single segment or no claim.
    if (segs !== 1 || mode !== expectMode) {
      hi = mid - 1;
      continue;
    }
    best = mid;
    lo = mid + 1;
  }
  return best;
};

const digits = (n) => Array.from({ length: n }, (_, i) => "0123456789"[i % 10]).join("");
const letters = (n) => Array.from({ length: n }, (_, i) => String.fromCharCode(65 + (i % 26))).join("");
const lower = (n) => "a".repeat(n);

test("v40/L numeric capacity is exactly 7,089 chars in one segment", () => {
  assert.equal(boundary("L", 40, digits, "numeric"), 7089);
});

test("v40/L alphanumeric capacity is exactly 4,296 chars in one segment", () => {
  assert.equal(boundary("L", 40, letters, "alphanumeric"), 4296);
});

test("v40/L byte capacity is exactly 2,953 chars in one segment", () => {
  assert.equal(boundary("L", 40, lower, "byte"), 2953);
});

test("why the myth survives: the same symbol holds more alphanumeric chars than bytes", () => {
  assert.ok(boundary("L", 40, letters, "alphanumeric") > boundary("L", 40, lower, "byte"));
});
