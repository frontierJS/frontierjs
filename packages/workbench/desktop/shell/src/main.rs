// desktop/shell/src/main.rs — the native window around the bundled screens.
//
// The page is served from tauri://localhost (http://tauri.localhost on Windows
// and Android), so the API is always another origin: its URL is inlined by
// deploy/build.mjs and its CORS list has to name this origin (FJS-1090).
//
// frontendDist is compiled INTO the binary. Rebuilding the screens without
// rebuilding this crate runs the previous bundle.
//
// A debug build injects a probe when FRONTIER_DESKTOP_PROBE names a script.
// WebKitGTK and WKWebView speak no CDP, so a drive cannot reach into the page
// the way a browser drive does; the probe runs inside it and reports through
// the two commands below.
//
// A debug build loads FRONTIER_DESKTOP_URL instead of the bundle when it is set —
// fli dev:desktop points it at the screens' dev server. That page's origin is
// the server's, not tauri://localhost, so an origin or CORS fault shows only
// in the bundled build.
//
// A release build reads neither variable, so a shipped app cannot be scripted
// or repointed from its environment. Its one command is tray_unread, which
// only sets the tray's label.
//
// A webview with no new-window handler drops every target=_blank link without
// a sound, so each one goes to the system browser instead.
//
// One shell runs at a time: a second launch hands its argv to the running one
// and exits, and `--go <path>` there opens that screen (go.rs), as the Capture
// tool does with `workbench-desktop --go /capture/`. A first launch ignores
// `--go`. A debug shell on FRONTIER_DESKTOP_URL or FRONTIER_DESKTOP_PROBE is
// left out, so a dev window or a drive runs beside the installed app instead
// of raising it and exiting.

mod go;
mod tray;

use tauri::webview::NewWindowResponse;
use tauri::{RunEvent, WebviewUrl, WebviewWindowBuilder};

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
    let path = std::env::var("FRONTIER_DESKTOP_PROBE").ok()?;
    match std::fs::read_to_string(&path) {
        Ok(script) => Some(script),
        Err(e) => panic!("FRONTIER_DESKTOP_PROBE={path} could not be read: {e}"),
    }
}

fn dev_url() -> Option<tauri::Url> {
    if !cfg!(debug_assertions) {
        return None;
    }
    let raw = std::env::var("FRONTIER_DESKTOP_URL").ok()?;
    match raw.parse() {
        Ok(url) => Some(url),
        Err(e) => panic!("FRONTIER_DESKTOP_URL={raw} is not a URL: {e}"),
    }
}

// Only http(s): anything else would hand the OS opener a file or a scheme
// handler the page chose.
fn open_in_browser(url: &tauri::Url) {
    if !matches!(url.scheme(), "http" | "https") {
        return;
    }
    let (cmd, args): (&str, &[&str]) = if cfg!(target_os = "macos") {
        ("open", &[])
    } else if cfg!(windows) {
        ("rundll32", &["url.dll,FileProtocolHandler"])
    } else {
        ("xdg-open", &[])
    };
    match std::process::Command::new(cmd).args(args).arg(url.as_str()).spawn() {
        // Reaped on its own thread, or every click leaves a zombie behind.
        Ok(mut child) => {
            std::thread::spawn(move || child.wait());
        }
        Err(e) => eprintln!("{cmd} could not open {url}: {e}"),
    }
}

fn main() {
    let probe = probe_script();
    let dev = dev_url();
    let single = probe.is_none() && dev.is_none();
    let page = match dev {
        Some(url) => WebviewUrl::External(url),
        None => WebviewUrl::App("index.html".into()),
    };

    let builder = tauri::Builder::default();
    // First of every plugin, as the plugin requires.
    let builder = if single {
        builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            match go::arg(&argv) {
                Some(path) => tray::go(app, path),
                None => tray::present(app),
            }
        }))
    } else {
        builder
    };
    // invoke_handler replaces, never adds, so each build names its full list.
    #[cfg(debug_assertions)]
    let builder = if probe.is_some() {
        builder.invoke_handler(tauri::generate_handler![probe_report, probe_done, tray::tray_unread])
    } else {
        builder.invoke_handler(tauri::generate_handler![tray::tray_unread])
    };
    #[cfg(not(debug_assertions))]
    let builder = builder.invoke_handler(tauri::generate_handler![tray::tray_unread]);

    builder
        .setup(move |app| {
            let mut window = WebviewWindowBuilder::new(app, "main", page)
                .title("Workbench")
                .inner_size(1280.0, 900.0)
                .on_new_window(|url, _| {
                    open_in_browser(&url);
                    NewWindowResponse::Deny
                });
            if let Some(script) = &probe {
                window = window.initialization_script(script);
            }
            window.build()?;
            tray::build(app.handle())?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("the desktop shell failed to start")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                tray::stop_api(app);
            }
        });
}
