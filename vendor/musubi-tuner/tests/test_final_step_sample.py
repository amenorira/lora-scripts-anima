from musubi_tuner.training.sampling_prompts import should_sample_at_epoch_end


def test_should_sample_at_epoch_end_no_prior_sample():
    assert should_sample_at_epoch_end(global_step=2000, last_sampled_step=None) is True


def test_should_sample_at_epoch_end_skips_duplicate_of_last_step_sample():
    # issue #1048: the in-loop step-based trigger already sampled this exact step.
    assert should_sample_at_epoch_end(global_step=2000, last_sampled_step=2000) is False


def test_should_sample_at_epoch_end_proceeds_for_different_step():
    assert should_sample_at_epoch_end(global_step=2000, last_sampled_step=1500) is True
