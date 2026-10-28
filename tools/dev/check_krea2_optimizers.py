"""Run all product optimizers on real, reduced-width Krea layers and resume state.

venv/Scripts/python.exe -B tools/dev/check_krea2_optimizers.py --device cuda
"""
import argparse
import copy
import json
import os
from pathlib import Path
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[2]
sys.path[:0] = [str(ROOT), str(ROOT / 'vendor/musubi-tuner/src'), str(ROOT / 'vendor')]
from tools.runtime_paths import configure_test_paths
configure_test_paths()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--device', choices=('cpu', 'cuda'), default='cuda')
    parser.add_argument('--optimizer', default='')
    parser.add_argument('--advanced', action='store_true')
    options = parser.parse_args()
    os.environ['LYCORIS_KERNEL_BACKEND'] = 'torch'
    os.environ['ANIMA_ENABLE_FLASH_ATTN'] = '0'
    import torch
    from accelerate import Accelerator
    from musubi_tuner.krea2.krea2_mmdit import SingleStreamDiT, SingleMMDiTConfig
    from backend.training.execution.krea2_train import Krea2Trainer, krea2_setup_parser, setup_parser_common
    from backend.training.config.musubi_krea2 import KREA2_FIELDS, validate_krea2_config, build_krea2_train_config
    from backend.training.fields.optimizer_metadata import optimizer_entries, KREA2_PROFILE
    from backend.training.config.krea2_network import build_krea2_network_preset, KREA2_PRESET_FILENAME
    from backend.training.config import toml_writer
    from backend.training.config.config_import import import_native_training_form

    torch.set_num_threads(2)
    torch.manual_seed(123)
    device = torch.device(options.device)
    accelerator = Accelerator(cpu=device.type == 'cpu', mixed_precision='bf16' if device.type == 'cuda' else 'no')
    records = []
    optimizers = [entry for entry in optimizer_entries(KREA2_PROFILE)
                  if not options.optimizer or options.optimizer in (entry.selector, entry.label)]
    assert optimizers, options.optimizer
    for entry in optimizers:
        for algorithm in ('native', 'lora'):
            with tempfile.TemporaryDirectory() as temp:
                directory = Path(temp)
                form = {field['key']: field['default'] for field in KREA2_FIELDS if 'default' in field}
                # 64 x 64 factors also exercise actual 8-bit optimizer states.
                form.update(optimizer_type=entry.selector, network_dim=64, network_alpha=32,
                            krea_target_mode='attention', krea_training_duration_mode='steps', max_train_steps=4,
                            krea_adafactor_relative_step=False, learning_rate='1e-3', max_grad_norm=0,
                            mixed_precision='bf16')
                # Keep the form production-valid; CPU probes use FP32 via the accelerator above.
                if 'Prodigy' in entry.selector:
                    form['learning_rate'] = '1.0'
                if entry.label == 'EmoSens':
                    form.update(learning_rate='0.1', notify=False)
                if entry.label == 'SOAP':
                    form.update(max_precondition_dim=64, precondition_frequency=2)
                if options.advanced:
                    form.update({
                        'AdamW': dict(krea_adamw_fused='true', krea_optimizer_betas='0.8, 0.95', krea_optimizer_eps='1e-7'),
                        'AdamW8bit': dict(bnb_min_8bit_size=128, krea_optimizer_betas='0.8, 0.95'),
                        'PagedAdamW8bit': dict(bnb_min_8bit_size=128),
                        'Lion8bit': dict(bnb_min_8bit_size=128), 'PagedLion8bit': dict(bnb_min_8bit_size=128),
                        'StableAdamW': dict(stableadamw_kahan_sum=False, stableadamw_weight_decouple=False),
                        'CAME': dict(came_weight_decouple=True, came_fixed_decay=True, came_clip_threshold=0.7,
                                     came_ams_bound=True, came_eps1='1e-20', came_eps2='1e-10'),
                        'Adan': dict(adan_weight_decouple=False, krea_optimizer_betas='0.9, 0.8, 0.99'),
                        'AdEMAMix': dict(ademamix_alpha=3, ademamix_t_alpha=0, ademamix_t_beta3=5),
                        'AdEMAMix8bit': dict(ademamix_alpha=3, ademamix_t_alpha=5, ademamix_t_beta3=0),
                        'Prodigy': dict(krea_prodigy_d_coef=0.8, krea_prodigy_d0='2e-6', prodigy_safeguard_warmup=True),
                        'ProdigyPlusScheduleFree': dict(krea_prodigyplus_use_stableadamw=False, d_limiter=False,
                            schedulefree_c=6, prodigy_steps=10, use_bias_correction=True, use_speed=True,
                            use_cautious=True, use_orthograd=True, factored=False, factored_fp32=False,
                            split_groups=False, split_groups_mean=True, weight_decay_by_lr=False),
                        'AdamWScheduleFree': dict(krea_schedulefree_warmup_steps=2),
                        'AdaFactor': dict(krea_adafactor_scale_parameter=False, krea_adafactor_clip_threshold=0.8,
                                          krea_adafactor_eps='1e-20, 1e-4'),
                        'Automagic3': dict(automagic_min_lr='1e-7', automagic_max_lr=0.1, automagic_beta2=0.98,
                            automagic_clip_threshold=0.8, automagic_polarity_history=4, automagic_fused=True),
                        'EmoSens': dict(stopcoef=0.02, use_shadow=True),
                        'Muon': dict(muon_adjust_lr_fn='original', muon_momentum=0.9, muon_nesterov=False,
                                     muon_ns_steps=3, muon_ns_coefficients='3.4445, -4.775, 2.0315'),
                        'LoRA-Muon': dict(momentum=0.8, ns_steps=4, inv_sqrt_steps=3, msign_eps='1e-18',
                            inv_sqrt_eps='1e-4', inv_sqrt_gamma=1.01, gauge_rebalance=True,
                            gauge_rebalance_alpha=0.8, gauge_rebalance_interval=2, gauge_power_steps=3),
                        'LoRA-RITE': dict(lorarite_clip_unmagnified_grad=0.5),
                        'SOAP': dict(max_precondition_dim=32, precondition_frequency=1, shampoo_beta=0.9,
                                     normalize_gradient=True, correct_bias=False, precondition_1d=True),
                    }.get(entry.label, {}))
                if algorithm == 'lora':
                    form.update(network_module='lycoris.kohya', lycoris_algo='lora')
                errors = validate_krea2_config(form)
                assert not errors, (entry.label, algorithm, errors)
                native = build_krea2_train_config(form, directory / 'dataset.toml', directory, directory / 'log')
                # The exact emitted optimizer literals must survive import/export.
                optimizer_form = import_native_training_form({key: value for key, value in native.items()
                    if key in ('optimizer_type', 'optimizer_args')}, profile_id='krea2-lora')
                from backend.training.config.musubi_krea2 import _build_krea2_optimizer_args
                assert set(_build_krea2_optimizer_args(optimizer_form)) == set(native.get('optimizer_args', []))
                (directory / KREA2_PRESET_FILENAME).write_text(toml_writer.dumps(build_krea2_network_preset(form)), encoding='utf-8')
                args = krea2_setup_parser(setup_parser_common()).parse_args([])
                for key, value in native.items():
                    setattr(args, key, value)
                args.dit_dtype = 'bfloat16'
                def make():
                    torch.manual_seed(456)
                    base = SingleStreamDiT(SingleMMDiTConfig(features=64, tdim=16, txtdim=64, heads=2,
                        multiplier=1, patch=1, channels=4, kvheads=1, txtlayers=2, txtheads=2,
                        txtkvheads=1, layers=2), attn_mode='torch', split_attn=False).to(device)
                    base.requires_grad_(False)
                    trainer = Krea2Trainer()
                    network = trainer._build_network(args, accelerator, base, None, torch.float32).to(device)
                    groups, descriptions = network.prepare_optimizer_params(unet_lr=float(form['learning_rate']))
                    groups = trainer.extra_trainable_params(args, accelerator, network, base, groups)
                    _, _, optimizer, train_fn, eval_fn = trainer.get_optimizer(args, groups)
                    scheduler = trainer.get_lr_scheduler(args, optimizer, 1)
                    return base, network, optimizer, scheduler, train_fn, eval_fn
                base, network, optimizer, scheduler, train_fn, eval_fn = make()
                train_fn()
                before = {key: value.clone() for key, value in network.state_dict().items()}
                inputs = (torch.randn(1, 4, 4, device=device), torch.randn(1, 2, 2, 64, device=device),
                          torch.tensor([0.5], device=device), torch.zeros(1, 6, 3, device=device),
                          torch.ones(1, 6, device=device, dtype=torch.bool))
                losses = []
                def step(base, network, optimizer, scheduler):
                    base.train()
                    network.train()
                    optimizer.zero_grad(set_to_none=True)
                    with accelerator.autocast():
                        loss = base(*inputs).float().square().mean()
                    assert torch.isfinite(loss)
                    # Fused backward updates and releases gradients immediately.
                    finite_gradients = []
                    def capture_gradient(gradient):
                        finite_gradients.append(bool(torch.isfinite(gradient).all()))
                    handles = [p.register_hook(capture_gradient) for p in network.parameters() if p.requires_grad]
                    try:
                        accelerator.backward(loss)
                    finally:
                        for handle in handles:
                            handle.remove()
                    assert finite_gradients and all(finite_gradients)
                    optimizer.step()
                    scheduler.step()
                    assert all(torch.isfinite(p).all() for p in network.parameters())
                    return float(loss.detach())
                steps = 12 if options.advanced and entry.label == 'ProdigyPlusScheduleFree' else 3
                for _ in range(steps):
                    losses.append(step(base, network, optimizer, scheduler))
                assert any(not torch.equal(value, before[key]) for key, value in network.state_dict().items())
                if '8bit' in entry.label:
                    assert any(value.dtype == torch.uint8 for state in optimizer.state.values()
                               for value in state.values() if isinstance(value, torch.Tensor)), '8-bit states were not exercised'
                from tools.python_startup.lr_logging import read_learning_rates
                logs = Krea2Trainer().generate_step_logs(args, losses[-1], sum(losses) / len(losses), scheduler, None, optimizer)
                assert [value for key, value in logs.items() if key.startswith('lr/') and not key.startswith('lr/d*')] == read_learning_rates(optimizer, scheduler)
                state = copy.deepcopy(optimizer.state_dict())
                saved_weights = {key: value.detach().clone() for key, value in network.state_dict().items()}
                # Recreate the actual optimizer and verify the next update matches.
                restored_base, restored, restored_optimizer, restored_scheduler, restored_train, _ = make()
                restored.load_state_dict(saved_weights)
                restored_optimizer.load_state_dict(copy.deepcopy(state))
                if hasattr(scheduler, 'state_dict'):
                    restored_scheduler.load_state_dict(scheduler.state_dict())
                restored_train()
                step(base, network, optimizer, scheduler)
                step(restored_base, restored, restored_optimizer, restored_scheduler)
                for key, value in network.state_dict().items():
                    torch.testing.assert_close(value, restored.state_dict()[key], atol=2e-5, rtol=2e-4)
                eval_fn()
                record = dict(optimizer=entry.label, network=algorithm, losses=losses, state_resume='passed')
                records.append(record)
                print(json.dumps(record), flush=True)
                del base, network, optimizer, scheduler, restored_base, restored, restored_optimizer, restored_scheduler
    directory = ROOT / 'cache/dev/krea2-parameter-audit'
    directory.mkdir(parents=True, exist_ok=True)
    suffix = '-advanced' if options.advanced else ''
    (directory / f'optimizer-runtime-{options.device}{suffix}.json').write_text(json.dumps(records, indent=2), encoding='utf-8')
    print(f'Passed {len(records)} optimizer/network cases', flush=True)


if __name__ == '__main__':
    main()
