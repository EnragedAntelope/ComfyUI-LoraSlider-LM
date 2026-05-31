"""Best-effort extraction of suggested strength ranges (and what the low/high ends
*mean*) from a LoRA's free-text description.

Slider LoRAs almost never expose their usable range as structured metadata; it is
usually buried in the CivitAI model description, e.g.:

    "Strength: Safe zone (-3 - +2.5), it can be pushed beyond that for extreme ends
     of the weight spectrum. Higher is thinner."

This module pulls ``min``/``max`` and optional ``lowLabel``/``highLabel`` out of such
prose. It is intentionally forgiving: on no confident match it returns an empty dict
and the widget falls back to its defaults. The same heuristics are mirrored in
``web/lora_slider_widget.js`` (keep them in sync).
"""

from __future__ import annotations

import re
from typing import Dict, Optional

# A signed decimal, e.g. "-3", "+2.5", "1", ".5"
_NUM = r"[-+]?(?:\d+(?:\.\d+)?|\.\d+)"

# A range: NUM <sep> NUM, where sep is a dash/tilde/"to"/"through"/".." (with optional
# surrounding whitespace). Handles the awkward "-3 - +2.5" case (signs + dash sep).
_RANGE_RE = re.compile(
    rf"({_NUM})\s*(?:-|–|—|~|\.\.|to|through)\s*({_NUM})",
    re.IGNORECASE,
)

# Keywords that tend to sit next to the *intended* range, so we search near them first.
_CONTEXT_KEYWORDS = (
    "safe zone",
    "strength",
    "weight",
    "recommended",
    "range",
    "works best",
    "sweet spot",
)

# "higher is thinner", "high = obese", "positive means bigger"
_HIGH_RE = re.compile(
    r"(?:higher|high|positive|\+|max(?:imum)?|top)\b[^.\n]*?\b(?:is|are|=|means?|gives?|=>|->|:)\s*([A-Za-z][A-Za-z \-]{0,30}?)(?=[.,;\n]|\band\b|$)",
    re.IGNORECASE,
)
_LOW_RE = re.compile(
    r"(?:lower|low|negative|\bminus\b|-|min(?:imum)?|bottom)\b[^.\n]*?\b(?:is|are|=|means?|gives?|=>|->|:)\s*([A-Za-z][A-Za-z \-]{0,30}?)(?=[.,;\n]|\band\b|$)",
    re.IGNORECASE,
)

_TAG_RE = re.compile(r"<[^>]+>")


def _strip_html(text: str) -> str:
    """Flatten HTML to plain text; descriptions are frequently stored as HTML."""
    text = _TAG_RE.sub(" ", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
    )
    return re.sub(r"\s+", " ", text).strip()


def _parse_range(text: str) -> Optional[Dict[str, float]]:
    """Return ``{"min", "max"}`` for the most relevant range, or None."""
    lowered = text.lower()

    # Prefer a range that appears shortly after a context keyword.
    best_window_match = None
    best_pos = len(text) + 1
    for keyword in _CONTEXT_KEYWORDS:
        start = lowered.find(keyword)
        if start == -1:
            continue
        window = text[start : start + 80]
        match = _RANGE_RE.search(window)
        if match and start < best_pos:
            best_pos = start
            best_window_match = match

    match = best_window_match or _RANGE_RE.search(text)
    if not match:
        return None

    try:
        a = float(match.group(1))
        b = float(match.group(2))
    except ValueError:
        return None

    low, high = (a, b) if a <= b else (b, a)
    # Sanity guard: ignore absurd ranges that are almost certainly not strengths.
    if high - low == 0 or abs(low) > 50 or abs(high) > 50:
        return None
    return {"min": low, "max": high}


def _clean_label(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    label = raw.strip().rstrip(".,;:").strip()
    # Drop trailing filler words a greedy match may have grabbed.
    label = re.sub(r"\b(than|the|a|an|more|less|very)\b\s*$", "", label, flags=re.IGNORECASE).strip()
    return label or None


def _parse_labels(text: str) -> Dict[str, str]:
    labels: Dict[str, str] = {}
    high = _HIGH_RE.search(text)
    if high:
        cleaned = _clean_label(high.group(1))
        if cleaned:
            labels["highLabel"] = cleaned
    low = _LOW_RE.search(text)
    if low:
        cleaned = _clean_label(low.group(1))
        if cleaned:
            labels["lowLabel"] = cleaned
    return labels


def parse_strength_hints(description: Optional[str]) -> Dict[str, object]:
    """Parse a description into any of ``min``/``max``/``lowLabel``/``highLabel``.

    Returns only the keys it is reasonably confident about; never raises.
    """
    if not description:
        return {}
    try:
        text = _strip_html(str(description))
        result: Dict[str, object] = {}
        rng = _parse_range(text)
        if rng:
            result.update(rng)
        result.update(_parse_labels(text))
        return result
    except Exception:  # never let parsing break a caller
        return {}
