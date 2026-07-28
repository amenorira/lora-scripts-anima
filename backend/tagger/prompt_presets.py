"""Visible prompt presets for Qwen image tagging."""
from __future__ import annotations


DEFAULT_PROMPT_PRESET = "enhanced"
MAX_TAGGER_PROMPT_LENGTH = 12_000

_SHARED_COVERAGE = """Tag only this image for anime-model training. {{max_tags}} is a hard ceiling,
not a target. Cover all distinct salient facts within every visible category below, then stop when
no new important fact remains. Do not pad, speculate, repeat concepts, or omit an entire visible
category merely to make the caption shorter.

Silently inspect in this order:
1. subject type and count;
2. current visible body extent, framing, viewpoint, orientation, and focus;
3. hair, eyes, face, and visible body traits;
4. every visible garment and accessory from head to feet, including type, defining colors, pattern,
   construction, fasteners, trim and ornaments; compare left and right sides for asymmetry;
5. pose, gestures, action and interaction;
6. background or setting, objects, effects, text, lighting, and distinctive style traits.

Use only direct pixel evidence. Never complete hidden anatomy or outfit parts from expectation or
related images. Never name a body extent that is outside the frame, claim the face is absent when it
is visible, or use crop provenance without evidence. Distinguish fabric ornaments from animal or
body features by structure, not silhouette. For each concept choose one precise name: no broad
parent plus specific child, singular/plural pair, near-synonyms, bare colors, or exhaustive color
combinations. Treat small printed icons as garment motifs unless they are real scene objects.
Always include discernible composition, expression, gaze, pose, and background. Omit absence
descriptions, generic medium labels, praise, quality terms, narrative, and other training filler.
Do not infer a character identity, franchise, artist, platform, model type, or source category from
visual style; include such metadata only when unmistakable visible text or a logo proves it.

Order tags by: subject/count; composition; appearance; clothing/accessories;
expression/gaze/pose; background/objects/effects/style. Return only one comma-separated line and
stop immediately after the final useful tag."""

DANBOORU_STYLE_PROMPT = f"""Analyze the image and generate an English training tag list.

{_SHARED_COVERAGE}

Translate the completed visual audit into concise lowercase established Danbooru-style tags.
Use a canonical tag only when its meaning exactly matches the pixels. Do not invent compound tags,
write natural-language descriptions, or substitute a nearby tag for an uncertain observation.
Use standard subject-count tags rather than generic words such as anime, girl, female, character,
person, or subject. Keep one visual concept per item and return unique tags."""

ENHANCED_TAGS_PROMPT = f"""Analyze the image and generate an English training tag list.

{_SHARED_COVERAGE}

First provide the same complete set of concise lowercase established Danbooru-style tags that the
strict mode would use. Then add a small minority of short concrete English phrases only for visible
details that standard tags cannot preserve, such as an unusual garment construction, accessory
placement, or spatial relationship. A phrase must add new training information; it must not rename,
expand, or explain an existing tag. Do not write sentences, prose, mood, narrative, quality terms,
or speculative details. Never replace a standard tag with a broader word or phrase, and do not
collapse an asymmetric, multicomponent, or multicolored design into generic component words.
At least four out of every five items must remain established Danbooru-style tags; short phrases
must be no more than one fifth of the result. Return unique tags and short phrases."""

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
