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
  1. **+ Add LoRAs** — a searchable multi-select picker backed by LM's library. Search
     by name *or path*: include a `/` (e.g. `turbo/slider`) to match folders.
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
- **Best-effort auto-fill of min/max (and labels) from metadata.** Slider LoRAs rarely
  expose their usable range as structured data — it's usually buried in the CivitAI
  description, e.g. *"Strength: Safe zone (-3 - +2.5) … Higher is thinner."* The node
  reads LM's stored description and parses the range + direction. Always editable via
  the per-row ⚙ config dialog; silently falls back to defaults when nothing is found.
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
| Picker search (by name or folder path) | `GET /api/lm/loras/relative-paths` |
| Expand a Lora Pool folder/tag selection | `POST /api/lm/loras/cycler-list` |
| Resolve a LoRA's file path | `GET /api/lm/loras/list` |
| Description for min/max parsing | `GET /api/lm/loras/model-description` |
| Apply the result to MODEL/CLIP | output `LORA_STACK` → LM's Lora Loader |

The browser widget fetches metadata and serializes everything it needs into the node's
saved value, so **execution requires no network and no LM imports**.

## Development

```
# Python (node + metadata parser)
python -m pytest

# JS (strength-parser mirror)
node --test tests/strength_parser.test.mjs
```

`nodes/metadata_parser.py` and `web/strength_parser.js` implement the same heuristics —
keep them in sync.

## License

MIT
