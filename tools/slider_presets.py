"""Build slider presets from the metadata LoRA Manager already downloaded.

Two steps, with an LLM (or a person) in between -- see .claude/skills/slider-presets/SKILL.md:

    python tools/slider_presets.py dump  <lora_folder> --out descriptions.json
    python tools/slider_presets.py merge generated.json --presets <ComfyUI>/user/default/lora_slider_presets.json

``dump`` only READS LoRA Manager's ``*.metadata.json`` files. ``merge`` only writes the
presets file, which belongs to this node. Nothing here writes to LoRA Manager's data.
Standard library only.
"""

from __future__ import annotations

import argparse
import glob
import html
import json
import os
import re
import shutil
import sys
from typing import Any, Dict, List, Tuple

_SUFFIX = ".metadata.json"
_LABELS = {"lowLabel": 30, "highLabel": 30, "displayName": 60}  # field -> max length


def _plain(text: Any, limit: int) -> str:
    """HTML description -> single-line plain text, cut to ``limit`` characters."""
    text = html.unescape(re.sub(r"<[^>]+>", " ", str(text or "")))
    return re.sub(r"\s+", " ", text).strip()[:limit]


def dump(lora_dir: str, known: Dict[str, Any], max_chars: int) -> List[Dict[str, Any]]:
    """One compact record per LoRA under ``lora_dir`` that has no preset in ``known`` yet."""
    known_keys = {k.lower() for k in known}
    records = []
    pattern = os.path.join(glob.escape(lora_dir), "**", "*" + _SUFFIX)
    for path in sorted(glob.glob(pattern, recursive=True)):
        key = os.path.basename(path)[: -len(_SUFFIX)]
        if key.lower() in known_keys:
            continue
        try:
            with open(path, encoding="utf-8") as handle:
                meta = json.load(handle)
        except (OSError, ValueError) as exc:
            print(f"skipped {path}: {exc}", file=sys.stderr)
            continue
        civitai = meta.get("civitai") or {}
        record = {
            "key": key,
            "model_name": meta.get("model_name") or "",
            "trained_words": civitai.get("trainedWords") or [],
            "version_note": _plain(civitai.get("description"), 600),
            "description": _plain(meta.get("modelDescription"), max_chars),
        }
        if meta.get("usage_tips") not in (None, "", "{}", {}):
            record["lora_manager_usage_tips"] = meta["usage_tips"]
        records.append(record)
    return records


def validate(preset: Any) -> Tuple[Dict[str, Any], List[str]]:
    """Return (clean preset, problems). A preset with problems must not be merged."""
    if not isinstance(preset, dict):
        return {}, ["not an object"]
    clean: Dict[str, Any] = {}
    problems: List[str] = []

    def number(field: str) -> Any:
        value = preset.get(field)
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            problems.append(f"{field} is not a number")
            return None
        return value

    if "min" in preset or "max" in preset:
        low, high = number("min"), number("max")
        if low is not None and high is not None:
            if not low < high:
                problems.append("min must be below max")
            elif abs(low) > 50 or abs(high) > 50:
                problems.append("range beyond +/-50")
            else:
                clean["min"], clean["max"] = low, high
    if "step" in preset:
        step = number("step")
        if step is not None and step <= 0:
            problems.append("step must be above 0")
        elif step is not None:
            clean["step"] = step
    for field, limit in _LABELS.items():
        if field not in preset:
            continue
        value = preset[field]
        if not isinstance(value, str) or not value.strip() or len(value.strip()) > limit:
            problems.append(f"{field} must be 1-{limit} characters of text")
        else:
            clean[field] = value.strip()
    unknown = sorted(set(preset) - {"min", "max", "step", *_LABELS})
    if unknown:
        problems.append("unknown field(s): " + ", ".join(unknown))
    if not clean and not problems:
        problems.append("empty")
    return clean, problems


def merge(generated: Dict[str, Any], existing: Dict[str, Any], overwrite: bool) -> Dict[str, List[str]]:
    """Merge validated presets into ``existing`` in place. Returns a report."""
    report: Dict[str, List[str]] = {"added": [], "replaced": [], "kept": [], "rejected": []}
    by_lower = {k.lower(): k for k in existing}
    for key, preset in generated.items():
        clean, problems = validate(preset)
        if problems:
            report["rejected"].append(f"{key}: {'; '.join(problems)}")
            continue
        current = by_lower.get(key.lower())
        if current is not None and not overwrite:
            report["kept"].append(key)
            continue
        if current is not None:
            del existing[current]
        existing[key] = clean
        by_lower[key.lower()] = key
        report["replaced" if current is not None else "added"].append(key)
    return report


def _load_object(path: str) -> Dict[str, Any]:
    with open(path, encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must hold a JSON object")
    return data


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    p_dump = sub.add_parser("dump", help="collect LoRA descriptions for an LLM to read")
    p_dump.add_argument("lora_dir")
    p_dump.add_argument("--out", required=True, help="file to write the records to")
    p_dump.add_argument("--presets", help="existing presets file; LoRAs already in it are left out")
    p_dump.add_argument("--max-chars", type=int, default=2500, help="description length cap per LoRA")
    p_merge = sub.add_parser("merge", help="validate generated presets and add them to the presets file")
    p_merge.add_argument("generated")
    p_merge.add_argument("--presets", required=True, help="presets file to update (created if missing)")
    p_merge.add_argument("--overwrite", action="store_true", help="replace presets that already exist")
    args = parser.parse_args(argv)

    existing = _load_object(args.presets) if args.presets and os.path.exists(args.presets) else {}
    if args.command == "dump":
        records = dump(args.lora_dir, existing, args.max_chars)
        with open(args.out, "w", encoding="utf-8") as handle:
            json.dump(records, handle, indent=1, ensure_ascii=False)
        print(f"wrote {len(records)} record(s) to {args.out}")
        return 0

    report = merge(_load_object(args.generated), existing, args.overwrite)
    if report["added"] or report["replaced"]:
        if os.path.exists(args.presets):
            shutil.copyfile(args.presets, args.presets + ".bak")
        os.makedirs(os.path.dirname(os.path.abspath(args.presets)), exist_ok=True)
        with open(args.presets, "w", encoding="utf-8") as handle:
            json.dump(existing, handle, indent=2, ensure_ascii=False)
    for name in ("added", "replaced", "kept", "rejected"):
        print(f"{name}: {len(report[name])}")
    for line in report["rejected"]:
        print("  rejected " + line)
    return 1 if report["rejected"] else 0


if __name__ == "__main__":
    sys.exit(main())
