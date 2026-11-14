"""Tests for tools/slider_presets.py (dump LM metadata, validate + merge presets)."""

import json

from tools.slider_presets import dump, main, merge, validate


def _write_meta(folder, name, description, usage_tips="{}"):
    meta = {
        "model_name": name,
        "modelDescription": description,
        "usage_tips": usage_tips,
        "civitai": {"description": "<p>use from -2 to 3</p>", "trainedWords": ["tall"]},
    }
    (folder / f"{name}.metadata.json").write_text(json.dumps(meta), encoding="utf-8")


def test_dump_strips_html_and_skips_known(tmp_path):
    sub = tmp_path / "sub"
    sub.mkdir()
    _write_meta(tmp_path, "Height", "<p>Range <b>-5</b> (short) to +5 (tall)&nbsp;ok</p>")
    _write_meta(sub, "Known", "whatever")
    records = dump(str(tmp_path), {"known": {}}, 2500)
    assert [r["key"] for r in records] == ["Height"]
    assert records[0]["description"] == "Range -5 (short) to +5 (tall) ok"
    assert records[0]["version_note"] == "use from -2 to 3"
    assert records[0]["trained_words"] == ["tall"]
    assert "lora_manager_usage_tips" not in records[0]


def test_validate_accepts_good_and_rejects_bad():
    clean, problems = validate({"min": -5, "max": 5, "lowLabel": " short ", "highLabel": "tall"})
    assert problems == []
    assert clean == {"min": -5, "max": 5, "lowLabel": "short", "highLabel": "tall"}
    assert validate({"min": 5, "max": -5})[1]
    assert validate({"min": "-5", "max": 5})[1]
    assert validate({"min": -500, "max": 5})[1]
    assert validate({"lowLabel": "x" * 31})[1]
    assert validate({"min": -1, "max": 1, "value": 3})[1]
    assert validate({})[1]
    assert validate("nope")[1]


def test_merge_keeps_existing_unless_overwrite():
    existing = {"Height": {"min": -1, "max": 1}}
    generated = {"height": {"min": -5, "max": 5}, "Age": {"lowLabel": "young"}, "Bad": {"min": 2, "max": 1}}
    report = merge(generated, existing, overwrite=False)
    assert existing == {"Height": {"min": -1, "max": 1}, "Age": {"lowLabel": "young"}}
    assert report["kept"] == ["height"] and report["added"] == ["Age"] and len(report["rejected"]) == 1
    merge(generated, existing, overwrite=True)
    assert existing["height"] == {"min": -5, "max": 5} and "Height" not in existing


def test_cli_merge_backs_up_and_writes(tmp_path):
    presets = tmp_path / "lora_slider_presets.json"
    presets.write_text(json.dumps({"Old": {"min": -1, "max": 1}}), encoding="utf-8")
    generated = tmp_path / "generated.json"
    generated.write_text(json.dumps({"New": {"min": -2, "max": 2, "highLabel": "tall"}}), encoding="utf-8")
    assert main(["merge", str(generated), "--presets", str(presets)]) == 0
    assert set(json.loads(presets.read_text(encoding="utf-8"))) == {"Old", "New"}
    assert json.loads((tmp_path / "lora_slider_presets.json.bak").read_text(encoding="utf-8")) == {"Old": {"min": -1, "max": 1}}
