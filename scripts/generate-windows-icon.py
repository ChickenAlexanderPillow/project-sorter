"""Build Pepper's Windows ICO without changing the supplied artwork."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
import json
import struct

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "scripts" / "app-icon.json"
SOURCE = (MANIFEST.parent / json.loads(MANIFEST.read_text(encoding="utf-8"))["default"]).resolve()
OUTPUT = ROOT / "src-tauri" / "icons" / "icon.ico"
SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)


def png_bytes(image: Image.Image) -> bytes:
    stream = BytesIO()
    image.save(stream, format="PNG", optimize=True)
    return stream.getvalue()


def write_ico(frames: list[tuple[int, bytes]]) -> None:
    header = struct.pack("<HHH", 0, 1, len(frames))
    directory = bytearray()
    offset = 6 + 16 * len(frames)
    for size, data in frames:
        dimension = 0 if size == 256 else size
        directory.extend(struct.pack("<BBBBHHII", dimension, dimension, 0, 0, 1, 32, len(data), offset))
        offset += len(data)
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    OUTPUT.write_bytes(header + directory + b"".join(data for _, data in frames))


def main() -> None:
    source = Image.open(SOURCE).convert("RGBA")
    if source.width != source.height:
        raise ValueError("The app icon source must be square")
    frames = [(size, png_bytes(source.resize((size, size), Image.Resampling.LANCZOS))) for size in SIZES]
    write_ico(frames)


if __name__ == "__main__":
    main()
