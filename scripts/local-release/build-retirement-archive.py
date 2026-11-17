"""Finite, local build-artifact snapshot. No install, network, or source requests."""
import base64
import ctypes
import hashlib
import io
import json
import os
import posixpath
from pathlib import Path
import stat
import struct
import sys
import subprocess
import tarfile

MANIFEST = "WEWE_BUILD_SNAPSHOT_V1.json"
LIMIT = 12000


def digest(file):
    h = hashlib.sha256()
    with open(file, "rb") as source:
        for part in iter(lambda: source.read(1024 * 1024), b""):
            h.update(part)
    return h.hexdigest()


def windows_metadata(file, restore=None, security_only=False, basic_only=False, junction=False):
    if os.name != "nt":
        return None
    from ctypes import wintypes as w
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    security = ctypes.WinDLL("advapi32", use_last_error=True)
    kernel.CreateFileW.restype = w.HANDLE
    kernel.CreateFileW.argtypes = [w.LPCWSTR, w.DWORD, w.DWORD, w.LPVOID, w.DWORD, w.DWORD, w.HANDLE]
    kernel.CloseHandle.argtypes = [w.HANDLE]
    kernel.GetFileInformationByHandleEx.argtypes = [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD]
    kernel.SetFileInformationByHandle.argtypes = [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD]
    security.GetFileSecurityW.argtypes = [w.LPCWSTR, w.DWORD, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD)]
    security.GetSecurityInfo.argtypes = [w.HANDLE, ctypes.c_int, w.DWORD, w.LPVOID, w.LPVOID, w.LPVOID, w.LPVOID, ctypes.POINTER(w.LPVOID)]
    security.GetSecurityInfo.restype = w.DWORD
    security.GetSecurityDescriptorLength.argtypes = [w.LPVOID]
    security.GetSecurityDescriptorLength.restype = w.DWORD
    security.SetFileSecurityW.argtypes = [w.LPCWSTR, w.DWORD, w.LPVOID]
    security.GetSecurityDescriptorControl.argtypes = [w.LPVOID, ctypes.POINTER(w.WORD), ctypes.POINTER(w.DWORD)]
    security.GetSecurityDescriptorOwner.argtypes = [w.LPVOID, ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.BOOL)]
    security.GetSecurityDescriptorGroup.argtypes = [w.LPVOID, ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.BOOL)]
    security.GetSecurityDescriptorDacl.argtypes = [w.LPVOID, ctypes.POINTER(w.BOOL), ctypes.POINTER(w.LPVOID), ctypes.POINTER(w.BOOL)]
    security.SetNamedSecurityInfoW.argtypes = [w.LPWSTR, ctypes.c_int, w.DWORD, w.LPVOID, w.LPVOID, w.LPVOID, w.LPVOID]
    security.SetNamedSecurityInfoW.restype = w.DWORD
    security.ConvertSecurityDescriptorToStringSecurityDescriptorW.argtypes = [w.LPVOID, w.DWORD, w.DWORD, ctypes.POINTER(w.LPWSTR), ctypes.POINTER(w.DWORD)]
    kernel.LocalFree.argtypes = [w.HLOCAL]

    class Basic(ctypes.Structure):
        _fields_ = [(n, ctypes.c_longlong) for n in ["created", "accessed", "modified", "changed"]] + [("attributes", w.DWORD)]

    access = 0x20000 | 0x80 | (0x100 if restore else 0)
    handle = kernel.CreateFileW(str(file), access, 7, None, 3, 0x02000000 | (0x00200000 if junction else 0), None)
    if handle == w.HANDLE(-1).value:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        # Query streams through the SAME non-following handle, including the
        # junction itself. A path-based stream API would follow its target.
        streams = ctypes.create_string_buffer(65536)
        if kernel.GetFileInformationByHandleEx(handle, 7, streams, len(streams)):
            offset = 0
            for _ in range(512):
                next_offset, name_length, _, _ = struct.unpack_from("<IIqq", streams.raw, offset)
                if name_length % 2 or offset + 24 + name_length > len(streams):
                    raise RuntimeError("INVALID_STREAM_INFORMATION")
                name = streams.raw[offset + 24:offset + 24 + name_length].decode("utf-16-le")
                if name and name != "::$DATA":
                    raise RuntimeError("UNSUPPORTED_NAMED_STREAM")
                if not next_offset:
                    break
                if next_offset < 24 or offset + next_offset >= len(streams):
                    raise RuntimeError("INVALID_STREAM_INFORMATION")
                offset += next_offset
            else:
                raise RuntimeError("STREAM_INFORMATION_LIMIT")
        elif ctypes.get_last_error() != 38:
            raise ctypes.WinError(ctypes.get_last_error())
        data = Basic()
        if not kernel.GetFileInformationByHandleEx(handle, 0, ctypes.byref(data), ctypes.sizeof(data)):
            raise ctypes.WinError(ctypes.get_last_error())
        if data.attributes & (0x4000 | 0x200 | 0x800) or (data.attributes & 0x400 and not junction):
            raise RuntimeError("UNSUPPORTED_NTFS_OBJECT")
        def descriptor():
            pointer = w.LPVOID()
            error = security.GetSecurityInfo(handle, 1, 7, None, None, None, None, ctypes.byref(pointer))
            if error:
                raise ctypes.WinError(error)
            try:
                length = security.GetSecurityDescriptorLength(pointer)
                if not length or length > 65536:
                    raise RuntimeError("SECURITY_DESCRIPTOR_UNAVAILABLE")
                return ctypes.string_at(pointer, length)
            finally:
                kernel.LocalFree(pointer)
        def canonical_descriptor(raw):
            buffer = ctypes.create_string_buffer(raw)
            sddl, length = w.LPWSTR(), w.DWORD()
            if not security.ConvertSecurityDescriptorToStringSecurityDescriptorW(buffer, 1, 7, ctypes.byref(sddl), ctypes.byref(length)):
                raise ctypes.WinError(ctypes.get_last_error())
            try:
                return sddl.value
            finally:
                kernel.LocalFree(sddl)
        if restore:
            raw = base64.b64decode(restore["security"], validate=True)
            buffer = ctypes.create_string_buffer(raw)
            if not basic_only:
                control, revision = w.WORD(), w.DWORD()
                if not security.GetSecurityDescriptorControl(buffer, ctypes.byref(control), ctypes.byref(revision)):
                    raise ctypes.WinError(ctypes.get_last_error())
                if junction:
                    # Never apply a named ACL operation through a junction.
                    # Recreated links must already inherit the exact saved ACL.
                    if canonical_descriptor(descriptor()) != restore["securityCanonical"]:
                        raise RuntimeError("JUNCTION_SECURITY_NOT_EQUIVALENT")
                elif control.value & 0x400:
                    owner, group, dacl = w.LPVOID(), w.LPVOID(), w.LPVOID()
                    defaulted, present = w.BOOL(), w.BOOL()
                    if not (security.GetSecurityDescriptorOwner(buffer, ctypes.byref(owner), ctypes.byref(defaulted)) and
                            security.GetSecurityDescriptorGroup(buffer, ctypes.byref(group), ctypes.byref(defaulted)) and
                            security.GetSecurityDescriptorDacl(buffer, ctypes.byref(present), ctypes.byref(dacl), ctypes.byref(defaulted))):
                        raise ctypes.WinError(ctypes.get_last_error())
                    flags = 7 | (0x80000000 if control.value & 0x1000 else 0x20000000)
                    error = security.SetNamedSecurityInfoW(str(file), 1, flags, owner, group, dacl, None)
                    if error:
                        raise ctypes.WinError(error)
                elif not security.SetFileSecurityW(str(file), 7, buffer):
                    raise ctypes.WinError(ctypes.get_last_error())
            if not security_only:
                for key, value in restore["basic"].items():
                    setattr(data, key, int(value))
                if not kernel.SetFileInformationByHandle(handle, 0, ctypes.byref(data), ctypes.sizeof(data)):
                    raise ctypes.WinError(ctypes.get_last_error())
        raw = descriptor()
        canonical_security = canonical_descriptor(raw)
        return {"basic": {name: str(getattr(data, name)) for name, _ in Basic._fields_},
                "security": base64.b64encode(raw).decode("ascii"),
                "securityCanonical": canonical_security}
    finally:
        kernel.CloseHandle(handle)


