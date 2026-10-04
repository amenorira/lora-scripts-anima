"""Tokenizer loading helpers that behave the same on transformers 4.x and 5.x."""

import logging

from transformers import AutoTokenizer, PreTrainedTokenizerFast

logger = logging.getLogger(__name__)


def load_llama3_tokenizer(pretrained_model_name_or_path: str, **kwargs) -> PreTrainedTokenizerFast:
    """Load a Llama 3 (tiktoken-style BPE) tokenizer from a Hub repo or a local directory.

    The Llama 3 tokenizers shipped with HunyuanVideo / FramePack / LLaVA-Llama-3 declare
    ``"tokenizer_class": "LlamaTokenizer"`` in their tokenizer_config.json. transformers 4.x resolved that to
    ``LlamaTokenizerFast`` backed by the repo's tokenizer.json, which is correct. transformers 5.x resolves it to
    its new ``LlamaTokenizer`` class, which rebuilds a Llama 2 style (sentencepiece) tokenizer from the vocabulary
    when the config also sets ``legacy: true`` and tokenizes Llama 3 text differently (other token ids, other
    lengths). This helper detects that case and reloads the tokenizer from tokenizer.json through
    ``PreTrainedTokenizerFast``, which gives the same token ids as transformers 4.x.
    """
    tokenizer = AutoTokenizer.from_pretrained(pretrained_model_name_or_path, **kwargs)
    if type(tokenizer).__name__ == "LlamaTokenizer":
        logger.info(
            f"tokenizer at {pretrained_model_name_or_path} resolved to {type(tokenizer).__name__}; reloading it from tokenizer.json"
            " to keep the Llama 3 tokenization"
        )
        tokenizer = PreTrainedTokenizerFast.from_pretrained(pretrained_model_name_or_path, **kwargs)
    return tokenizer
