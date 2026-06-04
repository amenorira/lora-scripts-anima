from pydantic import BaseModel, Field, field_validator
from typing import List, Optional, Union, Dict, Any
from pathlib import Path


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
    replace_underscore_excludes: str = Field(
        default="0_0, (o)_(o), +_+, +_-, ._., <o>_<o>, <|>_<|>, =_=, >_<, 3_3, 6_9, >_o, @_@, ^_^, o_o, u_u, x_x, |_|, ||_||"
    )

    @field_validator('path')
    @classmethod
    def validate_path(cls, v: str) -> str:
        """防止路径遍历攻击"""
        try:
            p = Path(v).resolve()
        except (ValueError, OSError):
            raise ValueError(f"Invalid path: {v}")
        # 确保路径不为空且在合理的文件系统范围内
        if not str(p) or p == p.root:
            raise ValueError(f"Path must not be filesystem root: {v}")
        return v


class APIResponse(BaseModel):
    status: str
    message: Optional[str] = None
    data: Optional[Any] = None


class APIResponseSuccess(APIResponse):
    status: str = "success"


class APIResponseFail(APIResponse):
    status: str = "fail"


class PresetSaveRequest(BaseModel):
    name: str
    description: str = ""
    version: str = "1.0"
    author: str = ""
    train_type: str = ""
    data: Dict[str, Any] = {}


class PresetRenameRequest(BaseModel):
    new_name: str
