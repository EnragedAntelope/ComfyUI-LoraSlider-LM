/*
 * Best-effort parser for a suggested strength range + what the low/high ends mean,
 * pulled from a LoRA's free-text description. Returns any subset of
 * { min, max, lowLabel, highLabel }; never throws.
 *
 * Deliberately conservative about labels: a wrong label is worse than the default
 * "Low"/"High". Anything this misses is what slider presets are for (see README).
 */

const NUM = "[-+]?(?:\\d+(?:\\.\\d+)?|\\.\\d+)";
const RANGE_RE = new RegExp(`(${NUM})\\s*(?:-|\\u2013|\\u2014|~|\\.\\.|to|through)\\s*(${NUM})`, "i");

// "-1.5 (young) to 2 (old)", "between -5 (very slim) and 4 (fat)": range and labels in one.
const LABELED_RANGE_RE = new RegExp(
  `(${NUM})\\s*\\(([^()]{1,60})\\)\\s*(?:-|\\u2013|\\u2014|~|to|through|and)\\s*(${NUM})\\s*\\(([^()]{1,60})\\)`,
  "i"
);

const CONTEXT_KEYWORDS = [
  "safe zone",
  "strength",
  "weight",
  "recommended",
  "range",
  "works best",
  "sweet spot",
];

const LABEL = "([A-Za-z][A-Za-z' \\-]{0,30}?)";
const LABEL_END = "(?=[.,;:()\\n]|\\band\\b|\\bbut\\b|\\bwhile\\b|$)";
const UNIT = "(?:\\s+(?:values?|weights?|strengths?|numbers?))?";
const MEANS = "\\s*(?:is|are|=|means?|for|:)\\s*";
// "Higher is thinner", "positive for rich", "Negative strength = smaller", "Positive weights: wide-angle"
const HIGH_RE = new RegExp(`\\b(?:higher|positive)${UNIT}${MEANS}${LABEL}${LABEL_END}`, "i");
const LOW_RE = new RegExp(`\\b(?:lower|negative)${UNIT}${MEANS}${LABEL}${LABEL_END}`, "i");
// "(-) Younger (+) Older"
const SIGN_HIGH_RE = new RegExp(`\\(\\+\\)\\s*${LABEL}${LABEL_END}`, "i");
const SIGN_LOW_RE = new RegExp(`\\(-\\)\\s*${LABEL}${LABEL_END}`, "i");
// "from modest to revealing", "Modest <-> Skimpy"
const FROM_TO_RE = /\bfrom\s+([a-z]{3,20})\s+to\s+([a-z]{3,20})\b/i;
const ARROW_RE = new RegExp("\\b([a-z]{3,20})\\s*(?:\\u2194|<->|<=>)\\s*([a-z]{3,20})\\b", "i");
const TYPOGRAPHIC_MINUS_RE = new RegExp("\\u2212", "g");

function stripHtml(text) {
  return String(text)
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(TYPOGRAPHIC_MINUS_RE, "-")
    .replace(/\s+/g, " ")
    .trim();
}

function toRange(a, b) {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  let min = Math.min(a, b);
  let max = Math.max(a, b);
  if (max - min === 0 || Math.abs(min) > 50 || Math.abs(max) > 50) return null;
  // A one-sided range ("0.5 to 1.2") still needs 0 on the slider: 0 means off.
  if (min > 0) min = 0;
  if (max < 0) max = 0;
  return { min, max };
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
  return toRange(parseFloat(match[1]), parseFloat(match[2]));
}

function cleanLabel(raw) {
  if (!raw) return null;
  // "low volume, thin hair" -> "low volume"
  let label = raw.split(",")[0].trim().replace(/[.,;:]+$/, "").trim();
  label = label.replace(/\b(than|the|a|an|more|less|very)\b\s*$/i, "").trim();
  return label && label.length <= 30 ? label : null;
}

