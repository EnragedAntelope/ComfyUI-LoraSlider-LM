// Run with:  node --test tests/strength_parser.test.mjs
// Verifies the JS parser mirror matches the Python parser behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStrengthHints, parseUsageTipsRange } from "../web/strength_parser.js";

test("sample Slender Slider description", () => {
  const r = parseStrengthHints(
    "Strength: Safe zone (-3 - +2.5), it can be pushed beyond that for extreme " +
      "ends of the weight spectrum. Higher is thinner."
  );
  assert.equal(r.min, -3);
  assert.equal(r.max, 2.5);
  assert.equal((r.highLabel || "").toLowerCase(), "thinner");
});

test("'to' separator", () => {
  const r = parseStrengthHints("Recommended strength 0.5 to 1.2 for best results.");
  assert.equal(r.min, 0.5);
  assert.equal(r.max, 1.2);
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

test("high/low labels", () => {
  const r = parseStrengthHints("Strength 0 to 2. Higher is muscular and lower is skinny.");
  assert.equal((r.highLabel || "").toLowerCase(), "muscular");
  assert.equal((r.lowLabel || "").toLowerCase(), "skinny");
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
