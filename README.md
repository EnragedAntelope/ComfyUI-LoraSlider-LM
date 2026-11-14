# ComfyUI-LoraSlider-LM

A self-contained **LoRA Slider** node for ComfyUI that is designed to sit alongside
[ComfyUI-Lora-Manager](https://github.com/willmiao/ComfyUI-Lora-Manager) (LM) and
reuse its rich metadata — **without modifying LM in any way**.

It brings the slider UX of
[ComfyUI-Flex-Pack](https://github.com/Wonderflex/ComfyUI-Flex-Pack) into the LM
ecosystem, while fixing Flex's biggest pain point: adding and configuring sliders one
at a time.

## What it does

- **One bipolar strength slider per LoRA**, with editable **min/max** bounds and
  **semantic end-labels** — e.g. label the low end *"skinny"* and the high end
  *"obese"*. The slider shows the **actual strength value** (not a 0–100 %).
- Give each row a custom **Display Name** without changing its real LoRA filename.
  Reorder rows with the ⠿ drag handle or the ↑ / ↓ buttons; `LORA_STACK` preserves
  that order.
- **Batch-add many LoRAs at once**, three ways:
  1. **+ Add LoRAs** - a searchable multi-select picker backed by LM's library. Pick a
     **folder** from the dropdown to list everything in it (subfolders included), then
     **Select all shown** and untick what you do not want. Or search by name *or path*:
     include a `/` (e.g. `turbo/slider`) to match folders.
  2. **+ Text** — type names or paste `<lora:folder/name:0.8>` codes (e.g. copied from
     the LoRA Manager UI); each becomes a slider.
  3. **Import from Pool** — connect LM's **Lora Pool** node and pull in *every* LoRA
     matched by its folder/tag filters.
- **Set values manually** (drag the slider continuously or type a number), or **randomize**:
  - per-slider 🎲, or **🎲 Strength** (all unlocked) — re-roll strengths in range;
  - **🎲 Enabled** — randomly enable/disable each unlocked slider;
  - **randomize each run** toggles — re-roll strength and/or enabled state on *every*
    queued run (great for batch variation);
  - 🔒 **lock** any slider and it is **never** touched by any randomize (manual or
    each-run).
- **Uses the strength range you set in LoRA Manager.** If a LoRA has a Strength Min/Max
  (or strength range) in LM's usage tips, a newly added slider takes that range.
- **Slider presets: range, end labels and display name remembered per LoRA.** See
  [Slider presets](#slider-presets) below.
- **Otherwise, best-effort auto-fill of min/max (and labels) from metadata.** Slider LoRAs
  rarely expose their usable range as structured data; it is usually buried in the CivitAI
  description, e.g. *"Good results from -1.5 (young) to 2 (old)"* or *"Strength: Safe zone
  (-3 - +2.5) ... Higher is thinner."* The node reads LM's stored description and parses
  the range + direction. Labels are only taken from clear phrasings; when nothing is
  found the slider keeps its defaults. Always editable via the per-row gear dialog.
- **Re-apply presets** re-reads all of the above for every unlocked slider already on
  the node (for example after you add presets or change a range in LM).
- Outputs a standard **`LORA_STACK`** (+ aggregated `trigger_words`) that plugs
  straight into LM's **Lora Loader (LoraManager)**.

## Install

Clone into your `ComfyUI/custom_nodes/` directory (next to `ComfyUI-Lora-Manager`):

```
cd ComfyUI/custom_nodes
git clone https://github.com/EnragedAntelope/ComfyUI-LoraSlider-LM
```

Restart ComfyUI. The node appears under the **Lora Slider** category as
**LoRA Slider (LoraManager)**. ComfyUI-Lora-Manager must be installed and running for
the picker / pool import / metadata auto-fill features (they call LM's HTTP routes);
the node still works for manual sliders without them.

## Slider presets

A preset stores a LoRA's `min`, `max`, `step`, `lowLabel`, `highLabel` and `displayName`
(all optional). When you add that LoRA to any slider node, in any workflow, the preset
is applied. Presets are matched by file name, so they survive moving a LoRA to another
folder.

They live in one file that belongs to this node, in ComfyUI's own user folder:
`ComfyUI/user/default/lora_slider_presets.json`. Nothing is written to LoRA Manager.

```json
{
  "Height_Slider_v2": {"min": -5, "max": 5, "lowLabel": "short", "highLabel": "tall", "displayName": "Height"}
}
```

Order of precedence when a slider is filled in: for the range, a strength range you set
in LoRA Manager, then the preset, then the description; for labels and display name,
the preset, then the description.

Three ways to get presets:

1. **By hand, inside ComfyUI.** Set a slider up in the gear dialog and click
   **Save as preset**.
2. **With an LLM, outside ComfyUI.** The regex parser cannot read prose like *"at
   higher strengths the waist gets implausible"*; an LLM can. `tools/slider_presets.py`
   collects the descriptions LoRA Manager already downloaded (read-only), and merges the
   presets the LLM writes back, validated, without replacing presets you already have.
   The full procedure and the labeling rules are in
   [.claude/skills/slider-presets/SKILL.md](.claude/skills/slider-presets/SKILL.md);
   Claude Code picks that skill up on its own, any other LLM can be pointed at the file.
3. **Edit the JSON file** directly.

## Typical wiring

```
Lora Pool (LoraManager) ──POOL_CONFIG──▶ LoRA Slider ──LORA_STACK──▶ Lora Loader (LoraManager) ──▶ KSampler
                                              └────────▶ trigger_words (STRING)
```

## How it stays decoupled from LoRA Manager

This package imports **no** LM Python modules and patches **nothing**. All integration
is through LM's public HTTP API and shared ComfyUI types:

| Need | LM route / mechanism |
| --- | --- |
| Picker search (by name or folder path), folder listing | `GET /api/lm/loras/relative-paths` |
| Picker folder dropdown | `GET /api/lm/loras/folders` |
| Expand a Lora Pool folder/tag selection | `POST /api/lm/loras/cycler-list` |
| Resolve a LoRA's file path and LM strength range (`usage_tips`) | `GET /api/lm/loras/list` |
| Description for min/max parsing | `GET /api/lm/loras/model-description` |
| Apply the result to MODEL/CLIP | output `LORA_STACK` → LM's Lora Loader |

Every LM route used is a read (the pool query is a `POST` that only reads). The node
never calls a route that changes LM's data, and never writes into LM's folders. Presets
are stored through ComfyUI's own `/userdata` route, not LM.

The browser widget fetches metadata and serializes everything it needs into the node's
saved value, so **execution requires no network and no LM imports**.

## Development

```
# Python (node + preset tool)
python -m pytest -q

# JS (description parser + preset lookup)
node --test tests/strength_parser.test.mjs
```

## License

MIT
