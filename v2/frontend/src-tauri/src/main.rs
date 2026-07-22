// Desktop entry point. Keeps the launcher minimal — all UX lives in the web
// frontend. On Windows we need the `windows_subsystem` guard so the terminal
// doesn't appear in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    dbstudio_desktop_lib::run();
}
