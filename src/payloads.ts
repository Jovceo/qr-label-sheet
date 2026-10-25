/**
 * QR payload construction — the one place these rules live.
 *
 * Both QR pages consume this module, and `scripts/qr-roundtrip.mjs` decodes every
 * builder's output with a real reader. That pairing is the point: a "QR generator"
 * page that hands out a wrongly escaped Wi-Fi string is worse than no page at all,
 * and the failure is invisible in the browser (the code renders fine, it just does
 * not join the network).
 *
 * Reference behaviour encoded here:
 *  - Wi-Fi   : `WIFI:T:<sec>;S:<ssid>;P:<pass>;H:<bool>;;` with `\ ; , : "` escaped
 *  - vCard 3.0: CRLF line endings (LF-only cards are rejected by several scanners)
 *  - SMS     : `SMSTO:<number>:<text>` (works on both iOS and Android readers)
 * No browser APIs are used, so this file is importable from a Node script.
 */

export type QrMode = "url" | "text" | "wifi" | "vcard" | "email" | "sms";

export type FieldType =
  | "text"
  | "password"
  | "textarea"
  | "email"
  | "tel"
  | "select"
  | "checkbox";

export interface QrField {
  key: string;
  label: string;
  type: FieldType;
  placeholder?: string;
  required?: boolean;
  hint?: string;
  checkboxLabel?: string;
  options?: { value: string; label: string }[];
}

export interface QrModeSpec {
  mode: QrMode;
  label: string;
  anchor: string;
  /** What the field set is for — also the sentence an answer engine can quote. */
  summary: string;
  fields: QrField[];
  /** Gotchas a generic "just put the URL in" generator does not tell you. */
  notes: string[];
  build: (v: Record<string, string>) => string;
  defaults: Record<string, string>;
}

/** Wi-Fi escaping: backslash first, then the four metacharacters. */
export function escapeWifi(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/:/g, "\\:")
    .replace(/"/g, '\\"');
}