def metadata(file):
    value = file.lstat()
    junction = os.name == "nt" and getattr(value, "st_reparse_tag", None) == 0xA0000003
    if getattr(value, "st_file_attributes", 0) & 0x400 and not junction:
        raise RuntimeError("UNSUPPORTED_REPARSE_POINT")
    if file.is_symlink() or not (stat.S_ISREG(value.st_mode) or stat.S_ISDIR(value.st_mode)):
        raise RuntimeError("UNSUPPORTED_ARTIFACT_TYPE")
    if stat.S_ISREG(value.st_mode) and value.st_nlink != 1:
        raise RuntimeError("UNSUPPORTED_HARDLINK")
    return {"kind": "junction" if junction else "directory" if file.is_dir() else "file", "mode": stat.S_IMODE(value.st_mode),
            "mtimeNs": str(value.st_mtime_ns), "atimeNs": str(value.st_atime_ns),
            "windows": windows_metadata(file, junction=junction)}


def equivalent(actual, expected):
    # Reading a backup can update access time. All stable recoverable metadata,
    # including Windows creation/change times, attributes and security, is bound.
    left, right = json.loads(json.dumps(actual)), json.loads(json.dumps(expected))
    for item in [left, right]:
        item.pop("atimeNs")
        if item["windows"]:
            item["windows"]["basic"].pop("accessed")
            # Self-relative descriptor offsets are storage layout, not ACL
            # meaning. SDDL still compares owner, group, DACL and control flags.
            item["windows"].pop("security")
    return left == right


