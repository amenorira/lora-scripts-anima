import re
from typing import Dict, List, Optional, Tuple
from PIL import Image
from backend.log import log

tag_escape_pattern = re.compile(r'([\\()])')

# ── Camie Tagger v2 推荐分类阈值 ──────────────────────

# Macro-optimized: 每个标签权重相同，稀有标签友好，宁多勿少（推荐打标训练数据用）
CAMIE_MACRO_THRESHOLDS = {
    "general": 0.492,
    "character": 0.492,
    "copyright": 0.492,
    "artist": 0.492,
    "meta": 0.492,
    "year": 0.492,
    "rating": 0.492,
}

# Micro-optimized: 按标签出现频率加权，常见标签更精准，误报更少
CAMIE_MICRO_THRESHOLDS = {
    "general": 0.614,
    "character": 0.614,
    "copyright": 0.614,
    "artist": 0.614,
    "meta": 0.614,
    "year": 0.614,
    "rating": 0.614,
}

# 预设合集（供前端使用）
CAMIE_THRESHOLD_PRESETS = {
    "macro": CAMIE_MACRO_THRESHOLDS,
    "micro": CAMIE_MICRO_THRESHOLDS,
}

# 各分类显示名称
CATEGORY_LABELS = {
    "general": "特征 (General)",
    "character": "角色 (Character)",
    "copyright": "版权 (Copyright)",
    "artist": "画师 (Artist)",
    "meta": "元数据 (Meta)",
    "year": "年份 (Year)",
    "rating": "分级 (Rating)",
    "quality": "质量 (Quality)",
    "model": "模型 (Model)",
}


class Interrogator:
    @staticmethod
    def postprocess_tags(
            tags: Dict[str, List[Tuple[str, float]]],

            threshold=0.35,
            character_threshold=0.6,
            category_thresholds: Optional[Dict[str, float]] = None,

            add_rating_tag=False,
            add_model_tag=False,

            additional_tags: List[str] = [],
            exclude_tags: List[str] = [],
            sort_by_alphabetical_order=False,
            add_confident_as_weight=False,
            replace_underscore=False,
            replace_underscore_excludes: List[str] = [],
            escape_tag=False
    ) -> Dict[str, float]:

        ok_tags = {}

        if not add_rating_tag and 'rating' in tags:
            del tags['rating']

        if not add_model_tag and 'model' in tags:
            del tags['model']

        # 角色标签：优先用 category_thresholds，其次用 character_threshold
        if 'character' in tags:
            char_th = character_threshold
            if category_thresholds and 'character' in category_thresholds:
                char_th = category_thresholds['character']
            for t, c in tags['character']:
                if c >= char_th:
                    ok_tags[t] = c
            del tags['character']

        for t in additional_tags:
            ok_tags[t] = 1.0

        for category in tags:
            # 确定本分类的阈值：分类阈值 > 全局 threshold
            cat_th = threshold
            if category_thresholds and category in category_thresholds:
                cat_th = category_thresholds[category]
            for t, c in tags[category]:
                if c >= cat_th:
                    ok_tags[t] = c

        for e in exclude_tags:
            ok_tags.pop(e, None)

        if sort_by_alphabetical_order:
            ok_tags = dict(sorted(ok_tags.items()))
        # sort tag by confidence
        else:
            ok_tags = dict(sorted(ok_tags.items(), key=lambda item: item[1], reverse=True))

        new_tags = []
        for tag in list(ok_tags):
            new_tag = tag

            if replace_underscore and tag not in replace_underscore_excludes:
                new_tag = new_tag.replace('_', ' ')

            if escape_tag:
                new_tag = tag_escape_pattern.sub(r'\\\1', new_tag)

            if add_confident_as_weight:
                new_tag = f'({new_tag}:{ok_tags[tag]})'

            new_tags.append((new_tag, ok_tags[tag]))

        return dict(new_tags)

    def __init__(self, name: str) -> None:
        self.name = name

    def load(self):
        raise NotImplementedError()

    def unload(self) -> bool:
        unloaded = False

        if hasattr(self, 'model') and self.model is not None:
            del self.model
            unloaded = True
            log.info(f'Unloaded {self.name}')

        if hasattr(self, 'tags'):
            del self.tags

        return unloaded

    def interrogate(
            self,
            image: Image
    ) -> Dict[str, List[Tuple[str, float]]]:
        """
        Interrogate the given image and return tags with their confidence scores.
        :param image: The input image to be interrogated.
        :return: A dictionary with categories as keys and lists of (tag, confidence)

        categories: "rating", "general", "character", "copyright", "artist", "meta", "year", "quality", "model"
        """

        raise NotImplementedError()
