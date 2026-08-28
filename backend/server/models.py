"""API 请求/响应的 pydantic 模型。"""
from pathlib import Path
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field, field_validator

# 含下划线的颜文字标签：下划线转空格时要豁免的名单
KAOMOJI_KEEP_UNDERSCORE = (
    "0_0, ._., ^_^, >_<, o_o, u_u, x_x, =_=, +_+, +_-, >_o, @_@, "
    "3_3, 6_9, (o)_(o), <o>_<o>, <|>_<|>, |_|, ||_||"
)


class TaggerInterrogateRequest(BaseModel):
    path: str
    interrogator_model: str = Field(
        default="wd-eva02-large-tagger-v3"
    )
    threshold: float = Field(
        default=0.35,
        ge=0,
        le=1
    )
    character_threshold: float = Field(
        default=0.6,
        ge=0,
        le=1
    )
    category_thresholds: Optional[Dict[str, float]] = Field(
        default=None,
        description="Per-category thresholds. Keys: general, character, copyright, artist, meta, year, rating"
    )
    add_rating_tag: bool = False
    add_model_tag: bool = False
    additional_tags: str = ""
    exclude_tags: str = ""
    escape_tag: bool = True
    batch_input_recursive: bool = False
    batch_output_dir: str = Field(
        default="",
        description="Output directory for tag files. Empty = same as input directory."
    )
    batch_output_action_on_conflict: str = "ignore"
    batch_remove_duplicated_tag: bool = False
    batch_output_save_json: bool = False
    sort_by_alphabetical_order: bool = False
    add_confident_as_weight: bool = False
    replace_underscore: bool = True
    replace_underscore_excludes: str = Field(default=KAOMOJI_KEEP_UNDERSCORE)

    @field_validator('path')
    @classmethod
    def validate_path(cls, v: str) -> str:
        """归一化路径并拦截非法输入（根目录/不可解析路径）。"""
        try:
            resolved = Path(v).resolve()
        except (ValueError, OSError):
            raise ValueError(f"Invalid path: {v}")
        if not str(resolved) or resolved == resolved.parent:
            raise ValueError(f"Path must not be filesystem root: {v}")
        return str(resolved)


class APIResponse(BaseModel):
    status: str
    message: Optional[str] = None
    data: Optional[Any] = None


class APIResponseSuccess(APIResponse):
    status: str = "success"


class APIResponseFail(APIResponse):
    status: str = "fail"


class TeCacheDeleteRequest(BaseModel):
    """请求删除这些目录树下的各引擎 TE 输出缓存（按 TE_DELETE_SUFFIXES 后缀匹配）。"""

    dirs: List[str] = Field(default_factory=list)


class TrainingTomlParseRequest(BaseModel):
    content: str
