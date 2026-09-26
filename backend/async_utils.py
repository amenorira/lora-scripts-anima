"""Small helpers for async routes that own synchronous worker resources."""

import asyncio


async def settled_to_thread(func, *args, **kwargs):
    """Wait for disk/GPU work to settle even when its HTTP waiter is cancelled."""
    worker = asyncio.create_task(asyncio.to_thread(func, *args, **kwargs))
    try:
        return await asyncio.shield(worker)
    except asyncio.CancelledError:
        while not worker.done():
            try:
                await asyncio.shield(worker)
            except asyncio.CancelledError:
                continue
            except Exception:
                break
        if worker.done() and not worker.cancelled():
            worker.exception()
        raise
