#!/usr/bin/env python3
"""Linux proof that the actual transcription worker runs with socket syscalls denied.

Supply a previously downloaded local model and public test audio. This script
does not download anything or change the host's network settings. The seccomp
filter applies only to the isolated child and cannot be removed by that child.
"""
import argparse
import ctypes
import ctypes.util
import errno
import hashlib
import json
import os
from pathlib import Path
import re
import runpy
import socket
import subprocess
import sys
import time


def deny_network():
    library_path = ctypes.util.find_library("seccomp")
    if not library_path:
        raise RuntimeError("This Linux probe requires libseccomp.")
    library = ctypes.CDLL(library_path, use_errno=True)
    library.seccomp_init.argtypes = [ctypes.c_uint32]
    library.seccomp_init.restype = ctypes.c_void_p
    library.seccomp_syscall_resolve_name.argtypes = [ctypes.c_char_p]
    library.seccomp_syscall_resolve_name.restype = ctypes.c_int
    library.seccomp_rule_add.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_int, ctypes.c_uint]
    library.seccomp_load.argtypes = [ctypes.c_void_p]
    library.seccomp_release.argtypes = [ctypes.c_void_p]
    context = library.seccomp_init(0x7FFF0000)  # SCMP_ACT_ALLOW for non-network work.
    if not context:
        raise RuntimeError("Could not create the network-denial filter.")
    try:
        for name in ("socket", "socketpair", "connect", "sendto", "sendmsg", "sendmmsg"):
            syscall = library.seccomp_syscall_resolve_name(name.encode())
            if syscall >= 0 and library.seccomp_rule_add(context, 0x00050000 | errno.EACCES, syscall, 0) != 0:
                raise RuntimeError("Could not configure a denied network syscall.")
        if library.seccomp_load(context) != 0:
            raise RuntimeError("Could not apply the network-denial filter.")
    finally:
        library.seccomp_release(context)
    try:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    except PermissionError:
        return
    probe.close()
    raise RuntimeError("Network denial did not take effect.")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--model", type=Path, required=True)
    parser.add_argument("--input", type=Path, required=True)
    parser.add_argument("--language", default="en")
    parser.add_argument("--assert-text")
    parser.add_argument("--report", type=Path)
    parser.add_argument("--guarded-worker", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args()
    if sys.platform != "linux":
        parser.error("This proof uses Linux seccomp; it does not verify Windows or GPU execution.")
    worker = Path(__file__).resolve().with_name("transcribe.py")
    if args.guarded_worker:
        deny_network()
        sys.argv = [str(worker), "--input", str(args.input.resolve()), "--model", str(args.model.resolve()),
                    "--language", args.language, "--device", "cpu"]
        runpy.run_path(str(worker), run_name="__main__")
        return
    environment = {key: value for key, value in os.environ.items()
                   if key in {"PATH", "HOME", "LANG", "LC_ALL", "TMPDIR", "VIRTUAL_ENV", "LD_LIBRARY_PATH"}}
    environment.update({"HF_HUB_OFFLINE": "1", "TRANSFORMERS_OFFLINE": "1",
                        "HF_HUB_DISABLE_TELEMETRY": "1", "HF_HUB_DISABLE_IMPLICIT_TOKEN": "1"})
    started = time.monotonic()
    completed = subprocess.run([args.python, str(Path(__file__).resolve()), "--guarded-worker", "--model", str(args.model.resolve()),
                                "--input", str(args.input.resolve()), "--language", args.language], env=environment,
                               text=True, capture_output=True, timeout=120, check=True)
    result = json.loads(completed.stdout)
    text = result["text"]
    if args.assert_text:
        normalized = lambda value: re.sub(r"[^\w ]", "", value.lower())
        assert normalized(args.assert_text) in normalized(text), "The public fixture's expected phrase was not recognized."
    with args.input.open("rb") as source:
        audio_hash = hashlib.file_digest(source, "sha256").hexdigest()
    report = {"result": "passed", "platform": sys.platform, "device": "cpu", "networkSyscallsDenied": True,
              "apiCredentialsInherited": False, "inputSha256": audio_hash,
              "seconds": round(time.monotonic() - started, 3), "text": text}
    if args.report:
        args.report.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
