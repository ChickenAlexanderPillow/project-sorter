// The app is GUI-only on Windows; protocol callbacks can start a second process briefly in dev.
#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]

fn main() {
    pepper_lib::run()
}
