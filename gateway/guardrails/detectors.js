// Onyx Gateway: guardrail detectors. Each finds sensitive values in a piece of text; the scanner
// decides what happens to them (flag, redact or block). A match is never logged or returned:
// only the detector's name and a count leave this module's callers.

/** Luhn checksum over the digits of a string. */
export function luhn(digits) {
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    dbl = !dbl;
  }
  return digits.length > 0 && sum % 10 === 0;
}

const onlyDigits = (s) => s.replace(/\D/g, "");

/**
 * Built-in detectors. `re` must be global; `valid` (optional) filters raw matches.
 * `label` is the placeholder stem: [EMAIL_1], [CARD_2]…
 */
export const BUILTIN = [
  {
    id: "email",
    name: "Email address",
    label: "EMAIL",
    re: /\b[A-Za-z0-9._%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}\b/g,
  },
  {
    id: "phone",
    name: "Phone number",
    label: "PHONE",
    // North American and international numbers with separators; bare digit runs are left alone
    // (they're far more often IDs, counts or timestamps).
    re: /(?<![\w+])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{3}\)\s?|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?!\w)/g,
  },
  {
    id: "card",
    name: "Payment card",
    label: "CARD",
    re: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g,
    valid: (m) => {
      const d = onlyDigits(m);
      return d.length >= 13 && d.length <= 19 && /^[2-6]/.test(d) && luhn(d);
    },
  },
  {
    id: "ssn",
    name: "US Social Security number",
    label: "SSN",
    re: /(?<![\d-])(\d{3})-(\d{2})-(\d{4})(?![\d-])/g,
    valid: (m) => {
      const [a, b, c] = m.split("-");
      return a !== "000" && a !== "666" && a[0] !== "9" && b !== "00" && c !== "0000";
    },
  },
  {
    id: "sin",
    name: "Canadian Social Insurance number",
    label: "SIN",
    re: /(?<![\d-])\d{3}[ -]\d{3}[ -]\d{3}(?![\d-])/g,
    // Luhn only: CRA's own examples start with 0, and detecting more is the safe side.
    valid: (m) => luhn(onlyDigits(m)),
  },
  {
    id: "secret",
    name: "Secrets and keys",
    label: "SECRET",
    re: new RegExp(
      [
        String.raw`\b(?:AKIA|ASIA)[0-9A-Z]{16}\b`, // AWS access key ID
        String.raw`\bgh[pousr]_[A-Za-z0-9]{36,255}\b`, // GitHub tokens
        String.raw`\bgithub_pat_[A-Za-z0-9_]{22,255}\b`,
        String.raw`\bxox[abposr]-[A-Za-z0-9-]{10,200}\b`, // Slack tokens
        String.raw`-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----[\s\S]{0,8192}?-----END (?:[A-Z]+ )?PRIVATE KEY-----`,
        String.raw`\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}\b`, // Anthropic, OpenAI, OpenRouter
        String.raw`\bsdgw_[A-Za-z0-9_-]{20,}\b`, // this Gateway's own keys
      ].join("|"),
      "g"
    ),
  },
];

export const BUILTIN_IDS = BUILTIN.map((d) => d.id);

/**
 * Compile an Admin's regex detector. Throws a message fit for the UI when it's unusable.
 * @param {{ id: string, name: string, pattern: string, flags?: string }} d
 */
export function compileCustom(d) {
  const pattern = String(d.pattern || "");
  if (!pattern) throw new Error("Enter a pattern.");
  if (pattern.length > 1000) throw new Error("Keep the pattern under 1,000 characters.");
  const flags = String(d.flags || "").replace(/[^imsu]/g, "");
  let re;
  try {
    re = new RegExp(pattern, `g${flags}`);
  } catch (err) {
    throw new Error(`That pattern isn't a valid regular expression: ${err.message}`);
  }
  if (re.test("")) throw new Error("That pattern matches empty text, so it would match everywhere.");
  const label = String(d.name || d.id).toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 24) || "CUSTOM";
  return { id: d.id, name: d.name, label, re, custom: true };
}

/**
 * Every match of one detector in a text, as [start, end) ranges, overlapping matches dropped.
 * @returns {Array<{ start: number, end: number, value: string }>}
 */
export function findAll(detector, text) {
  const out = [];
  if (!text) return out;
  const re = new RegExp(detector.re.source, detector.re.flags.includes("g") ? detector.re.flags : `${detector.re.flags}g`);
  let m;
  let guard = 0;
  while ((m = re.exec(text)) && guard++ < 10_000) {
    if (m[0] === "") {
      re.lastIndex++;
      continue;
    }
    if (detector.valid && !detector.valid(m[0])) continue;
    out.push({ start: m.index, end: m.index + m[0].length, value: m[0] });
  }
  return out;
}