def inventory(root, allow_missing_junction_targets=False):
    root = Path(root)
    result = []
    manifest_bytes = 0
    pending = [root]
    while pending:
        file = pending.pop()
        if len(result) >= LIMIT:
            raise RuntimeError("ARTIFACT_ENTRY_LIMIT")
        meta = metadata(file)
        if meta["kind"] == "directory":
            pending.extend(reversed(sorted(file.iterdir())))
        value = {"name": "." if file == root else file.relative_to(root).as_posix(), "metadata": meta,
                 "bytes": file.stat().st_size if meta["kind"] == "file" else 0,
                 "sha256": digest(file) if meta["kind"] == "file" else None}
        if meta["kind"] == "junction":
            target = os.readlink(file)
            if target.startswith("\\\\?\\"):
                target = target[4:]
            target = Path(os.path.abspath(os.path.join(file.parent, target)))
            if os.path.commonpath([root, target]) != str(root) or os.path.realpath(target) != str(target) or (not allow_missing_junction_targets and not target.is_dir()):
                raise RuntimeError("JUNCTION_TARGET_OUTSIDE_PHYSICAL_ARTIFACT")
            value["junctionTarget"] = target.relative_to(root).as_posix()
        if not equivalent(metadata(file), meta):
            raise RuntimeError("ARTIFACT_CHANGED_DURING_READ")
        manifest_bytes += len(json.dumps(value).encode())
        if manifest_bytes > 4 * 1024 * 1024 - 1024:
            raise RuntimeError("ARTIFACT_METADATA_LIMIT")
        result.append(value)
    return result


def names(manifest):
    if manifest.get("format") != 1 or not isinstance(manifest.get("entries"), list) or not 1 <= len(manifest["entries"]) <= LIMIT:
        raise RuntimeError("INVALID_ARCHIVE_MANIFEST")
    result = {}
    for entry in manifest["entries"]:
        name = entry["name"]
        if name != "." and (not name or "\\" in name or ":" in name or name.startswith("/") or any(n in ["", ".", ".."] for n in name.split("/"))):
            raise RuntimeError("UNSAFE_ARCHIVE_PATH")
        if name in result or name == MANIFEST:
            raise RuntimeError("DUPLICATE_ARCHIVE_PATH")
        result[name] = entry
    if "." not in result or result["."]["metadata"]["kind"] != "directory":
        raise RuntimeError("INVALID_ARCHIVE_ROOT")
    for entry in result.values():
        if entry["metadata"]["kind"] == "junction":
            target = result.get(entry.get("junctionTarget"))
            if not target or target["metadata"]["kind"] != "directory":
                raise RuntimeError("JUNCTION_TARGET_NOT_PHYSICAL_DIRECTORY")
    return result


