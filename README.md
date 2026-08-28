# Project Sorter

Cross-platform Tauri desktop utility to sort dropped media into client folders on a NAS. Works offline and runs fully on-device.

## Features
- Pick a Project Root and scan one level deep for client folders
- Add Client (creates template) and Fix Client (creates missing folders only)
- Sort Mode: drag files/folders onto a client row, flattening all files into the mode destination
- Collision-safe naming (`__2`, `__3`, etc.)
- Move/Copy toggle, Dry Run toggle, optional Approval Exports mode
- CSV logging per project under `_logs/` + Undo last batch (session)

## Template
Created under each client folder:
- `01_MEDIA/010_VIDEO_PROXY/`
- `01_MEDIA/020_VIDEO_RAW/`
- `01_MEDIA/030_AUDIO_CLEAN/`
- `01_MEDIA/040_AUDIO_RAW/`
- `01_MEDIA/050_STILLS/`
- `01_MEDIA/060_MUSIC/`
- `02_EDIT/`
  - copies `Z:\The Huddle\Templates\Copied_Huddle Master Template 2026_4K_2\Huddle Master Template 2026_4K_2.prproj`
  - renames it to the client name, for example `DIGITAIN.prproj`
- `03_EXPORTS/`
- `03_EXPORTS/APPROVAL/`
- `04_FINAL/`
- `Changelog.txt` is never deleted if present

## Development

Prerequisites:
- Rust toolchain
- Tauri v2 prerequisites for your OS

Install deps:

```bash
pnpm install
```

Run dev:

```bash
pnpm tauri dev
```

## Build / Package

```bash
pnpm tauri build
```

The build outputs native installers/bundles for Windows/macOS (no external runtime required).

## Tests

Rust unit tests (path mapping, collision naming):

```bash
cd src-tauri
cargo test
```

## Notes
- Scanning only checks one level deep under the Project Root.
- Dragging folders is supported; files are flattened into the destination.
- Undo is best-effort for the last batch in the current session.
