// desktop/shell/src/main.rs — the native window around the bundled screens.
//
// The page is served from tauri://localhost (http://tauri.localhost on Windows
// and Android), so the API is always another origin: its URL is inlined by
// deploy/build.mjs and its CORS list has to name this origin (FJS-1090).
//
// frontendDist is compiled INTO the binary. Rebuilding the screens without
// rebuilding this crate runs the previous bundle.
//
// A debug build injects a probe when FJS_DESKTOP_PROBE names a script.
// WebKitGTK and WKWebView speak no CDP, so the drive cannot reach into the page
// the way every browser drive here does; the probe runs inside it and reports
// through the two commands below. A release build neither reads the variable
// nor registers the commands, so a shipped app cannot be scripted from its
// environment.

use tauri::{WebviewUrl, WebviewWindowBuilder};

#[cfg(debug_assertions)]
#[tauri::command]
fn probe_report(line: String) {
    println!("[probe] {line}");
}

#[cfg(debug_assertions)]
#[tauri::command]
fn probe_done(app: tauri::AppHandle, code: i32) {
    app.exit(code);
}

fn probe_script() -> Option<String> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let path = std::env::var("FJS_DESKTOP_PROBE").ok()?;
    match std::fs::read_to_string(&path) {
        Ok(script) => Some(script),
        Err(e) => panic!("FJS_DESKTOP_PROBE={path} could not be read: {e}"),
    }
}

fn main() {
    let probe = probe_script();

    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let builder = if probe.is_some() {
        builder.invoke_handler(tauri::generate_handler![probe_report, probe_done])
    } else {
        builder
    };

    builder
        .setup(move |app| {
            let mut window = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
                .title("Kitchen sink")
                .inner_size(1280.0, 900.0);
            if let Some(script) = &probe {
                window = window.initialization_script(script);
            }
            window.build()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the desktop shell failed to start");
}
