// Executed by the pinned Hermes Python at image build and by the runtime user at launch.
export const hermesWorkspaceReconciler = String.raw`
import base64
from contextlib import contextmanager, suppress
import errno
import fcntl
import hashlib
import json
import os
from pathlib import Path
import stat
import sys
import uuid

INDEX = ".spawnfile-hermes-assets.json"
MOLTNET = (".moltnet/config.json", ".agents/skills/moltnet/SKILL.md")
MAX_FILES = 2048
MAX_FILE = 8 * 1024 * 1024
MAX_SEED = 64 * 1024 * 1024
DIR_FLAGS = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
FILE_FLAGS = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK


class Conflict(Exception):
    pass


def valid_path(name):
    if not isinstance(name, str) or not name or len(name) > 1024:
        return False
    parts = name.split("/")
    if any(p in ("", ".", "..") or "\\" in p or any(ord(c) < 32 for c in p) for p in parts):
        return False
    return (name in MOLTNET or name in ("AGENTS.md", "HEARTBEAT.md", "IDENTITY.md", "MEMORY.md", "SOUL.md")
            or (parts[0] == "extras" and len(parts) >= 2 and name.endswith(".md"))
            or (parts[0] == "skills" and len(parts) == 3 and parts[-1] == "SKILL.md"))


@contextmanager
def parent_dir(root, name, create=False):
    current = os.dup(root)
    try:
        parts = name.split("/")
        for part in parts[:-1]:
            try:
                child = os.open(part, DIR_FLAGS, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                with suppress(FileExistsError):
                    os.mkdir(part, 0o755, dir_fd=current)
                child = os.open(part, DIR_FLAGS, dir_fd=current)
            os.close(current)
            current = child
        yield current, parts[-1]
    finally:
        os.close(current)


def identity(info):
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns


def read_file(parent, name, limit=MAX_FILE):
    fd = os.open(name, FILE_FLAGS, dir_fd=parent)
    with os.fdopen(fd, "rb") as source:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size > limit:
            raise Conflict()
        contents = source.read(limit + 1)
        if len(contents) > limit or identity(os.fstat(fd)) != identity(info):
            raise Conflict()
        return contents, identity(info)


def digest(contents):
    return hashlib.sha256(contents).hexdigest()


def unchanged(parent, name, previous):
    return identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) == previous


def publish(parent, name, contents, mode, previous=None):
    temporary = ".spawnfile-asset-" + uuid.uuid4().hex
    try:
        fd = os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, mode, dir_fd=parent)
        with os.fdopen(fd, "wb") as output:
            output.write(contents)
            output.flush()
            os.fsync(fd)
        if previous is None:
            os.link(temporary, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
        elif unchanged(parent, name, previous):
            os.replace(temporary, name, src_dir_fd=parent, dst_dir_fd=parent)
        else:
            raise Conflict()
    finally:
        with suppress(FileNotFoundError):
            os.unlink(temporary, dir_fd=parent)


def capture(root, manifest, seed):
    names = set(json.loads(Path(manifest).read_text())) | set(MOLTNET)
    if len(names) > MAX_FILES or not all(map(valid_path, names)):
        raise ValueError("invalid Hermes workspace asset declaration")
    snapshot = {}
    size = 0
    for name in sorted(names):
        try:
            with parent_dir(root, name) as (parent, leaf):
                contents, _ = read_file(parent, leaf)
        except FileNotFoundError:
            if name in MOLTNET:
                continue
            raise
        size += len(contents)
        if size > MAX_SEED:
            raise ValueError("Hermes workspace assets exceed the image seed limit")
        snapshot[name] = base64.b64encode(contents).decode("ascii")
    directory = os.open(seed.parent, DIR_FLAGS)
    try:
        try:
            previous = identity(os.stat(seed.name, dir_fd=directory, follow_symlinks=False))
        except FileNotFoundError:
            previous = None
        publish(directory, seed.name, json.dumps(snapshot).encode(), 0o444, previous)
    finally:
        os.close(directory)


def reconcile_one(root, name, prior, desired):
    try:
        with parent_dir(root, name, create=prior is None and desired is not None) as (parent, leaf):
            try:
                contents, previous = read_file(parent, leaf)
            except FileNotFoundError:
                if prior is None and desired is not None:
                    publish(parent, leaf, desired, 0o600 if name == MOLTNET[0] else 0o644)
                    return digest(desired)
                return prior if desired is not None else None
            current = digest(contents)
            if desired is not None and current == digest(desired):
                return current
            if current != prior:
                return prior if desired is not None else None
            if desired is None:
                if unchanged(parent, leaf, previous):
                    os.unlink(leaf, dir_fd=parent)
                return None
            publish(parent, leaf, desired, 0o600 if name == MOLTNET[0] else 0o644, previous)
            return digest(desired)
    except FileNotFoundError:
        return prior if desired is not None else None
    except (Conflict, FileExistsError):
        return prior if desired is not None else None
    except OSError as error:
        if error.errno not in (errno.ELOOP, errno.ENOTDIR, errno.EACCES, errno.EPERM, errno.EROFS):
            raise
        return prior if desired is not None else None


def restore(root, seed):
    fcntl.flock(root, fcntl.LOCK_EX)
    try:
        raw, previous = read_file(root, INDEX, 4 * 1024 * 1024)
        old = json.loads(raw)
        if (not isinstance(old, dict) or len(old) > MAX_FILES or
                not all(valid_path(name) and isinstance(value, str) and len(value) == 64 for name, value in old.items())):
            raise ValueError("invalid Hermes workspace asset index")
    except FileNotFoundError:
        old, previous = {}, None
    snapshot = json.loads(seed.read_bytes())
    current = {}
    for name in sorted(set(old) | set(snapshot)):
        desired = base64.b64decode(snapshot[name], validate=True) if name in snapshot else None
        owned = reconcile_one(root, name, old.get(name), desired)
        if owned is not None:
            current[name] = owned
    if current != old or previous is None:
        publish(root, INDEX, json.dumps(current).encode(), 0o600, previous)
    fcntl.flock(root, fcntl.LOCK_UN)


if __name__ == "__main__":
    seed = Path(__file__).with_name("seed.json")
    if sys.argv[1] == "capture":
        handle = os.open(sys.argv[2], DIR_FLAGS)
        try:
            capture(handle, sys.argv[3], seed)
        finally:
            os.close(handle)
    else:
        try:
            handle = os.open(sys.argv[1], DIR_FLAGS)
            try:
                restore(handle, seed)
            finally:
                os.close(handle)
        except (OSError, ValueError, Conflict):
            sys.exit("Could not reconcile the compiler-owned Hermes workspace assets.")
        os.execvp(sys.argv[2], sys.argv[2:])
`;
