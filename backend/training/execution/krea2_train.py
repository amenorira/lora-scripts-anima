"""Application Krea entry point with optimizer execution integration."""
from __future__ import annotations

import ast
import copy
from pathlib import Path
import sys
from types import SimpleNamespace

if __name__ == '__main__':
    root = Path(__file__).resolve().parents[3]
    sys.path[:0] = [str(root), str(root / 'vendor/musubi-tuner/src'), str(root / 'vendor')]

from musubi_tuner.krea2_train_network import (
    Krea2NetworkTrainer, krea2_setup_parser, setup_parser_common, read_config_from_file,
)
from backend.training.config.krea2_optimizers import PAIRED_OPTIMIZERS, INTERNAL_OPTIMIZERS
from backend.training.config.optimizer_contracts import ADEMAMIX_OPTIMIZERS, AUTOMAGIC_OPTIMIZER_TYPE, get_automagic_fused_conflicts


def paired_parameter_groups(network, groups):
    """Keep actual down/up parameters adjacent, without guessing from shapes."""
    groups = [{**group, 'params': list(group['params'])} for group in groups]
    owners = {id(parameter): index for index, group in enumerate(groups) for parameter in group['params']}
    paired = [[] for _ in groups]
    seen = set()
    for module in network.modules():
        down, up = getattr(module, 'lora_down', None), getattr(module, 'lora_up', None)
        if down is None or up is None:
            continue
        down, up = down.weight, up.weight
        if id(down) not in owners or id(up) not in owners:
            continue
        owner = owners[id(down)]
        if owner != owners[id(up)]:
            raise ValueError('Paired optimizers require one learning rate per LoRA pair / 成对矩阵优化器不能拆分 LoRA 上下矩阵学习率')
        if down.ndim != 2 or up.ndim != 2 or down.shape[0] != up.shape[1]:
            raise ValueError('Krea paired optimizers require compatible Linear LoRA factors / 需要维度匹配的 Linear LoRA 矩阵')
        paired[owner].extend((down, up))
        seen.update((id(down), id(up)))
    if seen != set(owners):
        raise ValueError('Paired optimizer received non-LoRA parameters / 成对矩阵优化器收到额外参数，请关闭 use_scalar 和 DoRA')
    return [{**group, 'params': ordered} for group, ordered in zip(groups, paired)]


class Krea2Trainer(Krea2NetworkTrainer):
    def extra_trainable_params(self, args, accelerator, network, transformer, trainable_params):
        params = super().extra_trainable_params(args, accelerator, network, transformer, trainable_params)
        self._optimizer_processes = getattr(accelerator, 'num_processes', 1)
        if args.optimizer_type in PAIRED_OPTIMIZERS:
            return paired_parameter_groups(network, params)
        if args.optimizer_type == 'torch.optim.Muon':
            if any(parameter.ndim != 2 for group in params for parameter in group['params']):
                raise ValueError('Muon requires 2D trainable parameters / Muon 需要所有可训练参数均为二维矩阵')
        return params

    def get_optimizer(self, args, trainable_params):
        if args.optimizer_type == AUTOMAGIC_OPTIMIZER_TYPE:
            arguments = dict(item.split('=', 1) for item in args.optimizer_args or [])
            if ast.literal_eval(arguments.get('fused', 'False')):
                conflicts = get_automagic_fused_conflicts(vars(args), list(range(getattr(self, '_optimizer_processes', 1))))
                if conflicts:
                    raise ValueError('Automagic3 fused: ' + '; '.join(conflicts))
                args = copy.copy(args)
                args.optimizer_args = [arg for arg in args.optimizer_args if not arg.startswith('fused_guard=')]
                args.optimizer_args.append('fused_guard=True')
        return super().get_optimizer(args, trainable_params)

    def is_schedulefree_optimizer(self, optimizer, args):
        return args.optimizer_type in INTERNAL_OPTIMIZERS or super().is_schedulefree_optimizer(optimizer, args)

    def get_lr_scheduler(self, args, optimizer, num_processes):
        if args.optimizer_type in ADEMAMIX_OPTIMIZERS:
            # The trainer has now resolved epochs to actual optimizer steps.
            # Explicit zero disables the ramp; None requests the full duration.
            for group in optimizer.param_groups:
                for key in ('t_alpha', 't_beta3'):
                    if group.get(key) is None:
                        group[key] = args.max_train_steps
        return super().get_lr_scheduler(args, optimizer, num_processes)

    def generate_step_logs(self, args, current_loss, avr_loss, lr_scheduler, lr_descriptions,
                           optimizer=None, keys_scaled=None, mean_norm=None, maximum_norm=None):
        from tools.python_startup.lr_logging import read_learning_rates, optimizer_from_scheduler
        optimizer = optimizer if optimizer is not None else optimizer_from_scheduler(lr_scheduler)
        scheduler_view = SimpleNamespace(get_last_lr=lambda: read_learning_rates(optimizer, lr_scheduler),
                                         optimizers=[optimizer])
        return super().generate_step_logs(args, current_loss, avr_loss, scheduler_view, lr_descriptions,
                                         optimizer, keys_scaled, mean_norm, maximum_norm)


def main():
    parser = krea2_setup_parser(setup_parser_common())
    args = read_config_from_file(parser.parse_args(), parser)
    args.dit_dtype = 'bfloat16'
    if args.vae_dtype is None:
        args.vae_dtype = 'bfloat16'
    Krea2Trainer().train(args)


if __name__ == '__main__':
    main()
