//! Original-file evidence only. No media writes, PATH lookup, or runtime download.
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::{Duration, Instant},
};

const PROBE_SHA256: &str = "05e8fa639450f8191635192871ae37a3ec3e4638fa12f3b7d49c6522ba16a8ed";
const MAX_DURATION_NS: u64 = 7 * 24 * 60 * 60 * 1_000_000_000;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Default)]
pub struct RecordingMetadata {
    pub start_ns: Option<String>,
    pub duration_ns: Option<String>,
    pub start_source: Option<String>,
    pub duration_source: Option<String>,
    // Retain exact embedded values as well as their normalized UTC interpretation.
    #[serde(default)]
    pub embedded_times: Vec<EmbeddedTime>,
    pub warning: Option<String>,
    pub probe_error: Option<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct EmbeddedTime {
    pub source: String,
    pub value: String,
}

fn probe_path() -> Result<PathBuf, String> {
    static TOOL: std::sync::OnceLock<Result<PathBuf, String>> = std::sync::OnceLock::new();
    TOOL.get_or_init(|| {
        if !cfg!(all(windows, target_arch = "x86_64")) {
            return Err("Bundled FFprobe is unavailable on this platform".into());
        }
        // Windows Tauri resources live alongside the installed executable.
        let installed = std::env::current_exe()
            .map_err(|e| e.to_string())?
            .parent()
            .ok_or("Application directory unavailable")?
            .join("resources/media-tools/ffprobe.exe");
        #[cfg(debug_assertions)]
        let installed = if installed.is_file() {
            installed
        } else {
            Path::new(env!("CARGO_MANIFEST_DIR")).join("resources/media-tools/ffprobe.exe")
        };
        let bytes =
            fs::read(&installed).map_err(|e| format!("Bundled FFprobe unavailable: {e}"))?;
        if format!("{:x}", Sha256::digest(bytes)) != PROBE_SHA256 {
            return Err("Bundled FFprobe checksum mismatch".into());
        }
        Ok(installed)
    })
    .clone()
}

fn probe(
    path: &Path,
    mut heartbeat: impl FnMut() -> Result<(), String>,
) -> Result<serde_json::Value, String> {
    let output = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut command = Command::new(probe_path()?);
    command.args(["-v", "error", "-protocol_whitelist", "file", "-show_entries",
        "format=duration:format_tags=creation_time:stream=index,codec_type,duration:stream_disposition=attached_pic:stream_tags=creation_time", "-of", "json", "-i"])
        .arg(path).stdin(Stdio::null()).stdout(output.try_clone().map_err(|e|e.to_string())?).stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command.spawn().map_err(|e| e.to_string())?;
    let started = Instant::now();
    loop {
        let result = (|| {
            heartbeat()?;
            if started.elapsed() > Duration::from_secs(30) {
                return Err("Media metadata read timed out".into());
            }
            if output.metadata().map_err(|e| e.to_string())?.len() > 1024 * 1024 {
                return Err("Media metadata exceeds limit".into());
            }
            child.try_wait().map_err(|e| e.to_string())
        })();
        match result {
            Ok(Some(status)) => {
                if !status.success() {
                    return Err("FFprobe could not read media metadata".into());
                }
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(50)),
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        }
    }
    use std::io::{Read, Seek, SeekFrom};
    let mut output = output;
    output.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    output
        .take(1024 * 1024 + 1)
        .read_to_end(&mut bytes)
        .map_err(|e| e.to_string())?;
    if bytes.len() > 1024 * 1024 {
        return Err("Media metadata exceeds limit".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid media metadata: {e}"))
}

fn valid_start(ns: i64, now: i64) -> bool {
    ns >= 315_532_800_000_000_000 && ns <= now.saturating_add(86_400_000_000_000)
}
fn duration(value: &serde_json::Value) -> Option<u64> {
    let seconds = value.as_str()?.parse::<f64>().ok()?;
    let ns = seconds * 1_000_000_000.0;
    (ns.is_finite() && ns >= 1.0 && ns <= MAX_DURATION_NS as f64).then_some(ns.round() as u64)
}
fn from_probe(
    value: &serde_json::Value,
    created: Option<&str>,
    modified: Option<&str>,
    now: i64,
) -> RecordingMetadata {
    let mut result = RecordingMetadata::default();
    let streams: Vec<_> = value["streams"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|s| {
            matches!(s["codec_type"].as_str(), Some("audio" | "video"))
                && s["disposition"]["attached_pic"].as_u64() != Some(1)
        })
        .collect();
    if let Some(raw) = value["format"]["tags"]["creation_time"].as_str() {
        result.embedded_times.push(EmbeddedTime {
            source: "format.creation_time".into(),
            value: raw.into(),
        });
    }
    for stream in &streams {
        if let Some(raw) = stream["tags"]["creation_time"].as_str() {
            result.embedded_times.push(EmbeddedTime {
                source: format!("stream.{}.creation_time", stream["index"]),
                value: raw.into(),
            });
        }
    }
    let parsed: Vec<_> = result
        .embedded_times
        .iter()
        .map(|t| {
            chrono::DateTime::parse_from_rfc3339(&t.value)
                .ok()
                .and_then(|d| d.timestamp_nanos_opt())
                .filter(|ns| valid_start(*ns, now))
        })
        .collect();
    if !parsed.is_empty() {
        if parsed.iter().any(Option::is_none)
            || parsed.iter().flatten().max().unwrap() - parsed.iter().flatten().min().unwrap()
                > 1_000_000_000
        {
            result.warning = Some("Invalid or conflicting embedded recording timestamps".into());
        } else {
            result.start_ns = Some(parsed[0].unwrap().to_string());
            result.start_source = Some(result.embedded_times[0].source.clone());
        }
    } else {
        let (raw, source) = if created.is_some() {
            (created, "filesystem_created")
        } else {
            (modified, "filesystem_modified")
        };
        if let Some(ns) = raw
            .and_then(|s| s.parse::<i64>().ok())
            .filter(|ns| valid_start(*ns, now))
        {
            result.start_ns = Some(ns.to_string());
            result.start_source = Some(source.into());
            // A birth date later than last write is usually a copy date, not a recording start.
            if source == "filesystem_created"
                && modified
                    .and_then(|s| s.parse::<i64>().ok())
                    .is_some_and(|m| ns.saturating_sub(m) > 2_000_000_000)
            {
                result.warning =
                    Some("Filesystem creation time is later than modification time".into());
            }
        } else {
            result.warning = Some("Recording start is unavailable or suspect".into());
        }
    }
    if !streams.is_empty() {
        let durations: Vec<_> = streams
            .iter()
            .filter_map(|s| s.get("duration"))
            .filter(|d| d.as_str() != Some("N/A"))
            .collect();
        if durations.iter().any(|d| duration(d).is_none()) {
            result.warning = Some("Invalid stream duration".into());
        } else if durations.len() == streams.len() {
            result.duration_ns = durations
                .iter()
                .filter_map(|d| duration(d))
                .max()
                .map(|d| d.to_string());
            result.duration_source = Some("stream.duration".into());
        } else if let Some(ns) = duration(&value["format"]["duration"]) {
            // Formats such as WAV expose their duration at container level only.
            result.duration_ns = Some(ns.to_string());
            result.duration_source = Some("format.duration".into());
        }
    }
    result
}

pub fn read(
    path: &Path,
    created: Option<&str>,
    modified: Option<&str>,
    heartbeat: impl FnMut() -> Result<(), String>,
) -> RecordingMetadata {
    let now = chrono::Utc::now()
        .timestamp_nanos_opt()
        .unwrap_or(i64::MAX - 86_400_000_000_000);
    match probe(path, heartbeat) {
        Ok(value) => from_probe(&value, created, modified, now),
        Err(error) => {
            let mut result = from_probe(&serde_json::Value::Null, created, modified, now);
            result.probe_error = Some(error);
            result
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    const NOW: i64 = 1_800_000_000_000_000_000;
    fn sample() -> serde_json::Value {
        json!({"format":{"tags":{"creation_time":"2026-01-01T12:00:00Z"}},"streams":[{"index":0,"codec_type":"video","duration":"20.5"},{"index":1,"codec_type":"audio","duration":"20.6"}]})
    }
    #[test]
    fn embedded_precedes_filesystem_and_retains_raw_values() {
        let m = from_probe(&sample(), Some("1700000000000000000"), None, NOW);
        assert_eq!(m.start_source.as_deref(), Some("format.creation_time"));
        assert_eq!(m.duration_ns.as_deref(), Some("20600000000"));
        assert_eq!(m.embedded_times[0].value, "2026-01-01T12:00:00Z");
        assert!(m.warning.is_none());
    }
    #[test]
    fn fallback_is_explicit_and_suspect_copy_dates_are_flagged() {
        let v = json!({"streams":[{"codec_type":"audio"}],"format":{"duration":"10"}});
        let m = from_probe(&v, Some("1700000000000000000"), None, NOW);
        assert_eq!(m.start_source.as_deref(), Some("filesystem_created"));
        assert_eq!(m.duration_source.as_deref(), Some("format.duration"));
        let m = from_probe(&v, None, Some("1700000000000000000"), NOW);
        assert_eq!(m.start_source.as_deref(), Some("filesystem_modified"));
        assert!(from_probe(
            &v,
            Some("1700000010000000000"),
            Some("1700000000000000000"),
            NOW
        )
        .warning
        .is_some());
    }
    #[test]
    fn invalid_or_conflicting_embedded_dates_never_silently_fallback() {
        for raw in [
            "bad",
            "1904-01-01T00:00:00Z",
            "2099-01-01T00:00:00Z",
            "2026-01-01T12:00:00",
        ] {
            let mut v = sample();
            v["format"]["tags"]["creation_time"] = json!(raw);
            let m = from_probe(&v, Some("1700000000000000000"), None, NOW);
            assert!(m.start_ns.is_none());
            assert!(m.warning.is_some());
        }
        let mut v = sample();
        v["streams"][0]["tags"] = json!({"creation_time":"2026-01-02T12:00:00Z"});
        assert!(from_probe(&v, None, None, NOW).start_ns.is_none());
    }
    #[test]
    fn invalid_duration_and_stills_are_unavailable() {
        for raw in ["NaN", "Infinity", "0", "-1", "999999999", "N/A"] {
            let mut v = sample();
            v["streams"][0]["duration"] = json!(raw);
            assert!(from_probe(&v, None, None, NOW).duration_ns.is_none());
        }
        assert!(from_probe(&json!({"streams":[{"codec_type":"video","disposition":{"attached_pic":1},"duration":"20"}]}),None,None,NOW).duration_ns.is_none());
    }
    #[test]
    fn packaged_probe_reads_original_wav_and_handles_bad_media() {
        if !cfg!(all(windows, target_arch = "x86_64")) {
            return;
        }
        assert!(probe_path().unwrap().is_file());
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("source.wav");
        let mut wav = Vec::new();
        wav.extend(b"RIFF");
        wav.extend(16036u32.to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(8000u32.to_le_bytes());
        wav.extend(16000u32.to_le_bytes());
        wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend(16000u32.to_le_bytes());
        wav.resize(16044, 0);
        fs::write(&path, &wav).unwrap();
        let m = read(&path, Some("1700000000000000000"), None, || Ok(()));
        assert_eq!(m.duration_ns.as_deref(), Some("1000000000"), "{m:?}");
        assert_eq!(fs::read(&path).unwrap(), wav);
        fs::write(&path, b"invalid").unwrap();
        let m = read(&path, None, None, || Ok(()));
        assert!(m.probe_error.is_some());
        assert!(m.duration_ns.is_none());
    }
}
