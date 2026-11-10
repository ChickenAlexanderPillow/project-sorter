# Bundled metadata reader

Pepper ships the unmodified Windows x64 static FFprobe 7.1.1 essentials build
from Gyan (https://www.gyan.dev/ffmpeg/builds/), obtained from the installed
Chocolatey ffmpeg 7.1.1 package. The binary is a repository resource, so clean
builds and installed Pepper never require FFmpeg on PATH or a runtime download.

SHA-256: 05e8fa639450f8191635192871ae37a3ec3e4638fa12f3b7d49c6522ba16a8ed

`build.rs` verifies this digest on Windows. The reader verifies the digest once
per process, uses an absolute resource path, disables network protocols and
console windows, and bounds reads to 30 seconds / 1 MiB. Unavailable, corrupted,
or unsupported tools leave duration unavailable and record `probe_error`.
Tauri bundles this directory at `resources/media-tools` beside Pepper.exe.

License: GPL v3, included in LICENSE.txt. Upstream build information and source
revision are in FFmpeg-README.txt. Source: https://github.com/FFmpeg/FFmpeg/commit/db69d06eee
Build configuration and dependency sources: https://www.gyan.dev/ffmpeg/builds/

When replacing FFprobe, review the license and source distribution alongside the
binary, update both checksum constants (build.rs and recording_metadata.rs),
and run the bundled-reader and collection integration tests before packaging.

Intervals require positive duration (at most seven days) and a timezone-qualified
embedded timestamp from 1980 through tomorrow. Embedded values are retained
verbatim; invalid or conflicting embedded dates block matching. Only absence of
embedded dates enables filesystem fallback. Birth times later than modification
time by over two seconds are suspect. Filesystem timestamps cannot establish
camera clock accuracy; provenance remains available in the manifest and row
hover text. Each collection considers unassigned recordings from all batches.
When another source is collected, legacy records without metadata are upgraded
from still-available, hash-verified originals. Their saved source filesystem
timestamps remain the fallback. Missing or changed originals stay unmatched;
inbox copies are never used for this upgrade. Manual groups and client decisions
are preserved.
