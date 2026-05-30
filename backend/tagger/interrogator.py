# from https://github.com/toriato/stable-diffusion-webui-wd14-tagger
import json
import os
import re
from collections import OrderedDict
from glob import glob
from pathlib import Path
from typing import Dict, List, Tuple

import numpy as np
import pandas as pd
from PIL import Image
from PIL import UnidentifiedImageError
from huggingface_hub import hf_hub_download

from backend.tagger import dbimutils, format
from backend.tagger.interrogators.base import Interrogator
from backend.tagger.interrogators.wd14 import WaifuDiffusionInterrogator
from backend.tagger.interrogators.cl import CLTaggerInterrogator
from backend.tagger.interrogators.camie import CamieTaggerInterrogator
from backend.constants import HF_CACHE_DIR
import traceback

tag_escape_pattern = re.compile(r'([\\()])')

# ── Progress tracker for tagger tasks ────────────────────
_tagger_progress: Dict[str, dict] = {}

def get_tagger_progress(task_id: str) -> dict:
    return _tagger_progress.get(task_id, {"status": "idle", "current": 0, "total": 0, "current_file": "", "logs": []})


# 所有模型统一下载到项目 huggingface/ 目录
_hf_cache = str(HF_CACHE_DIR)

available_interrogators = {
    'wd-convnext-v3': WaifuDiffusionInterrogator(
        'wd-convnext-v3',
        repo_id='SmilingWolf/wd-convnext-tagger-v3',
        cache_dir=_hf_cache,
    ),
    'wd-swinv2-v3': WaifuDiffusionInterrogator(
        'wd-swinv2-v3',
        repo_id='SmilingWolf/wd-swinv2-tagger-v3',
        cache_dir=_hf_cache,
    ),
    'wd-vit-v3': WaifuDiffusionInterrogator(
        'wd14-vit-v3',
        repo_id='SmilingWolf/wd-vit-tagger-v3',
        cache_dir=_hf_cache,
    ),
    'wd14-convnextv2-v2': WaifuDiffusionInterrogator(
        'wd14-convnextv2-v2', repo_id='SmilingWolf/wd-v1-4-convnextv2-tagger-v2',
        revision='v2.0', cache_dir=_hf_cache,
    ),
    'wd14-swinv2-v2': WaifuDiffusionInterrogator(
        'wd14-swinv2-v2', repo_id='SmilingWolf/wd-v1-4-swinv2-tagger-v2',
        revision='v2.0', cache_dir=_hf_cache,
    ),
    'wd14-vit-v2': WaifuDiffusionInterrogator(
        'wd14-vit-v2', repo_id='SmilingWolf/wd-v1-4-vit-tagger-v2',
        revision='v2.0', cache_dir=_hf_cache,
    ),
    'wd14-moat-v2': WaifuDiffusionInterrogator(
        'wd-v1-4-moat-tagger-v2',
        repo_id='SmilingWolf/wd-v1-4-moat-tagger-v2',
        revision='v2.0', cache_dir=_hf_cache,
    ),
    'wd-eva02-large-tagger-v3': WaifuDiffusionInterrogator(
        'wd-eva02-large-tagger-v3',
        repo_id='SmilingWolf/wd-eva02-large-tagger-v3',
        cache_dir=_hf_cache,
    ),
    'wd-vit-large-tagger-v3': WaifuDiffusionInterrogator(
        'wd-vit-large-tagger-v3',
        repo_id='SmilingWolf/wd-vit-large-tagger-v3',
        cache_dir=_hf_cache,
    ),
    'cl_tagger_1_01': CLTaggerInterrogator(
        'cl_tagger_1_01',
        repo_id='cella110n/cl_tagger',
        model_path='cl_tagger_1_01/model.onnx',
        tag_mapping_path='cl_tagger_1_01/tag_mapping.json',
        cache_dir=_hf_cache,
    ),
    'camie-tagger-v2': CamieTaggerInterrogator(
        'camie-tagger-v2',
        repo_id='Camais03/camie-tagger-v2',
        model_filename='camie-tagger-v2.onnx',
        metadata_filename='camie-tagger-v2-metadata.json',
        cache_dir=_hf_cache,
    ),
}


def split_str(s: str, separator=',') -> List[str]:
    return [x.strip() for x in s.split(separator) if x]


