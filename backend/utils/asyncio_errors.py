"""Keep Windows disconnect cleanup quiet without hiding application errors."""
import asyncio
import sys
from contextlib import contextmanager


def _reset_transport(context):
    error = context.get("exception")
    if (not isinstance(error, ConnectionResetError)
            or getattr(error, "winerror", None) != 10054
            or error.__context__ is not None or error.__cause__ is not None):
        return None

    # Only a clean close may be quiet. A reset during a request, protocol
    # callback, or a close already carrying an error must still be reported.
    from asyncio.proactor_events import _ProactorBasePipeTransport

    handle = context.get("handle")
    callback = getattr(handle, "_callback", None)
    close_callback = _ProactorBasePipeTransport._call_connection_lost
    if (getattr(callback, "__func__", None) is not close_callback
            or getattr(handle, "_args", None) != (None,)):
        return None
    traceback = error.__traceback__
    if traceback is None:
        return None
    while traceback.tb_next is not None:
        traceback = traceback.tb_next
    if traceback.tb_frame.f_code is not close_callback.__code__:
        return None
    return callback.__self__


@contextmanager
def windows_disconnect_handler():
    """Scope the filter to the running application, including its shutdown."""
    if sys.platform != "win32":
        yield
        return

    loop = asyncio.get_running_loop()
    previous = loop.get_exception_handler()

    def handle_exception(loop, context):
        transport = _reset_transport(context)
        if transport is not None:
            try:
                # CPython 3.12 skips these steps when shutdown() raises.
                # Finish closing once; do not call protocol.connection_lost again.
                transport._sock.close()
                transport._sock = None
                if transport._server is not None:
                    transport._server._detach()
                    transport._server = None
                transport._called_connection_lost = True
            except Exception as error:
                context = {**context, "exception": error,
                           "message": "Windows disconnect cleanup failed"}
            else:
                return
        if previous is not None:
            previous(loop, context)
        else:
            loop.default_exception_handler(context)

    loop.set_exception_handler(handle_exception)
    try:
        yield
    finally:
        if loop.get_exception_handler() is handle_exception:
            loop.set_exception_handler(previous)
