"""Archive or restore loose legacy Cachegrind JSON files using the Python stdlib."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import tempfile
import zipfile


ARCHIVE = "parsed-cache.zip"
INDEX = "manifest.json"
CACHE_NAME = re.compile(r"cachegrind\.[A-Za-z0-9.-]+\.json")
REPARSE_POINT = stat.FILE_ATTRIBUTE_REPARSE_POINT


def directory(value):
    path = Path(os.path.abspath(value))
    parts = [part.lower() for part in path.parts]
    if any(parts[i:i + 2] == [".local", ".cursor"] for i in range(len(parts))):
        raise ValueError("The private Cursor directory is outside this workflow.")
    for entry in (*reversed(path.parents), path):
        info = entry.lstat()
        if not stat.S_ISDIR(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE_POINT:
            raise ValueError(f"Expected a directory without links: {entry}")
    return path


def regular(file):
    info = file.lstat()
    if not stat.S_ISREG(info.st_mode) or getattr(info, "st_file_attributes", 0) & REPARSE_POINT:
        raise ValueError(f"Expected a regular file: {file}")
    return info


def identify(data):
    return {"bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()}


def identity(file):
    info = regular(file)
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def checked_index(archive):
    """Read and verify every member before using an archive."""
    names = archive.namelist()
    manifest = json.loads(archive.read(INDEX))
    entries = manifest.get("files")
    if manifest.get("kind") != "wp-hotspot-parsed-cache-v1" or not isinstance(entries, dict):
        raise ValueError("Unsupported parsed cache archive.")
    if len(names) != len(entries) + 1 or set(names) != {INDEX, *entries} or len({name.lower() for name in names}) != len(names):
        raise ValueError("Unexpected or duplicate archive member.")
    for name, expected in entries.items():
        if not CACHE_NAME.fullmatch(name) or identify(archive.read(name)) != expected:
            raise ValueError(f"Invalid archive member or hash: {name}")
    return entries


def publish(file, write):
    """Stage beside the target and publish without replacing an existing file."""
    fd, name = tempfile.mkstemp(dir=file.parent, prefix=".parsed-cache-")
    temp = Path(name)
    try:
        with os.fdopen(fd, "w+b") as stream:
            write(stream)
            stream.flush()
            os.fsync(stream.fileno())
        os.link(temp, file)
    finally:
        temp.unlink()


def write_archive(stream, files):
    with zipfile.ZipFile(stream, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        entries = {}
        for file in files:
            regular(file)
            data = file.read_bytes()
            if not isinstance(json.loads(data), dict):
                raise ValueError(f"Expected a parsed Cachegrind JSON object: {file}")
            archive.writestr(file.name, data)
            entries[file.name] = identify(data)
        archive.writestr(INDEX, json.dumps({
            "kind": "wp-hotspot-parsed-cache-v1", "files": entries,
        }, indent=2))
    with zipfile.ZipFile(stream) as archive:
        checked_index(archive)


def matches(file, expected):
    before = identity(file)
    if identify(file.read_bytes()) != expected or identity(file) != before:
        raise ValueError(f"Loose file differs from the archive: {file}")


def pack(root, apply):
    files = sorted(file for file in root.iterdir() if CACHE_NAME.fullmatch(file.name))
    result = {"looseFiles": len(files), "looseBytes": sum(regular(file).st_size for file in files)}
    target = root / ARCHIVE
    if not os.path.lexists(target):
        if not files or not apply:
            return result
        publish(target, lambda stream: write_archive(stream, files))
    archive_info = identity(target)
    with zipfile.ZipFile(target) as archive:
        entries = checked_index(archive)
    if identity(target) != archive_info:
        raise ValueError("Archive changed during verification.")
    for file in files:
        if file.name not in entries:
            raise ValueError(f"Existing archive has no member for {file.name}.")
        matches(file, entries[file.name])
    result["archiveBytes"] = archive_info[2]
    if apply and files:
        for file in files:
            # A retry can remove any remaining copies after an interrupted pack.
            directory(root)
            if identity(target) != archive_info:
                raise ValueError("Archive changed during cleanup.")
            matches(file, entries[file.name])
            file.unlink()
        result["removed"] = len(files)
    return result


def restore(root, apply):
    target = root / ARCHIVE
    regular(target)
    with zipfile.ZipFile(target) as archive:
        entries = checked_index(archive)
        pending = []
        for name, expected in entries.items():
            file = root / name
            if os.path.lexists(file):
                matches(file, expected)
            else:
                pending.append(file)
        if apply:
            for file in pending:
                directory(root)
                data = archive.read(file.name)
                if identify(data) != entries[file.name]:
                    raise ValueError(f"Archive member changed: {file.name}")
                publish(file, lambda stream: stream.write(data))
    return {"archiveFiles": len(entries), "missingFiles": len(pending), "restored": len(pending) if apply else 0}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("pack", "restore"))
    parser.add_argument("--input", required=True, help="The exact legacy parsed-profile directory")
    parser.add_argument("--apply", action="store_true", help="Perform the previewed operation")
    args = parser.parse_args()
    try:
        root = directory(args.input)
        result = (pack if args.command == "pack" else restore)(root, args.apply)
        print(json.dumps({"directory": str(root), "applied": args.apply, **result}))
    except (OSError, ValueError, KeyError, TypeError, AttributeError, zipfile.BadZipFile) as error:
        parser.exit(1, f"{error}\n")


if __name__ == "__main__":
    main()
