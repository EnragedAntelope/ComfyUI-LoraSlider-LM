"""ComfyUI-LoraSlider-LM

A self-contained LoRA *slider* node designed to sit alongside (but never modify)
ComfyUI-Lora-Manager. It adds per-LoRA bipolar sliders with editable min/max bounds,
semantic end-labels (e.g. "skinny" <-> "obese"), per-slider / bulk / locked
randomization, batch-add from a multi-select picker or a connected Lora Pool node,
and best-effort auto-fill of min/max from LoRA Manager's stored CivitAI metadata.

Integration with LoRA Manager happens purely through its public HTTP routes and the
shared ComfyUI types (POOL_CONFIG in, LORA_STACK out) -- no LoRA Manager modules are
imported, so this package stays decoupled and LoRA Manager remains untouched.
"""

try:
    # Normal path: ComfyUI imports this folder as a package.
    from .nodes.lora_slider_node import LoraSliderLM
except ImportError:
    # Fallback for environments that load this file without package context.
    import os
    import sys

    sys.path.insert(0, os.path.dirname(os.path.realpath(__file__)))
    from nodes.lora_slider_node import LoraSliderLM

NODE_CLASS_MAPPINGS = {
    LoraSliderLM.NAME: LoraSliderLM,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    LoraSliderLM.NAME: "LoRA Slider (LoraManager)",
}

# Frontend assets (DOM widget + styles) live here and are served by ComfyUI.
WEB_DIRECTORY = "./web"

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