def restore_metadata(file, meta, security_only=False):
    if security_only and meta["kind"] != "junction":
        os.chmod(file, meta["mode"])
    elif not security_only and meta["kind"] != "junction":
        os.utime(file, ns=(int(meta["atimeNs"]), int(meta["mtimeNs"])))
    if meta["windows"]:
        windows_metadata(file, meta["windows"], security_only=security_only, basic_only=not security_only, junction=meta["kind"] == "junction")


def unpack(archive, source=None, destination=None, node=None):
    with tarfile.open(archive, "r:gz") as tar:
        iterator = iter(tar)
        first = next(iterator, None)
        if not first or first.name != MANIFEST or not first.isfile() or first.size > 4 * 1024 * 1024:
            raise RuntimeError("INVALID_ARCHIVE_HEADER")
        manifest = json.load(tar.extractfile(first))
        entries = names(manifest)
        seen = set()
        if source:
            current = {e["name"]: e for e in inventory(Path(source))}
            if set(current) != set(entries) or any(current[n]["sha256"] != e["sha256"] or current[n].get("junctionTarget") != e.get("junctionTarget") or current[n]["bytes"] != e["bytes"] or not equivalent(current[n]["metadata"], e["metadata"]) for n, e in entries.items()):
                raise RuntimeError("ARCHIVE_SOURCE_NOT_EQUIVALENT")
        dest = Path(destination) if destination else None
        if dest and dest.exists():
            existing = inventory(dest, allow_missing_junction_targets=True)
            for e in existing:
                expected = entries.get(e["name"])
                if not expected or e["sha256"] != expected["sha256"] or e.get("junctionTarget") != expected.get("junctionTarget") or e["metadata"]["kind"] != expected["metadata"]["kind"]:
                    raise RuntimeError("RESTORE_DESTINATION_CHANGED")
        for item in iterator:
            expected = entries.get(item.name)
            if expected is None or item.name in seen or item.islnk():
                raise RuntimeError("UNEXPECTED_ARCHIVE_ENTRY")
            seen.add(item.name)
            if expected["metadata"]["kind"] == "junction":
                link = posixpath.relpath(expected["junctionTarget"], posixpath.dirname(item.name) or ".")
                if not item.issym() or item.linkname != link:
                    raise RuntimeError("JUNCTION_ARCHIVE_CHANGED")
                continue
            directory = expected["metadata"]["kind"] == "directory"
            if item.isdir() != directory or (not directory and (not item.isfile() or item.size != expected["bytes"])):
                raise RuntimeError("ARCHIVE_TYPE_OR_SIZE_CHANGED")
            target = dest / item.name if dest else None
            if directory:
                if target:
                    target.mkdir(exist_ok=True)
                continue
            h = hashlib.sha256()
            output = None
            try:
                if target and not target.exists():
                    output = target.open("xb")
                with tar.extractfile(item) as stream:
                    for part in iter(lambda: stream.read(1024 * 1024), b""):
                        h.update(part)
                        if output:
                            output.write(part)
                if output:
                    output.flush()
                    os.fsync(output.fileno())
            finally:
                if output:
                    output.close()
            if h.hexdigest() != expected["sha256"]:
                raise RuntimeError("ARCHIVE_CONTENT_CHANGED")
        if seen != set(entries):
            raise RuntimeError("ARCHIVE_ENTRY_MISSING")
        if dest:
            # Inheritable ACLs propagate downwards. Restore them first, then all
            # timestamps bottom-up so propagation cannot invalidate child times.
            for entry in manifest["entries"]:
                if entry["metadata"]["kind"] != "junction":
                    restore_metadata(dest / entry["name"], entry["metadata"], security_only=True)
            for entry in manifest["entries"]:
                if entry["metadata"]["kind"] == "junction":
                    target = dest / entry["name"]
                    if not target.exists():
                        if not node or os.name != "nt":
                            raise RuntimeError("PINNED_NODE_JUNCTION_RESTORE_REQUIRED")
                        subprocess.run([node, "-e", "require('node:fs').symlinkSync(process.argv[1],process.argv[2],'junction')", str(dest / entry["junctionTarget"]), str(target)], check=True, timeout=20)
                    restore_metadata(target, entry["metadata"], security_only=True)
            for entry in reversed(manifest["entries"]):
                restore_metadata(dest / entry["name"], entry["metadata"])
            current = {e["name"]: e for e in inventory(dest)}
            if set(current) != set(entries) or any(current[n]["sha256"] != e["sha256"] or current[n].get("junctionTarget") != e.get("junctionTarget") or not equivalent(current[n]["metadata"], e["metadata"]) for n, e in entries.items()):
                fields = set()
                for name in set(current) & set(entries):
                    left, right = current[name]["metadata"], entries[name]["metadata"]
                    for key in ["kind", "mode", "mtimeNs"]:
                        if left[key] != right[key]:
                            fields.add(key)
                    if left["windows"] and right["windows"]:
                        for key in ["created", "modified", "changed", "attributes"]:
                            if left["windows"]["basic"][key] != right["windows"]["basic"][key]:
                                fields.add("windows." + key)
                        if left["windows"]["security"] != right["windows"]["security"]:
                            fields.add("windows.security")
                raise RuntimeError("ACTUAL_RESTORE_NOT_EQUIVALENT:" + ",".join(sorted(fields)))
        return manifest


