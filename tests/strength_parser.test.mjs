// Run with:  node --test tests/strength_parser.test.mjs
// Verifies the JS parser mirror matches the Python parser behavior.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseStrengthHints } from "../web/strength_parser.js";

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
