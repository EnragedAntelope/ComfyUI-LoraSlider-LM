/*
 * Best-effort parser for suggested strength range + low/high meaning, pulled from a
 * LoRA's free-text description. Mirrors nodes/metadata_parser.py — keep the two in
 * sync. Returns any subset of { min, max, lowLabel, highLabel }; never throws.
 */

const NUM = "[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const RANGE_RE = new RegExp(`(${NUM})\\s*(?:-|–|—|~|\\.\\.|to|through)\\s*(${NUM})`, "i");

const CONTEXT_KEYWORDS = [
  "safe zone",
  "strength",
  "weight",
  "recommended",
  "range",
  "works best",
  "sweet spot",
];

const HIGH_RE =
  /(?:higher|high|positive|\+|max(?:imum)?|top)\b[^.\n]*?\b(?:is|are|=|means?|gives?|=>|->|:)\s*([A-Za-z][A-Za-z \-]{0,30}?)(?=[.,;\n]|\band\b|$)/i;
const LOW_RE =
  /(?:lower|low|negative|\bminus\b|-|min(?:imum)?|bottom)\b[^.\n]*?\b(?:is|are|=|means?|gives?|=>|->|:)\s*([A-Za-z][A-Za-z \-]{0,30}?)(?=[.,;\n]|\band\b|$)/i;

function stripHtml(text) {
  return String(text)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function parseRange(text) {
  const lowered = text.toLowerCase();
  let best = null;
  let bestPos = text.length + 1;
  for (const keyword of CONTEXT_KEYWORDS) {
    const start = lowered.indexOf(keyword);
    if (start === -1) continue;
    const window = text.slice(start, start + 80);
    const m = window.match(RANGE_RE);
    if (m && start < bestPos) {
      bestPos = start;
      best = m;
    }
  }
  const match = best || text.match(RANGE_RE);
  if (!match) return null;

  const a = parseFloat(match[1]);
  const b = parseFloat(match[2]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;

  const min = Math.min(a, b);
  const max = Math.max(a, b);
  if (max - min === 0 || Math.abs(min) > 50 || Math.abs(max) > 50) return null;
  return { min, max };
}

function cleanLabel(raw) {
  if (!raw) return null;
  let label = raw.trim().replace(/[.,;:]+$/, "").trim();
  label = label.replace(/\b(than|the|a|an|more|less|very)\b\s*$/i, "").trim();
  return label || null;
}

function parseLabels(text) {
  const labels = {};
  const high = text.match(HIGH_RE);
  if (high) {
    const c = cleanLabel(high[1]);
    if (c) labels.highLabel = c;
  }
  const low = text.match(LOW_RE);
  if (low) {
    const c = cleanLabel(low[1]);
    if (c) labels.lowLabel = c;
  }
  return labels;
}

export function parseStrengthHints(description) {
  if (!description) return {};
  try {
    const text = stripHtml(description);
    const result = {};
    const rng = parseRange(text);
    if (rng) Object.assign(result, rng);
    Object.assign(result, parseLabels(text));
    return result;
  } catch (e) {
    return {};
  }
}
