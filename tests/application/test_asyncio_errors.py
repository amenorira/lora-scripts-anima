"""Only the native Windows reset during clean transport shutdown is quiet."""
import asyncio
from asyncio.proactor_events import _ProactorBasePipeTransport
from contextlib import asynccontextmanager, contextmanager
from types import TracebackType
import unittest
from unittest.mock import Mock, patch

from backend.utils import asyncio_errors


def reset_error(code=10054):
    error = ConnectionResetError("connection reset")
    error.winerror = code
    return error


def close_context(loop, error, *, close_error=None, protocol_error=None):
    transport = _ProactorBasePipeTransport(loop, Mock(), Mock(), server=Mock())
    # The scheduled connection_made is immaterial to the shutdown under test.
    transport._sock.shutdown.side_effect = error
    transport._protocol.connection_lost.side_effect = protocol_error
    handle = asyncio.Handle(transport._call_connection_lost, (close_error,), loop)
    try:
        transport._call_connection_lost(close_error)
    except Exception as caught:
        if protocol_error is None:
            # Native socket.shutdown adds no Python frame. Remove the mock's
            # frames so this fixture has the same traceback as Winsock.
            tb = caught.__traceback__.tb_next
            caught.__traceback__ = TracebackType(None, tb.tb_frame, tb.tb_lasti, tb.tb_lineno)
        context = {"message": "Exception in callback", "exception": caught, "handle": handle}
    return transport, context


class DisconnectHandlerTests(unittest.IsolatedAsyncioTestCase):
    @contextmanager
    def handler(self, previous=None):
        loop = asyncio.get_running_loop()
        original = loop.get_exception_handler()
        loop.set_exception_handler(previous)
        try:
            with patch.object(asyncio_errors.sys, "platform", "win32"), \
                    patch.object(loop, "default_exception_handler") as default:
                try:
                    with asyncio_errors.windows_disconnect_handler():
                        yield loop, default
                finally:
                    self.assertIs(loop.get_exception_handler(), previous)
        finally:
            loop.set_exception_handler(original)

    async def test_clean_reset_is_quiet_and_finishes_cleanup_once(self):
        with self.handler() as (loop, default):
            transport, context = close_context(loop, reset_error())
            sock, server, protocol = transport._sock, transport._server, transport._protocol
            loop.call_exception_handler(context)
            default.assert_not_called()
            sock.close.assert_called_once_with()
            server._detach.assert_called_once_with()
            self.assertIsNone(transport._sock)
            self.assertIsNone(transport._server)
            self.assertTrue(transport._called_connection_lost)
            transport._call_connection_lost(None)
            protocol.connection_lost.assert_called_once_with(None)

    async def test_other_close_errors_keep_the_original_context(self):
        errors = [reset_error(10053), RuntimeError("broken cleanup"), OSError("I/O failure")]
        errors[-1].winerror = 10054
        with self.handler() as (loop, default):
            for error in errors:
                with self.subTest(error=error):
                    transport, context = close_context(loop, error)
                    loop.call_exception_handler(context)
                    default.assert_called_once_with(context)
                    transport._sock.close.assert_not_called()
                    default.reset_mock()
                    transport._sock = None

    async def test_existing_close_error_and_chained_errors_are_reported(self):
        previous = Mock()
        with self.handler(previous) as (loop, default):
            for kind in ("close argument", "context", "cause"):
                with self.subTest(kind=kind):
                    original = ValueError("protocol failed")
                    error = reset_error()
                    transport, context = close_context(
                        loop, error, close_error=original if kind == "close argument" else None)
                    if kind == "context":
                        error.__context__ = original
                    elif kind == "cause":
                        error.__cause__ = original
                    loop.call_exception_handler(context)
                    previous.assert_called_once_with(loop, context)
                    default.assert_not_called()
                    previous.reset_mock()
                    transport._sock = None

    async def test_protocol_reset_is_still_reported(self):
        with self.handler() as (loop, default):
            transport, context = close_context(
                loop, None, protocol_error=reset_error())
            loop.call_exception_handler(context)
            default.assert_called_once_with(context)

    async def test_request_and_task_resets_are_still_reported(self):
        with self.handler() as (loop, default):
            transport, context = close_context(loop, reset_error())
            for handle in (None, asyncio.Handle(Mock(), (None,), loop)):
                with self.subTest(handle=handle):
                    unrelated = {**context, "handle": handle}
                    loop.call_exception_handler(unrelated)
                    default.assert_called_once_with(unrelated)
                    default.reset_mock()
            transport._sock = None

    async def test_cleanup_failure_is_reported_to_previous_handler(self):
        previous = Mock()
        with self.handler(previous) as (loop, default):
            transport, context = close_context(loop, reset_error())
            error = RuntimeError("socket close failed")
            transport._sock.close.side_effect = error
            loop.call_exception_handler(context)
            reported_loop, reported = previous.call_args.args
            self.assertIs(reported_loop, loop)
            self.assertIs(reported["exception"], error)
            self.assertIs(reported["handle"], context["handle"])
            default.assert_not_called()
            transport._sock = None

    async def test_handler_is_restored_after_lifespan_failure(self):
        previous = Mock()
        with self.assertRaisesRegex(RuntimeError, "startup failed"):
            with self.handler(previous):
                raise RuntimeError("startup failed")

    async def test_application_scopes_handler_to_startup_and_shutdown(self):
        from backend.server import application

        loop = asyncio.get_running_loop()
        previous = loop.get_exception_handler()
        stages = []

        @asynccontextmanager
        async def application_lifespan(app):
            self.assertIsNot(loop.get_exception_handler(), previous)
            stages.append("startup")
            try:
                yield
            finally:
                self.assertIsNot(loop.get_exception_handler(), previous)
                stages.append("shutdown")

        with patch.object(asyncio_errors.sys, "platform", "win32"), \
                patch.object(application, "_application_lifespan", application_lifespan):
            with self.assertRaisesRegex(RuntimeError, "application failed"):
                async with application.lifespan(application.app):
                    stages.append("application")
                    raise RuntimeError("application failed")
        self.assertEqual(stages, ["startup", "application", "shutdown"])
        self.assertIs(loop.get_exception_handler(), previous)

    async def test_non_windows_handler_is_unchanged(self):
        loop = asyncio.get_running_loop()
        previous = loop.get_exception_handler()
        with patch.object(asyncio_errors.sys, "platform", "linux"):
            with asyncio_errors.windows_disconnect_handler():
                self.assertIs(loop.get_exception_handler(), previous)
