"""Stable identifiers for user-facing Tagger validation errors."""


class _CodedErrorMixin:
    def __init__(self, code: str, message: str, **params):
        super().__init__(message)
        self.code = code
        self.params = params


class TaggerUserError(_CodedErrorMixin, ValueError):
    pass


class TaggerRuntimeError(_CodedErrorMixin, RuntimeError):
    pass


class TaggerNotFoundError(_CodedErrorMixin, KeyError):
    pass


class TaggerIndexError(_CodedErrorMixin, IndexError):
    pass


def error_data(error):
    if isinstance(error, _CodedErrorMixin):
        return {"errorCode": error.code, "errorParams": error.params}
    return None
