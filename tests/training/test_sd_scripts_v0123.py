"""Release integration: persisted behavior, native args, preview parity and INT8 compilation."""
import unittest

from backend.training.config.config_import import import_native_training_form


class ReleaseConfigTests(unittest.TestCase):

    def test_sparse_native_import_keeps_argparse_defaults_and_explicit_old_values(self):
        form = import_native_training_form({"network_module": "networks.lora_generic"})
        self.assertEqual(form["timestep_sampling"], "sigmoid")
        self.assertEqual(form["weighting_scheme"], "uniform")
        self.assertEqual(form["logit_mean"], 0)
        old = {"network_module": "networks.lora_generic", "timestep_sampling": "sigma",
               "weighting_scheme": "logit_normal", "logit_mean": -1.09, "logit_std": 0.95}
        restored = import_native_training_form(old)
        for key, value in old.items():
            self.assertEqual(restored[key], value)
