"""Unit tests for the LoraSliderLM node's build() -> LORA_STACK logic."""

import random

from nodes.lora_slider_node import LoraSliderLM


def build(sliders, pool_config=None, **kwargs):
    return LoraSliderLM().build(sliders, pool_config=pool_config, **kwargs)


def test_basic_active_slider_emits_tuple():
    stack, words = build([
        {"name": "folder/lora_a", "value": 1.5, "min": -3, "max": 3, "active": True},
    ])
    assert stack == [("folder/lora_a", 1.5, 1.5)]
    assert words == ""


def test_inactive_slider_excluded():
    stack, _ = build([
        {"name": "a", "value": 1.0, "active": False},
        {"name": "b", "value": 1.0, "active": True},
    ])
    assert stack == [("b", 1.0, 1.0)]


def test_value_clamped_to_min_max():
    stack, _ = build([
        {"name": "hi", "value": 99, "min": -3, "max": 2.5, "active": True},
        {"name": "lo", "value": -99, "min": -3, "max": 2.5, "active": True},
    ])
    assert stack == [("hi", 2.5, 2.5), ("lo", -3.0, -3.0)]


def test_min_max_supplied_reversed_is_tolerated():
    stack, _ = build([
        {"name": "x", "value": 5, "min": 3, "max": -3, "active": True},
    ])
    # Range normalized to [-3, 3]; value 5 clamps to 3.
    assert stack == [("x", 3.0, 3.0)]


def test_zero_value_is_skipped():
    stack, _ = build([
        {"name": "zero", "value": 0, "min": -3, "max": 3, "active": True},
        {"name": "nonzero", "value": -1.2, "min": -3, "max": 3, "active": True},
    ])
    assert stack == [("nonzero", -1.2, -1.2)]


def test_separate_clip_strength_respected():
    stack, _ = build([
        {"name": "x", "value": 1.0, "clipStrength": 0.4, "min": -3, "max": 3, "active": True},
    ])
    assert stack == [("x", 1.0, 0.4)]


def test_trigger_words_aggregated_and_deduped():
    stack, words = build([
        {"name": "a", "value": 1, "active": True, "triggerWords": "slender, thin"},
        {"name": "b", "value": 1, "active": True, "triggerWords": ["Thin", "tall"]},
    ])
    assert len(stack) == 2
    # "thin"/"Thin" deduped case-insensitively; first-seen casing kept.
    assert words == "slender, thin, tall"


def test_wrapped_value_format_supported():
    stack, _ = build({"__value__": [{"name": "a", "value": 1, "active": True}]})
    assert stack == [("a", 1.0, 1.0)]


def test_garbage_entries_ignored():
    stack, _ = build([None, 42, {"value": 1, "active": True}, {"name": "ok", "value": 1, "active": True}])
    # entry with no name skipped; only "ok" survives
    assert stack == [("ok", 1.0, 1.0)]


def test_empty_and_non_list_inputs():
    assert build([]) == ([], "")
    assert build(None) == ([], "")
    assert build("nonsense") == ([], "")


def test_input_types_shape():
    it = LoraSliderLM.INPUT_TYPES()
    assert "sliders" in it["required"]
    assert it["required"]["sliders"][0] == "LORA_SLIDERS"
    assert it["required"]["randomize_active_each_run"][0] == "BOOLEAN"
    assert it["required"]["randomize_strength_each_run"][0] == "BOOLEAN"
    assert it["optional"]["pool_config"][0] == "POOL_CONFIG"
    assert LoraSliderLM.RETURN_TYPES == ("LORA_STACK", "STRING")


# --- each-run randomization ------------------------------------------------

def test_randomize_strength_each_run_stays_in_range_and_respects_lock():
    random.seed(1)
    rows = [
        {"name": "free", "value": 1.0, "min": -3, "max": 3, "step": 0.05, "active": True},
        {"name": "locked", "value": 1.0, "min": -3, "max": 3, "active": True, "locked": True},
    ]
    for _ in range(50):
        stack, _w = build(rows, randomize_strength_each_run=True)
        by_name = {n: (m, c) for (n, m, c) in stack}
        # locked slider always emits its fixed value
        assert by_name["locked"] == (1.0, 1.0)
        # free slider varies but stays within [-3, 3]
        assert -3.0 <= by_name["free"][0] <= 3.0


def test_randomize_active_each_run_never_disables_locked():
    random.seed(2)
    rows = [
        {"name": "free", "value": 1.0, "min": -3, "max": 3, "active": True},
        {"name": "locked_on", "value": 1.0, "min": -3, "max": 3, "active": True, "locked": True},
    ]
    seen_free_absent = False
    for _ in range(50):
        stack, _w = build(rows, randomize_active_each_run=True)
        names = {n for (n, _m, _c) in stack}
        # locked-on slider is always present
        assert "locked_on" in names
        if "free" not in names:
            seen_free_absent = True
    # over many rolls the unlocked slider should sometimes be disabled
    assert seen_free_absent


def test_is_changed_forces_rerun_only_when_each_run_enabled():
    rows = [{"name": "a", "value": 1, "active": True}]
    # stable when no each-run mode
    a = LoraSliderLM.IS_CHANGED(rows, False, False)
    b = LoraSliderLM.IS_CHANGED(rows, False, False)
    assert a == b
    # changes (almost surely) when an each-run mode is on
    c = LoraSliderLM.IS_CHANGED(rows, False, True)
    d = LoraSliderLM.IS_CHANGED(rows, False, True)
    assert c != d
