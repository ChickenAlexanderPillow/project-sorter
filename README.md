# Project Sorter

Cross-platform Tauri desktop utility to sort dropped media into client folders on a NAS. Works offline and runs fully on-device.

## Features
- Pick a Project Root and scan one level deep for client folders
- Add Client (creates template) and Fix Client (creates missing folders only)
- Client modes: `EXHIBITOR`, `PRODUCT`, `HUDDLE`, `MARIYAMEETS`, `SOCIAL`, or a custom mode
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
  - `EXHIBITOR`, `PRODUCT`, and physical `HUDDLE` clients copy `Z:\The Huddle\Templates\Copied_Huddle Master Template 2026_4K_2\Huddle Master Template 2026_4K_2.prproj`
  - video-call `HUDDLE` clients copy `Z:\The Huddle\Templates\Copied_Huddle Master Template Scenes Switching 2026 4K_1\Huddle Master Template Scenes Switching 2026 4K_1.prproj`
  - `MARIYAMEETS`, `SOCIAL`, and custom modes do not include a Premiere project
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

## Internal update server

Pepper can check for signed updates from the lightweight Docker service in `update-server/`. Start it with `docker compose up -d`; see [`update-server/README.md`](update-server/README.md) for publishing releases. The service is designed to host update files for multiple apps under separate folders.

## Build / Package

```bash
pnpm tauri build
```

## GitHub Releases and automatic updates

Pepper checks the latest GitHub Release at startup. Every push to `main` publishes a signed Pepper build automatically. The workflow uses the major/minor version from `src-tauri/tauri.conf.json` and GitHub's run number as the patch version. For example, a commit may become `0.1.4`, then the next commit `0.1.5`.

Your normal release flow is:

1. Make your changes.
2. Commit them in VS Code Source Control.
3. Click **Sync Changes**.

The workflow builds the signed Windows installer and creates a matching GitHub Release for that commit. To move to a new minor version, change the major/minor values in `src-tauri/tauri.conf.json`; the workflow supplies the patch number automatically.

The GitHub Actions workflow in `.github/workflows/publish.yml` builds the signed Windows installer and publishes the updater artifacts to the release. Add these repository Actions secrets before the first release:

- `TAURI_SIGNING_PRIVATE_KEY`: contents of the private key stored outside this repository
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`: password for that key

The public key is embedded in `src-tauri/tauri.conf.json`; never commit the private key. The Docker update server remains available for future apps that need LAN-only distribution.

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
