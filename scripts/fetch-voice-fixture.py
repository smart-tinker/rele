#!/usr/bin/env python3
"""Fetch pinned public SYSTRAN test assets; never use account tokens or user audio."""
import argparse
from concurrent.futures import ThreadPoolExecutor
import hashlib
import json
from pathlib import Path
import urllib.request

MODEL_BASE = "https://huggingface.co/Systran/faster-whisper-tiny/resolve/d90ca5fe260221311c53c58e660288d3deb8d356/"
FILES = {
    "tiny/config.json": (MODEL_BASE + "config.json", "a73a28cdfe1c43ccc7202fa333d1f89c202477271407ae9a7f19afa52039cac8"),
    "tiny/model.bin": (MODEL_BASE + "model.bin", "dcb76c6586fc06cbdac6dd21f14cfd129cc4cdd9dce19bf4ffa62e59cbe6e6d1"),
    "tiny/tokenizer.json": (MODEL_BASE + "tokenizer.json", "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab"),
    "tiny/vocabulary.txt": (MODEL_BASE + "vocabulary.txt", "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913"),
    "jfk.flac": ("https://raw.githubusercontent.com/SYSTRAN/faster-whisper/65882eee9f5cdbeeb2d877f1131d48cf241b327d/tests/data/jfk.flac",
                 "63a4b1e4c1dc655ac70961ffbf518acd249df237e5a0152faae9a4a836949715"),
}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory", type=Path, required=True)
    args = parser.parse_args()
    directory = args.directory.resolve()
    directory.mkdir(parents=True, exist_ok=True)

    def download(item):
        relative, (url, expected) = item
        target = directory / relative
        if target.exists():
            with target.open("rb") as source:
                if hashlib.file_digest(source, "sha256").hexdigest() == expected:
                    return
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_suffix(target.suffix + ".download")
        digest = hashlib.sha256()
        try:
            with urllib.request.urlopen(url, timeout=45) as response, temporary.open("wb") as output:
                while chunk := response.read(1024 * 1024):
                    digest.update(chunk)
                    output.write(chunk)
            if digest.hexdigest() != expected:
                raise RuntimeError(f"Public fixture checksum mismatch: {relative}")
            temporary.replace(target)
        finally:
            temporary.unlink(missing_ok=True)

    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(download, FILES.items()))
    (directory / "sources.json").write_text(json.dumps({name: {"url": url, "sha256": sha} for name, (url, sha) in FILES.items()}, indent=2), encoding="utf-8")
    print("Pinned public tiny model and JFK audio are ready.")


if __name__ == "__main__":
    main()
