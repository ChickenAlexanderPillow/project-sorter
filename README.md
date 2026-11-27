# Project Sorter

Cross-platform Tauri desktop utility to sort dropped media into client folders on a NAS. Works offline and runs fully on-device.

## Run in development

```bash
npm run tauri -- dev
```

## Features
- Pick a Project Root and scan one level deep for client folders
- Add Client (creates template) and Fix Client (creates missing folders only)
- Client modes: `EXHIBITOR`, `PRODUCT`, `HUDDLE`, `MARIYAMEETS`, `SOCIAL`, or a custom mode
- Sort Mode: drag files/folders onto a client row, flattening all files into the mode destination
- Advanced mode take-home drive: make a verified full-client copy, incrementally update it, review changes on return, merge home edits onto the NAS, and browse/restore replaced files from a hidden per-client archive
- Collision-safe naming (`__2`, `__3`, etc.)
- Automatic move routing based on file type and client mode
- CSV logging per project under `_logs/` + Undo last batch (session)
- Advanced mode is available from the `...` menu. Enter password `fidelio` to enable per-client manual published overrides. Overrides are saved in Pepper's local configuration and can be cleared from the same row.
- New Project creates the next numbered folder in the Production directory. The selectable show list is stored locally at `%APPDATA%\com.project.sorter\project-shows.json`; edit its `shows` array and restart Pepper to add choices.

## Template
Created under each client folder:
- `01_MEDIA/010_VIDEO_PROXY/`
- `01_MEDIA/020_VIDEO_RAW/`
- `01_MEDIA/030_AUDIO_CLEAN/`
- `01_MEDIA/040_AUDIO_RAW/`
- `01_MEDIA/050_STILLS/`
- `01_MEDIA/060_MUSIC/`
- `01_MEDIA/070_GRAPHICS/`
- `01_MEDIA/080_MISCELLANEOUS/`
- Existing clients are not flagged as incomplete if they predate `070_GRAPHICS` or `080_MISCELLANEOUS`; new clients still get both folders.
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

The public key is embedded in `src-tauri/tauri.conf.json`; never commit the private key.

Pepper displays update download progress and signature verification in the app. **Update and restart** downloads the signed release, then launches the Windows installer in quiet mode; Pepper closes briefly and the installer reopens it. Existing machine-wide installations may still require Windows administrator approval. Update installation is disabled while another Pepper operation is running.

Development mode shows a simulated update dialog on startup. **Check for updates** reopens it; the preview runs through download, verification, and completion without installing or restarting the app.

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
- Take-home packages are tracked by a manifest on the portable drive and in the client. Returning merges new and changed files; NAS-only files are retained and files deleted from the drive are not deleted from the NAS. Replaced NAS files remain in the hidden `.pepper-takehome/archive/` folder.
- Premiere projects may need media relinking when opened from a different drive because Pepper preserves the client folder structure but does not rewrite Premiere project paths.
