import asyncio
import threading
import unittest
from unittest.mock import patch

from backend.server.routes import training as training_routes


class TrainingCoreStatusTests(unittest.TestCase):
    def test_runtime_probe_runs_outside_the_event_loop_thread(self):
        event_loop_thread = threading.get_ident()
        probe_threads = []

        def fake_profile_payload():
            probe_threads.append(threading.get_ident())
            return {"engines": [], "profiles": [], "adapters": []}

        with patch.object(training_routes, "profile_payload", side_effect=fake_profile_payload):
            asyncio.run(training_routes.training_cores())

        self.assertEqual(len(probe_threads), 1)
        self.assertNotEqual(probe_threads[0], event_loop_thread)


if __name__ == "__main__":
    unittest.main()
