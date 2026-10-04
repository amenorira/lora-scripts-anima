"""Compatibility helpers for ``transformers.CLIPTextModel`` / ``CLIPTokenizer`` across transformers 4.x and 5.x.

Two things changed for CLIP in transformers 5:

* ``CLIPTokenizer`` became the fast (Rust) tokenizer. The slow tokenizer of 4.x ran
  ``ftfy.fix_text`` and whitespace cleanup before BPE, like the original OpenAI CLIP
  tokenizer the models were trained with (straightening curly quotes, converting
  full-width characters to ASCII, unescaping HTML entities, repairing mojibake). The
  fast tokenizer only applies NFC, lowercasing and whitespace collapsing, so such
  strings would be tokenized differently. :class:`CLIPTokenizer` below restores the
  ftfy step for the fast tokenizer, which keeps the token ids identical across
  transformers versions. With a slow tokenizer it is a no-op.

* transformers 5.6 flattened ``CLIPTextModel``: the ``text_model`` submodule was
  removed and ``embeddings`` / ``encoder`` / ``final_layer_norm`` now live directly
  on the model. Checkpoint keys lost their ``text_model.`` prefix accordingly.
  ``from_pretrained`` converts old checkpoints automatically, but the single-file
  loaders in this repository build the model from a config and call
  ``load_state_dict`` themselves, so :func:`load_clip_text_model_state_dict` renames
  the keys to the layout of the installed transformers, and
  :func:`clip_text_transformer` gives access to the submodules for either layout.
"""

import re
from typing import Any, Dict

import ftfy
import torch
from transformers import CLIPTextModel
from transformers import CLIPTokenizer as _CLIPTokenizer

_WHITESPACE_RE = re.compile(r"\s+")
_TEXT_MODEL_PREFIX = "text_model."


def clean_clip_text(text: str) -> str:
    """Same normalization as the legacy slow ``CLIPTokenizer`` (``whitespace_clean(ftfy.fix_text(text))``)."""
    return _WHITESPACE_RE.sub(" ", ftfy.fix_text(text)).strip()


def _clean(value: Any) -> Any:
    # str, pairs of str (text, text_pair), pre-tokenized lists and batches of those
    if isinstance(value, str):
        return clean_clip_text(value)
    if isinstance(value, (list, tuple)):
        return type(value)(_clean(v) for v in value)
    return value


class CLIPTokenizer(_CLIPTokenizer):
    """Drop-in replacement for ``transformers.CLIPTokenizer`` that keeps the legacy text normalization."""

    def _encode_plus(self, text, text_pair=None, *args, **kwargs):
        if self.is_fast:
            text, text_pair = _clean(text), _clean(text_pair)
        return super()._encode_plus(text, text_pair, *args, **kwargs)

    def _batch_encode_plus(self, batch_text_or_text_pairs, *args, **kwargs):
        if self.is_fast:
            batch_text_or_text_pairs = _clean(batch_text_or_text_pairs)
        return super()._batch_encode_plus(batch_text_or_text_pairs, *args, **kwargs)


def is_flattened_clip_text_model(model: torch.nn.Module) -> bool:
    """True for the transformers >= 5.6 layout (no ``text_model`` submodule)."""
    return not hasattr(model, "text_model")


def clip_text_transformer(model: CLIPTextModel) -> torch.nn.Module:
    """The module that owns ``embeddings``, ``encoder`` and ``final_layer_norm``: ``model.text_model`` on
    transformers < 5.6, the model itself on newer versions."""
    return model if is_flattened_clip_text_model(model) else model.text_model


def convert_clip_text_model_state_dict(model: CLIPTextModel, state_dict: Dict[str, torch.Tensor]) -> Dict[str, torch.Tensor]:
    """Return ``state_dict`` with the ``text_model.`` prefix added or removed to match the layout of ``model``.

    Keys that do not follow either layout (e.g. ``text_projection.weight``) are kept as they are. The returned
    dict shares the tensors with the input; the input is not modified. A dict that already matches is returned as is.
    """
    has_prefix = any(k.startswith(_TEXT_MODEL_PREFIX) for k in state_dict)
    if is_flattened_clip_text_model(model):
        if not has_prefix:
            return state_dict
        return {k[len(_TEXT_MODEL_PREFIX) :] if k.startswith(_TEXT_MODEL_PREFIX) else k: v for k, v in state_dict.items()}
    if has_prefix:
        return state_dict
    own_keys = model.state_dict().keys()
    return {(_TEXT_MODEL_PREFIX + k) if (_TEXT_MODEL_PREFIX + k) in own_keys else k: v for k, v in state_dict.items()}


def load_clip_text_model_state_dict(
    model: CLIPTextModel, state_dict: Dict[str, torch.Tensor], strict: bool = True, assign: bool = False
):
    """``model.load_state_dict`` that accepts checkpoints of either ``CLIPTextModel`` layout."""
    return model.load_state_dict(convert_clip_text_model_state_dict(model, state_dict), strict=strict, assign=assign)
