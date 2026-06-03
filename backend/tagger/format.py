import re
import hashlib
from datetime import datetime

from typing import Dict, Callable, NamedTuple
from pathlib import Path


class Info(NamedTuple):
    path: Path
    output_ext: str


def hash(i: Info, algo='sha1') -> str:
    try:
        hasher = hashlib.new(algo)
    except ValueError:
        raise ValueError(f"'{algo}' is invalid hash algorithm")

    # TODO: is okay to hash large image?
    with open(i.path, 'rb') as file:
        for chunk in iter(lambda: file.read(65536), b''):
            hasher.update(chunk)

    return hasher.hexdigest()


def ts(i: Info, fmt='%Y%m%d_%H%M%S') -> str:
    return datetime.now().strftime(fmt)


def date(i: Info, fmt='%Y%m%d') -> str:
    return datetime.now().strftime(fmt)


pattern = re.compile(r'\[([\w:]+)\]')

# all function must returns string or raise TypeError or ValueError
# other errors will cause the extension error
available_formats: Dict[str, Callable] = {
    'name': lambda i: i.path.stem,
    'extension': lambda i: i.path.suffix[1:],
    'hash': hash,
    'timestamp': ts,
    'date': date,

    'output_extension': lambda i: i.output_ext
}


def format(match: re.Match, info: Info) -> str:
    matches = match[1].split(':')
    name, args = matches[0], matches[1:]

    if name not in available_formats:
        return match[0]

    return available_formats[name](info, *args)