/** vCard escaping: backslash, semicolon, comma, and literal newlines. */
export function escapeVCard(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

export function normalizeUrl(value: string): string {
  const v = value.trim();
  if (!v) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return v;
  return `https://${v.replace(/^\/+/, "")}`;
}

export function wifiPayload(v: Record<string, string>): string {
  const security = v.security || "WPA";
  const parts = [`T:${security}`, `S:${escapeWifi(v.ssid || "")}`];
  if (security !== "nopass") parts.push(`P:${escapeWifi(v.password || "")}`);
  if (security === "EAP") {
    if (v.identity) parts.push(`I:${escapeWifi(v.identity)}`);
    parts.push("E:peap");
    parts.push("A:none");
  }
  if (v.hidden === "true") parts.push("H:true");
  return `WIFI:${parts.join(";")};;`;
}

export function vcardPayload(v: Record<string, string>): string {
  const first = (v.first || "").trim();
  const last = (v.last || "").trim();
  const full = [first, last].filter(Boolean).join(" ").trim();
  const lines = [
    "BEGIN:VCARD",
    "VERSION:3.0",
    `N:${escapeVCard(last)};${escapeVCard(first)};;;`,
    `FN:${escapeVCard(full || v.org || "Contact")}`,
  ];
  if (v.org) lines.push(`ORG:${escapeVCard(v.org)}`);
  if (v.title) lines.push(`TITLE:${escapeVCard(v.title)}`);
  if (v.phone) lines.push(`TEL;TYPE=CELL:${escapeVCard(v.phone)}`);
  if (v.workPhone) lines.push(`TEL;TYPE=WORK,VOICE:${escapeVCard(v.workPhone)}`);
  if (v.email) lines.push(`EMAIL;TYPE=INTERNET,PREF:${escapeVCard(v.email)}`);
  if (v.website) lines.push(`URL:${escapeVCard(normalizeUrl(v.website))}`);
  if (v.address || v.city || v.region || v.postalCode || v.country) {
    // ADR is 7 ordered components (PO box;extended;street;locality;region;postal;country).
    // Empty components must stay as empty segments, so the separators are never dropped.
    const components = [v.address, v.city, v.region, v.postalCode, v.country].map(escapeVCard);
    lines.push(`ADR;TYPE=WORK:;;${components.join(";")}`);
  }
  if (v.note) lines.push(`NOTE:${escapeVCard(v.note)}`);
  lines.push("END:VCARD");
  // CRLF is required by RFC 2426/6350; the string is joined with \r\n on purpose.
  return lines.join("\r\n");
}

export function emailPayload(v: Record<string, string>): string {
  const params = new URLSearchParams();
  if (v.subject) params.set("subject", v.subject);
  if (v.body) params.set("body", v.body);
  const cc = (v.cc || "").trim();
  if (cc) params.set("cc", cc);
  const query = params.toString();
  return `mailto:${(v.to || "").trim()}${query ? `?${query}` : ""}`;
}

export function smsPayload(v: Record<string, string>): string {
  const number = (v.number || "").trim();
  const body = (v.message || "").trim();
  return body ? `SMSTO:${number}:${body}` : `smsto:${number}`;
}

export function telPayload(v: Record<string, string>): string {
  return `tel:${(v.number || "").trim()}`;
}

export const QR_MODES: QrModeSpec[] = [
  {
    mode: "url",
    label: "URL",
    anchor: "url",
    summary:
      "A URL QR code stores the link itself — there is no redirect service, so the code never expires as long as you keep the page.",
    defaults: { value: "https://jsgenerator.com" },
    fields: [
      {
        key: "value",
        label: "Destination URL",
        type: "text",
        placeholder: "example.com/pricing",
        required: true,
        hint: "https:// is added automatically when missing.",
      },
    ],
    notes: [
      "Every URL QR code is static: the encoded string is the final link, so the code cannot be re-targeted later. Dynamic QR services sell you a redirect URL precisely because they can rewrite it server-side.",
      "Shorten the path if the code must print small. Byte mode capacity at version 10 / level M is 213 characters, but the symbol gets denser with every extra byte and dense symbols are what phones fail on.",
      "Test the exact printed size, not the on-screen preview. Camera focus distance changes everything below about 20 mm of module area.",
    ],
    build: (v) => normalizeUrl(v.value || ""),
  },
  {
    mode: "wifi",
    label: "Wi-Fi",
    anchor: "wifi",
    summary:
      "A Wi-Fi QR code stores the network name, password and security type in one escaped string, so a phone can join without typing anything.",
    defaults: {
      ssid: "OfficeGuest",
      password: "S3cure;Pass,",
      security: "WPA",
      hidden: "false",
      identity: "",
    },
    fields: [
      { key: "ssid", label: "Network name (SSID)", type: "text", required: true },
      { key: "password", label: "Password", type: "text", required: true },
      {
        key: "security",
        label: "Security",
        type: "select",
        options: [
          { value: "WPA", label: "WPA / WPA2 / WPA3-Personal" },
          { value: "WEP", label: "WEP" },
          { value: "nopass", label: "Open network" },
          { value: "EAP", label: "WPA-Enterprise (802.1X)" },
        ],
      },
      {
        key: "identity",
        label: "Enterprise identity",
        type: "text",
        placeholder: "user@example.com",
        hint: "Only used for WPA-Enterprise. Most phone readers still ask for the CA certificate.",
      },
      {
        key: "hidden",
        label: "Hidden network",
        type: "checkbox",
        checkboxLabel: "Network does not broadcast its SSID",
      },
    ],
    notes: [
      "The four characters `\\` `;` `,` `:` must be backslash-escaped inside SSID and password, and the backslash has to be escaped first. This is the single most common cause of a Wi-Fi code that scans but reports the wrong password.",
      "The payload ends with a double semicolon `;;`. Some generators emit one; strict readers then fail to parse the trailing empty field.",
      "WPA3-Personal networks are joined by most current readers when you declare `T:WPA`, but a handful of older Android scanners only accept the exact `nopass` / `WPA` / `WEP` / `EAP` set — do not invent a `WPA3` token.",
      "Enterprise (802.1X) QR payloads are not uniformly supported: iOS and Android differ on whether the identity, method and certificate fields are honoured. For a guest event, use a separate WPA2-PSK network.",
      "A password containing a literal `;` is fine once escaped, but plain-text Wi-Fi codes are readable by anyone who photographs them — never encode the password of an admin network you cannot rotate.",
    ],
    build: wifiPayload,
  },
  {
    mode: "vcard",
    label: "vCard",
    anchor: "vcard",
    summary:
      "A vCard QR code is a contact record as text. The scanner offers to save it, so nothing has to be typed on the spot.",
    defaults: {
      first: "Ada",
      last: "Lovelace",
      org: "Analytical Engines",
      title: "Principal Engineer",
      phone: "+44 20 7946 0000",
      email: "ada@example.com",
      website: "example.com",
      note: "",
      city: "",
      country: "",
      address: "",
      postalCode: "",
      region: "",
      workPhone: "",
    },
    fields: [
      { key: "first", label: "First name", type: "text" },
      { key: "last", label: "Last name", type: "text" },
      { key: "org", label: "Company", type: "text" },
      { key: "title", label: "Job title", type: "text" },
      { key: "phone", label: "Mobile", type: "tel" },
      { key: "workPhone", label: "Work phone", type: "tel" },
      { key: "email", label: "Email", type: "email" },
      { key: "website", label: "Website", type: "text" },
      { key: "address", label: "Street", type: "text" },
      { key: "city", label: "City", type: "text" },
      { key: "region", label: "State / region", type: "text" },
      { key: "postalCode", label: "Post code", type: "text" },
      { key: "country", label: "Country", type: "text" },
      { key: "note", label: "Note", type: "textarea" },
    ],
    notes: [
      "Lines must end with CRLF (`\\r\\n`). Cards joined with LF only are accepted by some readers and silently dropped by others, most often on iOS Contacts.",
      "`N:` and `FN:` should both be present. `N:` is the sorted name (`last;first;;;`) and `FN:` is what gets displayed; a card with only `FN:` is rejected by stricter importers.",
      "Inside values, escape `\\` `;` `,` and use the literal two-character sequence `\\n` for a line break. Do not emit `VERSION:4.0` unless you also write its properties — `VERSION:3.0` is what every shipped reader understands.",
      "vCard 4.0 drops `TYPE=CELL` in favour of `WORK`/`CELL` text values and adds `UID`; mixing the two dialects in one card is a common way to produce a code that saves an empty contact.",
      "MeCard (`MECARD:N;ADR:TEL:EMAIL:URL:;;;`) is a shorter, older alternative that fits low-version symbols. It has no CRLF requirement and no escaping rules beyond `\\`, which is why badge-printing tools still use it.",
    ],
    build: vcardPayload,
  },
  {
    mode: "email",
    label: "Email",
    anchor: "email",
    summary:
      "An email QR code opens the user's mail app with the address, subject and body pre-filled. It does not send anything by itself.",
    defaults: {
      to: "hello@example.com",
      subject: "Question about the QR code",
      body: "Hi — I scanned your code and wanted to ask:",
      cc: "",
    },
    fields: [
      { key: "to", label: "Recipient", type: "email", required: true },
      { key: "subject", label: "Subject", type: "text" },
      { key: "body", label: "Body", type: "textarea" },
      { key: "cc", label: "Cc", type: "text" },
    ],
    notes: [
      "The payload is a `mailto:` URL, so subject and body are percent-encoded — spaces become `%20` and the payload grows fast. Roughly 1 in 6 of the printed size is text, the rest is escaping overhead.",
      "A few Android mail handlers ignore `body=` entirely. If the body carries your lead-generation questions, keep the same information on the landing page too.",
      "`mailto:` has no defined multi-recipient standard across readers; `?cc=` usually works, `?bcc=` is frequently stripped for policy reasons.",
    ],
    build: emailPayload,
  },
  {
    mode: "sms",
    label: "SMS",
    anchor: "sms",
    summary:
      "An SMS QR code pre-fills a message to a number. The user still presses send, and the text is sent from their own plan.",
    defaults: { number: "+447946000000", message: "Hi — sign me up for the standing desks." },
    fields: [
      { key: "number", label: "Destination number", type: "tel", required: true },
      { key: "message", label: "Pre-filled message", type: "textarea" },
    ],
    notes: [
      "`SMSTO:<number>:<text>` is the form iOS and Android readers both parse. `sms:<number>?body=` is iOS-only and `smsto:` is Android-flavoured; picking one of those two costs you the other platform.",
      "Use E.164 with a leading `+`. A number written `020 7946 0000` will be dialled as a local number by whoever scans it abroad.",
      "You cannot control the carrier's own SMS length limit. Anything over 160 GSM-7 characters is split into concatenated parts and may be truncated by the composing app.",
    ],
    build: smsPayload,
  },
  {
    mode: "text",
    label: "Plain text",
    anchor: "text",
    summary:
      "Plain text is what every other payload really is: a string. Version and error correction decide how much of it fits.",
    defaults: { value: "Booth 12 · demo runs every 30 minutes" },
    fields: [
      { key: "value", label: "Text", type: "textarea", required: true },
    ],
    notes: [
      "Byte mode is what the `qrcode` library uses unless the whole input is numeric or alphanumeric, so non-ASCII text costs one byte per character below U+0080 and two or three above it.",
      "A QR symbol maxes out at 2,953 bytes of UTF-8 text (version 40, level L). Past roughly 400 bytes the module size on a printed label becomes the limiting factor, not the format.",
      "Emoji and CJK text push the byte count up without pushing the character count; a 60-character Chinese string can need a version two higher than the same English one.",
    ],
    build: (v) => v.value || "",
  },
];

export const MODE_BY_ANCHOR = new Map(QR_MODES.map((m) => [m.anchor, m]));

export function getMode(mode: QrMode | string): QrModeSpec {
  return QR_MODES.find((m) => m.mode === mode) || QR_MODES[0];
}

export function buildPayload(mode: QrMode | string, values: Record<string, string>): string {
  const spec = getMode(mode);
  return spec.build(values).trimEnd();
}

/** UTF-8 byte length — the number a QR capacity table is actually about. */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

/** Nominal recovery share per level, as documented by ISO/IEC 18004. */
export const ECL_RECOVERY: Record<string, number> = {
  L: 0.07,
  M: 0.15,
  Q: 0.25,
  H: 0.3,
};

export interface CapacityRow {
  version: number;
  /** Byte mode only — the mode every payload on these pages actually lands in. */
  L: number;
  M: number;
  Q: number;
  H: number;
  note: string;
}

/**
 * Byte-mode capacity, in characters of UTF-8 text.
 *
 * Do not edit a number here from memory: `scripts/qr-roundtrip.mjs` re-derives every
 * cell by asking the encoder where each version stops fitting, and fails the build if
 * this table and the library disagree. (Alphanumeric and numeric modes hold more, which
 * is why the widely copied "4,296 bytes" figure is not a byte capacity at all — it is
 * version 40 level L in *alphanumeric* mode. The page says 2,953 and the guard proves it.)
 */
export const BYTE_CAPACITY: CapacityRow[] = [
  { version: 1, L: 17, M: 14, Q: 11, H: 7, note: "A short link, a tel: string, a Wi-Fi code with a simple password." },
  { version: 2, L: 32, M: 26, Q: 20, H: 14, note: "The usual landing zone for a URL with a couple of query parameters." },
  { version: 3, L: 53, M: 42, Q: 32, H: 24, note: "Still prints legibly on a 20 mm label." },
  { version: 4, L: 78, M: 62, Q: 46, H: 34, note: "A vCard with name, one phone number and an email." },
  { version: 5, L: 106, M: 84, Q: 60, H: 44, note: "Wi-Fi with a long WPA3 passphrase, or a MeCard." },
  { version: 10, L: 271, M: 213, Q: 151, H: 119, note: "A full vCard with address and note. Density starts to matter on paper." },
  { version: 20, L: 858, M: 666, Q: 482, H: 382, note: "Bulk text, a vCard with a logo. Needs a large print area." },
  { version: 40, L: 2953, M: 2331, Q: 1663, H: 1273, note: "The format maximum. 177 modules a side — do not try to scan this off a badge." },
];

/** Smallest version whose byte capacity holds `bytes` at the given level, or null. */
export function minVersionFor(bytes: number, level: "L" | "M" | "Q" | "H"): CapacityRow | null {
  return BYTE_CAPACITY.find((row) => row[level] >= bytes) || null;
}


export interface SafeZoneInput {
  /** Logo edge as a share of the symbol width, 0–100. */
  logoPercent: number;
  /** Extra white plate padding around the logo, as a share of the symbol width. */
  platePaddingPercent: number;
  /** Side length of the symbol in modules, e.g. 33 for version 4. */
  modules: number;
  /** `L`/`M`/`Q`/`H`, or the long names the `qrcode` package also accepts. */
  errorCorrectionLevel: string;
}

/** The `qrcode` package accepts long level names as well; the table is keyed by letter. */
const ECL_ALIAS: Record<string, string> = {
  low: "L",
  medium: "M",
  quartile: "Q",
  high: "H",
};

export interface SafeZoneReport {
  /** Share of the symbol area hidden by logo + plate, 0–1. */
  coveredArea: number;
  coveredModules: number;
  totalModules: number;
  /** How much of the chosen level's recovery budget the cover consumes, 0–1+. */
  budgetUsed: number;
  verdict: "safe" | "tight" | "risky";
  headline: string;
}

/**
 * How much of the code a centred overlay may hide.
 *
 * The geometry is exact (which module cells the plate rectangle overlaps); the
 * tolerance is a share of the error-correction budget, which is the honest way to
 * say "probably fine" without promising it. Nothing here replaces a real scan, and
 * the UI says so.
 */
export function safeZoneReport(input: SafeZoneInput): SafeZoneReport {
  const { logoPercent, platePaddingPercent, modules, errorCorrectionLevel } = input;
  const level = ECL_ALIAS[errorCorrectionLevel] ?? errorCorrectionLevel;
  const side = Math.min(1, (logoPercent + platePaddingPercent * 2) / 100);
  const coveredArea = side * side;

  const n = Math.max(21, Math.round(modules) || 21);
  const span = Math.ceil(side * n);
  const start = Math.floor((n - span) / 2);
  const end = Math.min(n, start + span);
  const coveredRows = Math.max(0, end - start);
  const coveredModules = coveredRows * coveredRows;
  const totalModules = n * n;

  const budget = ECL_RECOVERY[level] ?? 0.15;
  const budgetUsed = coveredArea / budget;
  const verdict: SafeZoneReport["verdict"] =
    budgetUsed <= 0.5 ? "safe" : budgetUsed <= 0.9 ? "tight" : "risky";

  const headline =
    verdict === "safe"
      ? `Covers ${(coveredArea * 100).toFixed(1)}% of the symbol area — level ${level} recovers about ${(budget * 100).toFixed(0)}%, so this sits inside the margin.`
      : verdict === "tight"
        ? `Covers ${(coveredArea * 100).toFixed(1)}% of the symbol area, which is most of what level ${level} can recover. Test on at least two phones before printing.`
        : `Covers ${(coveredArea * 100).toFixed(1)}% of the symbol area — beyond the ~${(budget * 100).toFixed(0)}% level ${level} can restore. Expect failed scans: shrink the overlay, shorten the payload, or raise the level.`;

  return {
    coveredArea,
    coveredModules,
    totalModules,
    budgetUsed,
    verdict,
    headline,
  };
}
