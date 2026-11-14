// Run with:  node --test tests/strength_parser.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { findPreset, parseStrengthHints, parseUsageTipsRange, presetKey } from "../web/strength_parser.js";

test("sample Slender Slider description", () => {
  const r = parseStrengthHints(
    "Strength: Safe zone (-3 - +2.5), it can be pushed beyond that for extreme " +
      "ends of the weight spectrum. Higher is thinner."
  );
  assert.equal(r.min, -3);
  assert.equal(r.max, 2.5);
  assert.equal((r.highLabel || "").toLowerCase(), "thinner");
});

test("one-sided range still includes 0 (off)", () => {
  assert.deepEqual(parseStrengthHints("Recommended strength 0.5 to 1.2 for best results."), { min: 0, max: 1.2 });
  assert.deepEqual(parseStrengthHints("Strength: -2 to -0.5"), { min: -2, max: 0 });
});

test("tilde separator", () => {
  const r = parseStrengthHints("weight ~ use -2~2");
  assert.equal(r.min, -2);
  assert.equal(r.max, 2);
});

test("html stripped", () => {
  const r = parseStrengthHints("<p>Strength range: <b>-1.5</b> to <b>1.5</b></p>");
  assert.equal(r.min, -1.5);
  assert.equal(r.max, 1.5);
});

test("typographic minus", () => {
  const minus = String.fromCharCode(0x2212);
  assert.deepEqual(parseStrengthHints(`No trigger word. Strength ${minus}2 to +2 .`), { min: -2, max: 2 });
});

test("labeled range gives range and labels", () => {
  assert.deepEqual(parseStrengthHints("Good results with values ranging from -1.5 (young) to 2 (old)."), {
    min: -1.5,
    max: 2,
    lowLabel: "young",
    highLabel: "old",
  });
  assert.deepEqual(parseStrengthHints("values between -5 (very slim) and 4 (fat). Up to 5 works."), {
    min: -5,
    max: 4,
    lowLabel: "very slim",
    highLabel: "fat",
  });
  const r = parseStrengthHints("weights from -3 (low volume, thin hair) to 3 (full, voluminous hair).");
  assert.equal(r.lowLabel, "low volume");
  assert.equal(r.highLabel, "full");
  // written high-to-low
  assert.deepEqual(parseStrengthHints("range +5 (tall) to -5 (short)"), {
    min: -5,
    max: 5,
    lowLabel: "short",
    highLabel: "tall",
  });
});

test("high/low labels", () => {
  const r = parseStrengthHints("Strength 0 to 2. Higher is muscular and lower is skinny.");
  assert.equal((r.highLabel || "").toLowerCase(), "muscular");
  assert.equal((r.lowLabel || "").toLowerCase(), "skinny");
});

test("positive/negative label phrasings", () => {
  const cases = [
    ["positive for rich, negative for poor", "poor", "rich"],
    ["Negative strength = smaller. Positive strength = bigger.", "smaller", "bigger"],
    ["Positive values: longer legs, shorter torso Negative values: shorter legs, longer torso", "shorter legs", "longer legs"],
    ["Controls the age. (-) Younger (+) Older except for version B", "Younger", "Older except for version B"],
    ["This slider changes the clothing from modest to revealing.", "modest", "revealing"],
    [`Control your outfit style (Modest ${String.fromCharCode(0x2194)} Skimpy).`, "Modest", "Skimpy"],
  ];
  for (const [text, low, high] of cases) {
    const r = parseStrengthHints(text);
    assert.equal(r.lowLabel, low, text);
    assert.equal(r.highLabel, high, text);
  }
});

test("prose that only mentions positive/negative gives no label", () => {
  const texts = [
    "The slider does have one negative side effect: unfortunately, it also alters the breast size.",
    "Use values from -3 to 3 but 2 is usually enough",
    "Recommended negative prompt: lowres, bad quality",
    "Negative values will pull toward illustration. Higher values will pull towards photos.",
    "It makes 3d-characters from time to time.",
    "At lower strengths it just gives photos a nice polish, while higher values push things.",
  ];
  for (const text of texts) {
    const r = parseStrengthHints(text);
    assert.equal(r.lowLabel, undefined, text);
    assert.equal(r.highLabel, undefined, text);
  }
});

test("prefers range near keyword", () => {
  const r = parseStrengthHints("Trained at 512-768 resolution. Strength: use -3 to 3.");
  assert.equal(r.min, -3);
  assert.equal(r.max, 3);
});

test("absurd range rejected", () => {
  const r = parseStrengthHints("Trained on 1000-2000 images.");
  assert.equal(r.min, undefined);
});

test("no match returns empty", () => {
  assert.deepEqual(parseStrengthHints("A lovely style lora."), {});
  assert.deepEqual(parseStrengthHints(""), {});
  assert.deepEqual(parseStrengthHints(null), {});
});

test("LM usage_tips: explicit min/max win over strength_range", () => {
  assert.deepEqual(
    parseUsageTipsRange('{"strength_min": -2, "strength_max": 1.5, "strength_range": "0.3-0.8"}'),
    { min: -2, max: 1.5 }
  );
  assert.deepEqual(parseUsageTipsRange({ strengthMin: "0.2", strengthMax: "0.9" }), { min: 0.2, max: 0.9 });
});

test("LM usage_tips: strength_range shorthand and bad input", () => {
  assert.deepEqual(parseUsageTipsRange('{"strength_range": "0.3-0.8"}'), { min: 0.3, max: 0.8 });
  assert.deepEqual(parseUsageTipsRange('{"strength_range": "-3 - 2.5"}'), { min: -3, max: 2.5 });
  assert.equal(parseUsageTipsRange("{}"), null);
  assert.equal(parseUsageTipsRange('{"strength": 0.6}'), null);
  assert.equal(parseUsageTipsRange('{"strength_min": 1, "strength_max": 0.5}'), null);
  assert.equal(parseUsageTipsRange("not json"), null);
  assert.equal(parseUsageTipsRange(null), null);
  assert.equal(parseUsageTipsRange(""), null);
});

test("presets: matched by file name, any folder, any case", () => {
  assert.equal(presetKey("krea2\\slider\\Height_v1.safetensors"), "height_v1");
  const presets = {
    Height_v1: { min: -5, max: 5, lowLabel: "short", highLabel: "tall", displayName: "Height" },
    inverted: { min: 3, max: -3, lowLabel: " thin " },
    junk: { min: "a", max: null, lowLabel: 5 },
  };
  assert.deepEqual(findPreset(presets, "krea2/slider/height_V1"), {
    min: -5,
    max: 5,
    lowLabel: "short",
    highLabel: "tall",
    displayName: "Height",
  });
  assert.deepEqual(findPreset(presets, "inverted"), { lowLabel: "thin" });
  assert.equal(findPreset(presets, "junk"), null);
  assert.equal(findPreset(presets, "missing"), null);
  assert.equal(findPreset(null, "Height_v1"), null);
});
