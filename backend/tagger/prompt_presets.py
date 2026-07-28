"""Visible prompt presets for Qwen image tagging."""
from __future__ import annotations


DEFAULT_PROMPT_PRESET = "enhanced"
MAX_TAGGER_PROMPT_LENGTH = 12_000

_SHARED_COVERAGE = """Inspect the entire image and include visually supported information about:
- subjects and count
- physical appearance, hair, face, and expression
- clothing, accessories, materials, and exposed body areas
- pose, gesture, action, interaction, and body orientation
- camera view, framing, perspective, focus, and composition
- background, environment, objects, weather, time, and lighting
- clearly visible image medium and rendering characteristics

Describe only visible content. Do not guess character names, copyrights, artists, models,
unseen details, personality, or story. Do not output aesthetic praise, quality judgments,
vague genre descriptions, or terms such as masterpiece, best quality, beautiful artwork,
highly detailed, stunning composition, professional illustration, or detailed illustration.
Avoid duplicate concepts and synonymous tags. Order items from the main subject and defining
features to actions, composition, environment, lighting, and secondary details."""

DANBOORU_STYLE_PROMPT = f"""Analyze this anime-style image and generate a comprehensive English training tag list.

{_SHARED_COVERAGE}

Use concise lowercase Danbooru-style tags separated as individual items. Prefer established
anime tagging terms for visible concepts. Do not write sentences or natural-language phrases,
and do not invent compound tags when no suitable tag exists. Keep one visual concept per tag.
Return no more than {{{{max_tags}}}} unique tags."""

ENHANCED_TAGS_PROMPT = f"""Analyze this anime-style image and generate a comprehensive English training tag list.

{_SHARED_COVERAGE}

Use concise lowercase anime tags for common visual concepts. When an established tag cannot
describe a visible action, relationship, spatial arrangement, clothing structure, material, or
composition precisely, use a short English phrase for that item. Keep one visual concept per
item. Do not write full sentences, explanations, or prose paragraphs.
Return no more than {{{{max_tags}}}} unique tags or short phrases."""

TAGGER_PROMPT_PRESETS = {
    "danbooru": DANBOORU_STYLE_PROMPT,
    "enhanced": ENHANCED_TAGS_PROMPT,
}


def prompt_preset_payload() -> list[dict[str, str]]:
    return [{"id": preset_id, "prompt": prompt} for preset_id, prompt in TAGGER_PROMPT_PRESETS.items()]


def resolve_tagger_prompt(options: dict, maximum: int) -> str:
    raw = str(options.get("prompt") or "").strip()
    if not raw:
        preset_id = str(options.get("preset") or DEFAULT_PROMPT_PRESET)
        raw = TAGGER_PROMPT_PRESETS.get(preset_id, TAGGER_PROMPT_PRESETS[DEFAULT_PROMPT_PRESET])
    if len(raw) > MAX_TAGGER_PROMPT_LENGTH:
        raise ValueError(f"Tagger prompt exceeds {MAX_TAGGER_PROMPT_LENGTH} characters")
    return raw.replace("{{max_tags}}", str(maximum))