def on_interrogate(
        task_id: str,
        image: Image,
        batch_input_glob: str,
        batch_input_recursive: bool,
        batch_output_dir: str,
        batch_output_filename_format: str,
        batch_output_action_on_conflict: str,
        batch_remove_duplicated_tag: bool,
        batch_output_save_json: bool,

        interrogator: Interrogator,

        threshold: float,
        character_threshold: float,
        category_thresholds: Dict[str, float] = None,

        add_rating_tag: bool = False,
        add_model_tag: bool = False,

        additional_tags: str = "",
        exclude_tags: str = "",
        sort_by_alphabetical_order: bool = False,
        add_confident_as_weight: bool = False,
        replace_underscore: bool = False,
        replace_underscore_excludes: str = "",
        escape_tag: bool = False,

        unload_model_after_running: bool = False
):
    postprocess_opts = (
        threshold,
        character_threshold,
        category_thresholds or {},
        add_rating_tag,
        add_model_tag,
        split_str(additional_tags),
        split_str(exclude_tags),
        sort_by_alphabetical_order,
        add_confident_as_weight,
        replace_underscore,
        split_str(replace_underscore_excludes),
        escape_tag
    )

    # batch process
    batch_input_glob = batch_input_glob.strip()
    batch_output_dir = batch_output_dir.strip()
    batch_output_filename_format = batch_output_filename_format.strip()

    if batch_input_glob != '':
        # if there is no glob pattern, insert it automatically
        if not batch_input_glob.endswith('*'):
            if not batch_input_glob.endswith(os.sep):
                batch_input_glob += os.sep
            batch_input_glob += '*'

        if batch_input_recursive:
            batch_input_glob += '*'

        # get root directory of input glob pattern
        base_dir = batch_input_glob.replace('?', '*')
        base_dir = base_dir.split(os.sep + '*').pop(0)

        # check the input directory path
        if not os.path.isdir(base_dir):
            print('input path is not a directory')
            return 'input path is not a directory'

        # this line is moved here because some reason
        # PIL.Image.registered_extensions() returns only PNG if you call too early
        supported_extensions = [
            e
            for e, f in Image.registered_extensions().items()
            if f in Image.OPEN
        ]

        paths = [
            Path(p)
            for p in glob(batch_input_glob, recursive=batch_input_recursive)
            if '.' + p.split('.').pop().lower() in supported_extensions
        ]

        total = len(paths)
        _tagger_progress[task_id] = {"status": "running", "current": 0, "total": total, "current_file": "", "logs": []}
        print(f'found {total} image(s)')

        for idx, path in enumerate(paths):
            try:
                with Image.open(path) as image:
                    # guess the output path
                    base_dir_last = Path(base_dir).parts[-1]
                    base_dir_last_idx = path.parts.index(base_dir_last)
                    output_dir = Path(
                        batch_output_dir) if batch_output_dir else Path(base_dir)
                    output_dir = output_dir.joinpath(
                        *path.parts[base_dir_last_idx + 1:]).parent

                    output_dir.mkdir(0o777, True, True)

                    # format output filename
                    format_info = format.Info(path, 'txt')

                    try:
                        formatted_output_filename = format.pattern.sub(
                            lambda m: format.format(m, format_info),
                            batch_output_filename_format
                        )
                    except (TypeError, ValueError) as error:
                        error_msg = f"Format error: {str(error)[:200]}"
                        _tagger_progress[task_id]["status"] = "error"
                        _tagger_progress[task_id]["error_detail"] = error_msg
                        _tagger_progress[task_id]["logs"].append(f'Error: {error_msg}')
                        return str(error)

                    output_path = output_dir.joinpath(
                        formatted_output_filename
                    )

                    output = []

                    if output_path.is_file():
                        output.append(output_path.read_text(errors='ignore').strip())

                        if batch_output_action_on_conflict == 'ignore':
                            print(f'skipping {path}')
                            _tagger_progress[task_id]["logs"].append(f'Skip (exists): {path.name}')
                            _tagger_progress[task_id]["current"] = idx + 1
                            _tagger_progress[task_id]["current_file"] = str(path.name)
                            continue

                    tags = interrogator.interrogate(image)
                    processed_tags = Interrogator.postprocess_tags(
                        tags,
                        *postprocess_opts
                    )

                    print(
                        f'[{idx+1}/{total}] found {len(processed_tags)} tags from {path.name}'
                    )

                    plain_tags = ', '.join(processed_tags)

                    if batch_output_action_on_conflict == 'copy':
                        output = [plain_tags]
                    elif batch_output_action_on_conflict == 'prepend':
                        output.insert(0, plain_tags)
                    else:
                        output.append(plain_tags)

                    if batch_remove_duplicated_tag:
                        output_path.write_text(
                            ', '.join(
                                OrderedDict.fromkeys(
                                    map(str.strip, ','.join(output).split(','))
                                )
                            ),
                            encoding='utf-8'
                        )
                    else:
                        output_path.write_text(
                            ', '.join(output),
                            encoding='utf-8'
                        )

                    if batch_output_save_json:
                        output_path.with_suffix('.json').write_text(
                            json.dumps(tags)
                        )

                    _tagger_progress[task_id]["logs"].append(f'[{idx+1}/{total}] {path.name}: {len(processed_tags)} tags')
            except UnidentifiedImageError:
                print(f'{path} is not supported image type')
                _tagger_progress[task_id]["logs"].append(f'Skip (unsupported): {path.name}')

            _tagger_progress[task_id]["current"] = idx + 1
            _tagger_progress[task_id]["current_file"] = str(path.name)

        _tagger_progress[task_id]["status"] = "done"
        print('all done')

    if unload_model_after_running:
        interrogator.unload()

    return 'Succeed'
