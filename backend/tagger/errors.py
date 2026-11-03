"""Stable identifiers for user-facing Tagger validation errors."""


class TaggerUserError(ValueError):
    def __init__(self, code: str, message: str, **params):
        super().__init__(message)
        self.code = code
        self.params = params


def error_data(error):
    if isinstance(error, TaggerUserError):
        return {"errorCode": error.code, "errorParams": error.params}
    return None
