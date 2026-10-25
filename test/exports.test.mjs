/**
 * Entry-point tests.
 *
 * Every other suite imports `../dist/foo.js` directly, which bypasses package.json
 * entirely — so a typo in the `exports` map would ship green. These imports go through
 * the *package name*, the way a consumer's `import ... from "qr-label-sheet/svg"` does.
 * Node resolves self-references through `exports`, so a broken map fails here instead of
 * in somebody's project.
 */

import test from "node:test";
import assert from "node:assert/strict";

const SUBS = {
  "qr-label-sheet/sheet": ["parseTable", "buildSheetSvg", "extractQrSvg", "buildManifestCsv", "BATCH_LIMIT"],
  "qr-label-sheet/svg": ["composeLogoSvg", "overlayGeometry", "contrastRatio", "moduleSizeMm", "MIN_MODULE_MM", "EXPORT_SIZES"],
  "qr-label-sheet/payloads": ["buildPayload", "safeZoneReport", "BYTE_CAPACITY", "ECL_RECOVERY", "QR_MODES"],
  "qr-label-sheet": ["parseTable", "composeLogoSvg", "buildPayload"],
};

for (const [specifier, expected] of Object.entries(SUBS)) {
  test(`${specifier} resolves and exposes its documented names`, async () => {
    const mod = await import(specifier);
    for (const name of expected) {
      assert.ok(name in mod, `missing export: ${name}`);
      assert.notEqual(mod[name], undefined, `${name} is undefined`);
    }
  });
}

test("deep imports outside the map are refused", async () => {
  // The point of "exports" is that it is a wall, not a suggestion. If this ever starts
  // passing, someone dropped the field and internal files became public API by accident.
  await assert.rejects(() => import("qr-label-sheet/dist/sheet.js"), { code: "ERR_PACKAGE_PATH_NOT_EXPORTED" });
});
