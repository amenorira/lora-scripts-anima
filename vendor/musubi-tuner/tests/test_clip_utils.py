"""Tests for musubi_tuner/utils/clip_utils.py (CLIPTextModel / CLIPTokenizer compatibility across transformers versions).

The tokenizer itself needs vocabulary files from the Hugging Face Hub, so only the pure normalization is tested.
The state dict conversion is tested with a tiny ``CLIPTextModel`` against whichever layout the installed
transformers uses, so the test is meaningful on both 4.x and 5.6+.
"""

import torch
from transformers import CLIPTextConfig, CLIPTextModel

from musubi_tuner.utils.clip_utils import (
    _clean,
    clean_clip_text,
    clip_text_transformer,
    convert_clip_text_model_state_dict,
    is_flattened_clip_text_model,
    load_clip_text_model_state_dict,
)


def test_clean_clip_text_matches_legacy_normalization():
    # curly quotes are straightened, full-width characters become ASCII, HTML entities are unescaped,
    # mojibake is repaired, whitespace is collapsed and stripped (ftfy.fix_text + whitespace_clean)
    assert clean_clip_text("“quoted”") == '"quoted"'
    assert clean_clip_text("ＡＢＣ　１２３") == "ABC 123"
    assert clean_clip_text("a &amp; b") == "a & b"
    assert clean_clip_text("rÃ©sumÃ©") == "résumé"  # mojibake of "résumé"
    assert clean_clip_text("  many   spaces\n\tand lines  ") == "many spaces and lines"
    # plain text is unchanged
    assert clean_clip_text("a photo of a cat, masterpiece") == "a photo of a cat, masterpiece"
    assert clean_clip_text("") == ""


def test_clean_handles_batches_pairs_and_pretokenized_input():
    assert _clean(None) is None
    assert _clean(["“a”", "b"]) == ['"a"', "b"]
    assert _clean(("“a”", "“b”")) == ('"a"', '"b"')
    assert _clean([["“a”", "b"], ["c"]]) == [['"a"', "b"], ["c"]]
    assert _clean(3) == 3


def _tiny_clip():
    torch.manual_seed(0)
    config = CLIPTextConfig(
        vocab_size=64, hidden_size=16, intermediate_size=32, num_hidden_layers=2, num_attention_heads=2, max_position_embeddings=8
    )
    return CLIPTextModel(config)


def _with_prefix(sd):
    return {"text_model." + k: v for k, v in sd.items()}


def _without_prefix(sd):
    return {k.removeprefix("text_model."): v for k, v in sd.items()}


def test_clip_text_transformer_owns_the_submodules():
    model = _tiny_clip()
    inner = clip_text_transformer(model)
    assert hasattr(inner, "embeddings") and hasattr(inner, "encoder") and hasattr(inner, "final_layer_norm")
    if is_flattened_clip_text_model(model):
        assert inner is model
    else:
        assert inner is model.text_model


def test_state_dict_is_converted_to_the_installed_layout():
    model = _tiny_clip()
    native = model.state_dict()
    flattened = is_flattened_clip_text_model(model)
    assert all(k.startswith("text_model.") != flattened for k in native)

    old_layout = _with_prefix(_without_prefix(native))  # transformers < 5.6 checkpoint keys
    new_layout = _without_prefix(native)  # transformers >= 5.6 checkpoint keys
    for sd in (old_layout, new_layout):
        converted = convert_clip_text_model_state_dict(model, sd)
        assert converted.keys() == native.keys()
        assert all(converted[k] is native[k] for k in native)  # tensors are shared, not copied
    # a dict already in the installed layout is returned unchanged
    assert convert_clip_text_model_state_dict(model, native) is native


def test_load_clip_text_model_state_dict_accepts_both_layouts():
    src = _tiny_clip()
    for sd in (_with_prefix(_without_prefix(src.state_dict())), _without_prefix(src.state_dict())):
        dst = _tiny_clip()
        with torch.no_grad():
            for p in dst.parameters():
                p.zero_()
        result = load_clip_text_model_state_dict(dst, sd, strict=True)
        assert not result.missing_keys and not result.unexpected_keys
        for k, v in src.state_dict().items():
            assert torch.equal(dst.state_dict()[k], v)


def test_unrelated_keys_are_left_alone():
    model = _tiny_clip()
    sd = dict(model.state_dict())
    sd["text_projection.weight"] = torch.zeros(1)
    foreign = _with_prefix(_without_prefix(sd)) if is_flattened_clip_text_model(model) else _without_prefix(sd)
    converted = convert_clip_text_model_state_dict(model, foreign)
    assert "text_projection.weight" in converted
    assert converted.keys() - {"text_projection.weight"} == model.state_dict().keys()
