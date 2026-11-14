# AGENTS.md - ComfyUI-LoraSlider-LM

ComfyUI custom node "LoRA Slider (LoraManager)": one bipolar strength slider per LoRA,
output as a `LORA_STACK` for LoRA Manager's Lora Loader. Talks to LoRA Manager only
through its HTTP routes (see README). User-facing docs live in `README.md`.

## Current state

_Last verified: 2026-11-14_

- **Status:** working; no version number, no tags, no Registry publish (no `pyproject.toml`), no CI. `git log` is the version record.
- **Works:** picker (search, folder dropdown, select all) / text / Lora Pool import; per-row display name, drag or up/down reordering, lock, randomize; auto-fill of range and labels from LM's `usage_tips`, slider presets, or the LoRA description; "Save as preset" and "Re-apply presets"; `tools/slider_presets.py` to build presets with an LLM.
- **In progress:** nothing.
- **Known gaps:** the frontend widget has no automated test (only `web/strength_parser.js` does), and the picker, preset save and re-apply paths were exercised on 2026-11-14 only in a standalone browser harness against live LoRA Manager routes, not inside a ComfyUI graph; the `trigger_words` output is always empty because no code fills a row's `triggerWords`.
- **Deep docs:** `README.md`; `.claude/skills/slider-presets/SKILL.md` (LLM preset procedure).

## Test

```
python -m pytest -q
node --test tests/strength_parser.test.mjs
```

## Constraints

- LoRA Manager is someone else's project. Only call its read routes; never write to
  its data, its folders or its `*.metadata.json` files, and never import its code.
- `local/` is gitignored and holds generated presets for a personal library. Do not
  commit preset lists.
