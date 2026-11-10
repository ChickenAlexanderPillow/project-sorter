use sha2::{Digest, Sha256};
fn main() {
    let probe = "resources/media-tools/ffprobe.exe";
    println!("cargo:rerun-if-changed={probe}");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let bytes = std::fs::read(probe).expect("Pepper requires its bundled FFprobe; restore resources/media-tools/ffprobe.exe");
        assert_eq!(format!("{:x}", Sha256::digest(bytes)), "05e8fa639450f8191635192871ae37a3ec3e4638fa12f3b7d49c6522ba16a8ed", "Bundled FFprobe checksum mismatch");
    }
    tauri_build::build()
}
