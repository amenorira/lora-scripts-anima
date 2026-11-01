"""Release failed adapter-call locals without touching caller-owned frames."""


def clear_internal_frames(error):
    """Call inside an adapter allocation/compute exception handler.

    Keep traceback locations and exception chains. Only clear completed frames
    called below this handler's frame, including nested causes/contexts. An
    unrelated exception active in the trainer is outside that boundary.
    """
    if error.__traceback__ is None:
        return
    boundary = error.__traceback__.tb_frame
    pending, seen, frames = [error], set(), {}
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        pending.extend(item for item in (current.__cause__, current.__context__) if item is not None)
        if isinstance(current, BaseExceptionGroup):
            pending.extend(current.exceptions)
        trace = current.__traceback__
        while trace is not None:
            frame = trace.tb_frame
            caller = frame.f_back
            while caller is not None and caller is not boundary:
                caller = caller.f_back
            if caller is boundary:
                frames[id(frame)] = frame
            trace = trace.tb_next

    # Collect before clearing: frame ancestry is needed to establish ownership.
    for frame in frames.values():
        try:
            frame.clear()
        except RuntimeError:
            # Never clear an executing (or, on newer Python, suspended) frame.
            pass
