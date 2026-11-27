"""Regenerate every Pepper app icon from scripts/app-icon.json."""

from __future__ import annotations

import json
from pathlib import Path
import shutil
import subprocess
import sys

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
MANIFEST = ROOT / "scripts" / "app-icon.json"


def main() -> None:
    config = json.loads(MANIFEST.read_text(encoding="utf-8"))
    source_path = (MANIFEST.parent / config["default"]).resolve()
    with Image.open(source_path) as original:
        source = original.convert("RGBA")
    if source.width != source.height:
        raise ValueError("The app icon source must be square")

    subprocess.run([
        "node", str(ROOT / "node_modules/@tauri-apps/cli/tauri.js"),
        "icon", str(MANIFEST), "--output", str(ROOT / "src-tauri/icons"),
    ], cwd=ROOT, check=True)

    exports = {
        "public/pepper-icon.png": 256,
        "src-tauri/icons/64x64.png": 64,
        "macos icon pepper.png": 1024,
        "AppIcons/appstore.png": 1024,
        "AppIcons/playstore.png": 512,
        "AppIcons/pepper-macos-padded.png": 1024,
    }
    exports.update({f"AppIcons/Assets.xcassets/AppIcon.appiconset/{size}.png": size
                    for size in (16, 32, 64, 128, 256, 512, 1024)})
    for relative, size in exports.items():
        destination = ROOT / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        source.resize((size, size), Image.Resampling.LANCZOS).save(destination, optimize=True)
    shutil.copyfile(source_path, ROOT / "AppIcons/pepper-icon-source.png")
    subprocess.run([sys.executable, str(ROOT / "scripts/generate-windows-icon.py")], cwd=ROOT, check=True)
    print("Updated desktop, mobile, store, in-app, and favicon assets from the polished icon.")


if __name__ == "__main__":
    main()
