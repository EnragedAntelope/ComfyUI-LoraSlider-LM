"""LoRA Slider node.

The heavy lifting (picking LoRAs, fetching metadata, parsing suggested min/max,
randomizing, expanding a Lora Pool folder) all happens in the browser widget at
edit-time and is serialized into the ``sliders`` widget value. By the time this node
executes, it only has to read that value and emit a ``LORA_STACK`` -- so execution
needs no network access and no LoRA Manager imports.

Output ``LORA_STACK`` is the de-facto ComfyUI convention: a list of
``(lora_name, model_strength, clip_strength)`` tuples. It plugs directly into LoRA
Manager's "Lora Loader (LoraManager)" ``lora_stack`` input, which re-resolves each
name through its own cache and applies it to MODEL/CLIP.
"""

from __future__ import annotations

import json
import logging
import random
from typing import Any, Dict, List, Tuple

logger = logging.getLogger(__name__)

# A sentinel default so the node still validates if the widget value never arrives.
_EMPTY_SLIDERS: List[Dict[str, Any]] = []


def _unwrap_sliders(sliders: Any) -> List[Dict[str, Any]]:
    """Accept either a raw list or the ``{"__value__": [...]}`` wrapper that some
    LoRA Manager widgets use, and always return a list of slider dicts."""
    if isinstance(sliders, dict) and "__value__" in sliders:
        sliders = sliders["__value__"]
    if isinstance(sliders, list):
        return sliders
    return _EMPTY_SLIDERS


def _coerce_float(value: Any, default: float) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _clamp(value: float, low: float, high: float) -> float:
    # Tolerate min/max supplied in either order.
    lo, hi = (low, high) if low <= high else (high, low)
    return max(lo, min(hi, value))


def _snap(value: float, low: float, step: float) -> float:
    """Snap a value to the nearest step offset from ``low`` (matches the widget)."""
    if not step or step <= 0:
        return value
    return round(round((value - low) / step) * step + low, 4)


def _random_in_range(low: float, high: float, step: float) -> float:
    lo, hi = (low, high) if low <= high else (high, low)
    return _clamp(_snap(random.uniform(lo, hi), lo, step), lo, hi)


def _trigger_words_to_list(raw: Any) -> List[str]:
    """Trigger words may be stored as a comma-separated string or a list."""
    if not raw:
        return []
    if isinstance(raw, str):
        parts = raw.split(",")
    elif isinstance(raw, (list, tuple)):
        parts = []
        for item in raw:
            parts.extend(str(item).split(","))
    else:
        return []
    return [p.strip() for p in parts if p and p.strip()]


class LoraSliderLM:
    """Manual + randomizable per-LoRA strength sliders -> LORA_STACK."""

    NAME = "LoRA Slider (LoraManager)"
    CATEGORY = "Lora Slider"

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Custom DOM widget value (see web/lora_slider_widget.js).
                "sliders": ("LORA_SLIDERS", {}),
                # When on, re-roll which (unlocked) LoRAs are enabled on every queue.
                "randomize_active_each_run": (
                    "BOOLEAN",
                    {"default": False, "label_on": "active: random each run",
                     "label_off": "active: as set"},
                ),
                # When on, re-roll the strength of every enabled, unlocked slider on
                # every queue (within each slider's min/max).
                "randomize_strength_each_run": (
                    "BOOLEAN",
                    {"default": False, "label_on": "strength: random each run",
                     "label_off": "strength: as set"},
                ),
            },
            "optional": {
                # Optional config from LoRA Manager's "Lora Pool (LoraManager)" node.
                # Carried through so the widget's "Import from Pool" button can read it;
                # not required for execution.
                "pool_config": ("POOL_CONFIG", {}),
            },
        }

    RETURN_TYPES = ("LORA_STACK", "STRING")
    RETURN_NAMES = ("LORA_STACK", "trigger_words")
    FUNCTION = "build"
    OUTPUT_NODE = False

    @classmethod
    def IS_CHANGED(
        cls,
        sliders: Any = None,
        randomize_active_each_run: bool = False,
        randomize_strength_each_run: bool = False,
        pool_config: Any = None,
    ):
        # Force re-execution every queue while any "each run" mode is on, otherwise
        # report a stable fingerprint so the node only re-runs when sliders change.
        if randomize_active_each_run or randomize_strength_each_run:
            return random.random()
        try:
            rows = _unwrap_sliders(sliders)
            fingerprint = [
                (
                    r.get("name"),
                    r.get("value"),
                    r.get("active", True),
                    r.get("clipStrength"),
                    r.get("min"),
                    r.get("max"),
                )
                for r in rows
                if isinstance(r, dict)
            ]
            return json.dumps(fingerprint, sort_keys=True)
        except Exception:
            return random.random()

    def build(
        self,
        sliders: Any,
        randomize_active_each_run: bool = False,
        randomize_strength_each_run: bool = False,
        pool_config: Any = None,
    ) -> Tuple[List, str]:
        sliders = _unwrap_sliders(sliders)

        lora_stack: List[Tuple[str, float, float]] = []
        collected_words: List[str] = []
        seen_words = set()

        for entry in sliders:
            if not isinstance(entry, dict):
                continue

            name = entry.get("name")
            if not name or name == "None":
                continue

            locked = entry.get("locked", False)
            active = entry.get("active", True)

            # Locked sliders are NEVER touched by any randomization.
            if randomize_active_each_run and not locked:
                active = random.random() < 0.5
            if not active:
                continue

            low = _coerce_float(entry.get("min", -3.0), -3.0)
            high = _coerce_float(entry.get("max", 3.0), 3.0)
            step = _coerce_float(entry.get("step", 0.05), 0.05)

            if randomize_strength_each_run and not locked:
                value = _random_in_range(low, high, step)
            else:
                value = _clamp(_coerce_float(entry.get("value", 0.0), 0.0), low, high)

            # A slider parked at exactly 0 contributes nothing; skip to avoid loading
            # a LoRA at zero strength (matches the Flex slider's behavior).
            if value == 0:
                continue

            clip_value = _coerce_float(entry.get("clipStrength", value), value)

            lora_stack.append((name, value, clip_value))

            for word in _trigger_words_to_list(entry.get("triggerWords")):
                key = word.lower()
                if key not in seen_words:
                    seen_words.add(key)
                    collected_words.append(word)

        trigger_words = ", ".join(collected_words)
        logger.debug(
            "LoraSliderLM: emitting %d active lora(s); %d trigger word(s)",
            len(lora_stack),
            len(collected_words),
        )
        return (lora_stack, trigger_words)
