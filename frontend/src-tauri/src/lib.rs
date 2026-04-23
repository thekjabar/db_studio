// Tauri app entry — no custom IPC commands yet. The frontend calls the
// backend API directly (over HTTP) so nothing here needs to be native.
// Commands go here as the desktop story grows.

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
