"""Krea optimizer controls share the established optimizer argument contracts."""
from copy import deepcopy

from backend.training.optimizer_contracts import (
    FORM_ARGUMENTS, FormArgument, AUTOMAGIC_OPTIMIZER_TYPE, EMOSENS_OPTIMIZER_TYPE,
    LORA_MUON_OPTIMIZER_TYPE, LORARITE_OPTIMIZER_TYPE, MUON_OPTIMIZER_TYPE,
    collect_optimizer_args, validate_optimizer_contract, parse_optimizer_args,
)
from backend.training.optimizer_metadata import KREA2_OPTIMIZER_SELECTORS


FIELD_ALIASES = {
    'weight_decay': 'krea_optimizer_weight_decay', 'betas': 'krea_optimizer_betas',
    'eps': 'krea_optimizer_eps', 'prodigy_d_coef': 'krea_prodigy_d_coef',
    'prodigy_d0': 'krea_prodigy_d0', 'prodigyplus_use_stableadamw': 'krea_prodigyplus_use_stableadamw',
    'schedulefree_warmup_steps': 'krea_schedulefree_warmup_steps',
    **{f'adafactor_{key}': f'krea_adafactor_{key}' for key in
       ('relative_step', 'scale_parameter', 'warmup_init', 'clip_threshold', 'eps')},
}
PAIRED_OPTIMIZERS = frozenset({LORA_MUON_OPTIMIZER_TYPE, LORARITE_OPTIMIZER_TYPE})
INTERNAL_OPTIMIZERS = frozenset({AUTOMAGIC_OPTIMIZER_TYPE, EMOSENS_OPTIMIZER_TYPE})
ARGUMENTS = {
    FIELD_ALIASES.get(key, key): FormArgument(mapping.argument, frozenset(
        KREA2_OPTIMIZER_SELECTORS.get(value, value) for value in mapping.optimizers))
    for key, mapping in FORM_ARGUMENTS.items()
}


