"""Unit tests for best-effort strength-range/label parsing."""

from nodes.metadata_parser import parse_strength_hints


def test_sample_slender_slider_description():
    text = (
        "Strength: Safe zone (-3 - +2.5), it can be pushed beyond that for extreme "
        "ends of the weight spectrum. Higher is thinner."
    )
    result = parse_strength_hints(text)
    assert result["min"] == -3.0
    assert result["max"] == 2.5
    assert result.get("highLabel", "").lower() == "thinner"


def test_to_separator_range():
    result = parse_strength_hints("Recommended strength 0.5 to 1.2 for best results.")
    assert result["min"] == 0.5
    assert result["max"] == 1.2


def test_tilde_separator_range():
    result = parse_strength_hints("weight ~ use -2~2")
    assert result["min"] == -2.0
    assert result["max"] == 2.0


def test_html_is_stripped():
    text = "<p>Strength range: <b>-1.5</b> to <b>1.5</b></p>"
    result = parse_strength_hints(text)
    assert result["min"] == -1.5
    assert result["max"] == 1.5


def test_high_low_labels():
    text = "Strength 0 to 2. Higher is muscular and lower is skinny."
    result = parse_strength_hints(text)
    assert result.get("highLabel", "").lower() == "muscular"
    assert result.get("lowLabel", "").lower() == "skinny"


def test_prefers_range_near_keyword():
    # An unrelated range ("512-768") precedes the real strength range.
    text = "Trained at 512-768 resolution. Strength: use -3 to 3."
    result = parse_strength_hints(text)
    assert result["min"] == -3.0
    assert result["max"] == 3.0


def test_absurd_range_rejected():
    result = parse_strength_hints("Trained on 1000-2000 images.")
    assert "min" not in result


def test_no_match_returns_empty():
    assert parse_strength_hints("A lovely style lora with no numbers.") == {}
    assert parse_strength_hints("") == {}
    assert parse_strength_hints(None) == {}
