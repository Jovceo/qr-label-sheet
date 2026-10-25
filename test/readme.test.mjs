/**
 * The README's quick start, executed.
 *
 * Not a copy of it — the fenced block is extracted from README.md and run by a child
 * process, because a copy drifts and the drift is invisible. Two failures are pinned:
 *
 *   1. the snippet must be valid JavaScript (an `await` inside a non-async arrow shipped
 *      once, and a reader's very first program died on it);
 *   2. every name it imports must resolve through the package's `exports` map, because
 *      the snippet imports `qr-label-sheet/sheet`, not a relative path.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SANDBOX = join(ROOT, ".readme-run");

const blocks = [...readFileSync(join(ROOT, "README.md"), "utf8").matchAll(/```js\r?\n([\s\S]*?)```/g)].map(
  (m) => m[1],
);

test("the first js block in the README is the quick start", () => {
  assert.ok(blocks.length >= 1, "README has no ```js block");
  assert.match(blocks[0], /buildSheetSvg/, "the first ```js block must be the quick start");
});

test("the quick start runs end to end and produces a sheet plus a manifest", () => {
  rmSync(SANDBOX, { recursive: true, force: true });
  mkdirSync(SANDBOX, { recursive: true });

  try {
    writeFileSync(join(SANDBOX, "labels.csv"), "Desk east,https://a.example/1\nDesk west,https://b.example/2\n");
    writeFileSync(join(SANDBOX, "run.mjs"), blocks[0]);

    // cwd is the sandbox so that "labels.csv" resolves as written; the import still goes
    // through the package name, so this also proves `exports` works from a real process.
    execFileSync(process.execPath, ["run.mjs"], { cwd: SANDBOX, stdio: "pipe" });

    const svg = readFileSync(join(SANDBOX, "labels.svg"), "utf8");
    const manifest = readFileSync(join(SANDBOX, "manifest.csv"), "utf8");

    assert.equal((svg.match(/id="page-/g) || []).length, 1, "two rows must fit on a single A4 page");
    assert.match(svg, /<svg/);
    assert.equal(manifest.split("\r\n").length, 3, "header + 2 rows");
  } finally {
    rmSync(SANDBOX, { recursive: true, force: true });
  }
});