def translate_metadata(value):
    if isinstance(value, dict):
        return {FIELD_ALIASES.get(key, KREA2_OPTIMIZER_SELECTORS.get(key, key)): translate_metadata(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [translate_metadata(item) for item in value]
    if isinstance(value, str):
        if value == 'anima-lora':
            return 'krea2-lora'
        return FIELD_ALIASES.get(value, KREA2_OPTIMIZER_SELECTORS.get(value, value))
    return value


def extend_fields(fields):
    # Imported only after the shared registry is initialized. Keeping a single
    # source preserves names, nesting and defaults when common controls change.
    from backend.training.field_registry import FIELDS
    reference = {field['key']: field for field in FIELDS}
    existing = {field['key']: field for field in fields}
    for key in FORM_ARGUMENTS:
        mapped = FIELD_ALIASES.get(key, key)
        if mapped in existing:
            continue
        item = translate_metadata(deepcopy(reference[key]))
        for attribute in ('target', 'group', 'omit_default', 'default_by_group'):
            item.pop(attribute, None)
        item['profiles'] = ['krea2-lora']
        item.setdefault('default', '')
        fields.append(item)
    custom = deepcopy(reference['optimizer_args_custom'])
    custom.pop('target', None)
    custom['profiles'] = ['krea2-lora']
    fields.append(custom)
    for key in ('gradient_accumulation_steps', 'max_grad_norm', 'lr_scheduler', 'lr_warmup_steps'):
        for attribute in ('auto_value', 'readonly_if', 'readonly_if_any', 'readonly_reason_key', 'hint_key_by'):
            if attribute in reference[key]:
                existing[key][attribute] = translate_metadata(deepcopy(reference[key][attribute]))
    for attribute in ('hint_key_by', 'readonly_if'):
        existing['learning_rate'][attribute] = translate_metadata(deepcopy(reference['learning_rate'][attribute]))
    existing['learning_rate']['hint_key_by']['values'][LORA_MUON_OPTIMIZER_TYPE] = 'field.krea_learning_rateHint_lora_muon'
    existing['learning_rate']['auto_value'] = deepcopy(existing['learning_rate']['auto_value'])
    for rule in existing['learning_rate']['auto_value']:
        if rule.get('set') == '1.0':
            rule.pop('set_if_default', None)
    existing['learning_rate']['auto_value'] += [
        {'watch': 'optimizer_type', 'when': key, 'set': value, 'set_if_default': True}
        for key, value in ((EMOSENS_OPTIMIZER_TYPE, '0.1'), (LORA_MUON_OPTIMIZER_TYPE, '0.1'),
                           (LORARITE_OPTIMIZER_TYPE, '1e-4'))
    ]
    for key in ('betas', 'eps', 'weight_decay'):
        for attribute in ('auto_value', 'hint_key_by'):
            if attribute in reference[key]:
                existing[FIELD_ALIASES[key]][attribute] = translate_metadata(deepcopy(reference[key][attribute]))
    for attribute in ('auto_value', 'readonly_if_any', 'readonly_reason_key'):
        existing['enable_loraplus'][attribute] = translate_metadata(deepcopy(reference['enable_loraplus'][attribute]))


def validate_optimizer(config, arguments, gpu_ids=None):
    from backend.training.validation import _validate_automagic, _validate_emosens
    from backend.training.field_registry import LORAPLUS_INCOMPATIBLE_OPTIMIZERS
    reverse = {value: key for key, value in KREA2_OPTIMIZER_SELECTORS.items()}
    canonical = {**config, 'model_train_type': 'krea2-lora',
                 'optimizer_type': reverse.get(config['optimizer_type'], config['optimizer_type'])}
    errors = validate_optimizer_contract(canonical, arguments)
    errors += _validate_automagic(canonical, arguments, gpu_ids)
    errors += _validate_emosens(canonical, gpu_ids)
    optimizer = canonical['optimizer_type']
    is_lycoris = config.get('network_module') == 'lycoris.kohya'
    if optimizer in PAIRED_OPTIMIZERS and is_lycoris:
        if config.get('lycoris_algo') != 'lora' or config.get('use_scalar') or config.get('dora_wd'):
            errors.append('optimizer_type: paired optimizers require LoCon without use_scalar or DoRA / 成对矩阵优化器需要关闭 use_scalar 和 DoRA 的 LoCon')
    if optimizer == MUON_OPTIMIZER_TYPE and is_lycoris and config.get('use_scalar'):
        errors.append('Muon: use_scalar introduces non-2D parameters / Muon 需要关闭 use_scalar')
    if config.get('enable_loraplus'):
        if optimizer in LORAPLUS_INCOMPATIBLE_OPTIMIZERS:
            errors.append('enable_loraplus: incompatible with this optimizer / 当前优化器不能与 LoRA+ 同时使用')
        if optimizer == 'AdaFactor' and (arguments.get('relative_step', True) or arguments.get('warmup_init', False)):
            errors.append('enable_loraplus: disable AdaFactor relative_step and warmup_init / 使用 LoRA+ 时请关闭 AdaFactor 的 relative_step 和 warmup_init')
        if optimizer == AUTOMAGIC_OPTIMIZER_TYPE:
            try:
                rate = float(config['learning_rate']) * float(config.get('loraplus_lr_ratio', 2))
                if not float(arguments.get('min_lr', 1e-8)) <= rate <= float(arguments.get('max_lr', 1e3)):
                    errors.append('loraplus_lr_ratio: effective LR must be within Automagic min_lr/max_lr / 倍率后的学习率须在 Automagic 最小与最大学习率之间')
            except (TypeError, ValueError):
                pass  # Field validation supplies the numeric error.
    return errors


def collect_arguments(config, defaults, mappings, *, warnings=None):
    values = {**defaults, 'optimizer_type': 'adamw8bit', **config}
    fused = values.get('krea_adamw_fused', 'auto')
    if fused not in ('auto', 'true', 'false'):
        raise ValueError('krea_adamw_fused: select auto, true or false / 请选择 auto、true 或 false')
    values['krea_adamw_fused'] = {'auto': None, 'true': True, 'false': False}[fused]
    parsed, errors = parse_optimizer_args(values)
    if errors:
        raise ValueError('; '.join(errors))
    reverse = {value: key for key, value in KREA2_OPTIMIZER_SELECTORS.items()}
    canonical = dict(values)
    for key, mapped in FIELD_ALIASES.items():
        if mapped in values:
            canonical[key] = values[mapped]
    canonical['optimizer_type'] = reverse.get(values['optimizer_type'], values['optimizer_type'])
    if canonical['optimizer_type'].startswith('torch.optim.'):
        arguments = collect_optimizer_args(values, parsed, mappings=mappings, warnings=warnings)
    else:
        arguments = collect_optimizer_args(canonical, parsed, warnings=warnings)
        if values['optimizer_type'] == 'AdamW' and values['krea_adamw_fused'] is not None:
            arguments['fused'] = values['krea_adamw_fused']
    if values['optimizer_type'] == 'pytorch_optimizer.CAME' and arguments.get('weight_decouple') is False:
        arguments.pop('fixed_decay', None)
    return arguments