function parseLabels(text) {
  const labels = {};
  const set = (key, raw) => {
    const c = !labels[key] && cleanLabel(raw);
    if (c) labels[key] = c;
  };
  const first = (re) => (text.match(re) || [])[1];
  set("highLabel", first(HIGH_RE));
  set("lowLabel", first(LOW_RE));
  set("highLabel", first(SIGN_HIGH_RE));
  set("lowLabel", first(SIGN_LOW_RE));
  const pair = text.match(ARROW_RE) || text.match(FROM_TO_RE);
  // "from time to time" is not a pair of opposites
  if (pair && pair[1].toLowerCase() !== pair[2].toLowerCase()) {
    set("lowLabel", pair[1]);
    set("highLabel", pair[2]);
  }
  return labels;
}

// Strength range the user set in LoRA Manager (a card's `usage_tips` JSON string).
// Explicit strength_min/strength_max win over the "a-b" strength_range shorthand,
// matching LM's own parseStrengthRange. Returns { min, max } or null.
export function parseUsageTipsRange(usageTips) {
  let tips = usageTips;
  if (typeof tips === "string") {
    try {
      tips = JSON.parse(tips);
    } catch (e) {
      return null;
    }
  }
  if (!tips || typeof tips !== "object") return null;
  const num = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(+v) ? null : +v);
  let min = num(tips.strength_min ?? tips.strengthMin);
  let max = num(tips.strength_max ?? tips.strengthMax);
  if (min === null || max === null) {
    const m = String(tips.strength_range ?? tips.strengthRange ?? "").match(RANGE_RE);
    if (m) {
      if (min === null) min = parseFloat(m[1]);
      if (max === null) max = parseFloat(m[2]);
    }
  }
  if (min === null || max === null || !(min < max)) return null;
  return { min, max };
}

export function parseStrengthHints(description) {
  if (!description) return {};
  try {
    const text = stripHtml(description);
    const labeled = text.match(LABELED_RANGE_RE);
    if (labeled) {
      const a = parseFloat(labeled[1]);
      const b = parseFloat(labeled[3]);
      const range = toRange(a, b);
      if (range) {
        const lowLabel = cleanLabel(a <= b ? labeled[2] : labeled[4]);
        const highLabel = cleanLabel(a <= b ? labeled[4] : labeled[2]);
        return Object.assign(range, lowLabel && { lowLabel }, highLabel && { highLabel });
      }
    }
    const result = {};
    const rng = parseRange(text);
    if (rng) Object.assign(result, rng);
    Object.assign(result, parseLabels(text));
    return result;
  } catch (e) {
    return {};
  }
}

// ---------------------------------------------------------------------------
// Slider presets: { "<lora file name, no extension>": { min, max, step, lowLabel,
// highLabel, displayName } }, every field optional. Stored outside this node in
// ComfyUI's user data folder as lora_slider_presets.json.
// ---------------------------------------------------------------------------

export function presetKey(name) {
  return String(name || "").replace(/\\/g, "/").split("/").pop().replace(/\.(safetensors|ckpt|pt|bin)$/i, "").toLowerCase();
}

// Returns the usable fields of the preset for `name`, or null. Bad fields are dropped.
export function findPreset(presets, name) {
  const key = presetKey(name);
  if (!presets || !key) return null;
  const hit = Object.keys(presets).find((k) => presetKey(k) === key);
  const raw = hit && presets[hit];
  if (!raw || typeof raw !== "object") return null;
  const out = {};
  const min = Number(raw.min);
  const max = Number(raw.max);
  if (raw.min != null && raw.max != null && min < max) Object.assign(out, { min, max });
  if (Number(raw.step) > 0) out.step = Number(raw.step);
  for (const k of ["lowLabel", "highLabel", "displayName"]) {
    if (typeof raw[k] === "string" && raw[k].trim()) out[k] = raw[k].trim();
  }
  return Object.keys(out).length ? out : null;
}