def run(request):
    archive = Path(request["archive"])
    if request["action"] == "create":
        root = Path(request["source"])
        manifest = {"format": 1, "entries": inventory(root)}
        names(manifest)

        class Limited:
            def __init__(self, file):
                self.file, self.used = file, 0
            def write(self, data):
                self.used += len(data)
                if self.used > request["maxBytes"]:
                    raise RuntimeError("ARCHIVE_CAPACITY_EXCEEDED")
                return self.file.write(data)
            def tell(self):
                return self.file.tell()
            def flush(self):
                self.file.flush()

        with archive.open("xb") as raw:
            with tarfile.open(fileobj=Limited(raw), mode="w:gz", format=tarfile.PAX_FORMAT) as tar:
                data = json.dumps(manifest, sort_keys=True).encode()
                info = tarfile.TarInfo(MANIFEST)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
                for entry in manifest["entries"]:
                    info = tarfile.TarInfo(entry["name"])
                    info.mode = entry["metadata"]["mode"]
                    if entry["metadata"]["kind"] == "directory":
                        info.type = tarfile.DIRTYPE
                        tar.addfile(info)
                    elif entry["metadata"]["kind"] == "junction":
                        info.type = tarfile.SYMTYPE
                        info.linkname = posixpath.relpath(entry["junctionTarget"], posixpath.dirname(entry["name"]) or ".")
                        tar.addfile(info)
                    else:
                        info.size = entry["bytes"]
                        with (root / entry["name"]).open("rb") as file:
                            tar.addfile(info, file)
            raw.flush()
            os.fsync(raw.fileno())
        manifest = unpack(archive, source=root)
    else:
        manifest = unpack(archive, source=request.get("source"), destination=request.get("destination"), node=request.get("node"))
    return {"format": 1, "archiveSha256": digest(archive), "archiveBytes": archive.stat().st_size,
            "entries": len(manifest["entries"]), "logicalBytes": sum(e["bytes"] for e in manifest["entries"]),
            "metadataContract": "ordinary-build-files-v1: types, mode, basic times, attributes, owner/group/DACL, internal directory junctions; no other links, ADS, EFS, sparse or compressed objects",
            "fullContentAndMetadataVerified": True, "actualRestoreVerified": bool(request.get("destination"))}


if __name__ == "__main__":
    try:
        print(json.dumps(run(json.load(sys.stdin))))
    except Exception as error:
        print(type(error).__name__ + ": " + str(error), file=sys.stderr)
        sys.exit(1)
