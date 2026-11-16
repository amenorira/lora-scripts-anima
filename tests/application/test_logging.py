"""Routine HTTP chatter stays quiet while warnings and failures remain visible."""
import logging
import unittest
from unittest.mock import Mock

from backend import log as app_log  # noqa: F401 -- install the application's log filters


class HttpLoggingTests(unittest.TestCase):
    def test_http_logging_remains_filtered_after_level_reconfiguration(self):
        for name in ("httpx", "httpcore"):
            with self.subTest(logger=name):
                logger = logging.getLogger(name)
                original = logger.level, logger.handlers[:], logger.propagate, logger.disabled
                output = logging.Handler()
                output.emit = Mock()
                logger.setLevel(logging.DEBUG)
                logger.handlers = [output]
                logger.propagate = False
                logger.disabled = False
                try:
                    logger.debug("connection details")
                    logger.info("HTTP Request: GET https://example.invalid HTTP/1.1 200 OK")
                    output.emit.assert_not_called()
                    logger.warning("request warning")
                    logger.error("request failed")
                    self.assertEqual(
                        [call.args[0].levelno for call in output.emit.call_args_list],
                        [logging.WARNING, logging.ERROR],
                    )
                finally:
                    logger.setLevel(original[0])
                    logger.handlers, logger.propagate, logger.disabled = original[1:]
