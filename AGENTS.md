# AGENTS.md - ComfyUI-LoraSlider-LM

ComfyUI custom node "LoRA Slider (LoraManager)": one bipolar strength slider per LoRA,
output as a `LORA_STACK` for LoRA Manager's Lora Loader. Talks to LoRA Manager only
through its HTTP routes (see README). User-facing docs live in `README.md`.

## Current state

_Last verified: 2026-10-30_

- **Status:** working; no version number, no tags, no Registry publish (no `pyproject.toml`), no CI. `git log` is the version record.
- **Works:** picker / text / Lora Pool import; per-row display name, drag or up/down reordering, lock, randomize; range auto-fill from LM's `usage_tips` (strength_min/max or strength_range), else parsed from the LoRA description.
- **In progress:** nothing.
- **Known gaps:** the frontend widget has no automated test (only `web/strength_parser.js` does); auto-fill runs only when a row is added, so an existing row does not pick up a range changed later in LM.
- **Deep docs:** none beyond `README.md`.

## Test

```
python -m pytest -q
node --test tests/strength_parser.test.mjs
```

`web/strength_parser.js` mirrors `nodes/metadata_parser.py`; keep the two in sync.
