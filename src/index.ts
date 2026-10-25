/**
 * Convenience barrel. The three subpath exports (`./sheet`, `./svg`, `./payloads`)
 * are the supported entry points; this one just re-exports all of them so a quick
 * `import { parseTable } from "qr-label-sheet"` works in a script or a REPL.
 */
export * from "./sheet.js";
export * from "./svg.js";
export * from "./payloads.js";
