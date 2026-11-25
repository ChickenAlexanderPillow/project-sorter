"""Build Pepper's Windows ICO with simplified artwork at taskbar sizes."""

from __future__ import annotations

from io import BytesIO
from pathlib import Path
import struct

from PIL import Image, ImageFilter


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "public" / "Premium White Chili Pepper Icon.png"
OUTPUT = ROOT / "src-tauri" / "icons" / "icon.ico"
SIZES = (16, 20, 24, 32, 40, 48, 64, 128, 256)


def fit(image: Image.Image, size: int) -> Image.Image:
    margin = max(1, round(size * 0.08))
    image.thumbnail((size - margin * 2, size - margin * 2), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    canvas.alpha_composite(image, ((size - image.width) // 2, (size - image.height) // 2))
    return canvas


def small_taskbar_frame(mask: Image.Image, size: int) -> Image.Image:
    bounds = mask.getbbox()
    if bounds is None:
        raise ValueError("The chili icon source has no opaque pixels")

    shape = mask.crop(bounds)
    shape = shape.resize((round(shape.width * 1.35), shape.height), Image.Resampling.LANCZOS)
    foreground = Image.new("RGBA", shape.size, (255, 255, 255, 0))
    foreground.putalpha(shape)
    return fit(foreground, size)


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
    alpha = source.getchannel("A")
    # Ignore the source artwork's soft outer glow when sizing the icon.
    mask = alpha.point(lambda value: 255 if value >= 160 else 0)
    bounds = mask.getbbox()
    if bounds is None:
        raise ValueError(f"No chili shape found in {SOURCE}")

    detailed = source.crop(bounds)
    solid_shape = mask.crop(bounds)
    frames = []
    for size in SIZES:
        if size <= 40:
            frame = small_taskbar_frame(solid_shape, size)
        else:
            frame = fit(detailed.copy(), size)
            frame = frame.filter(ImageFilter.UnsharpMask(radius=0.45, percent=115, threshold=3))
        frames.append((size, png_bytes(frame)))
    write_ico(frames)


if __name__ == "__main__":
    main()
