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
// WebKitGTK and WKWebView speak no CDP, so a drive cannot reach into the page
// the way a browser drive does; the probe runs inside it and reports through
// the two commands below.
//
// A debug build loads FRONTIER_DESKTOP_URL instead of the bundle when it is set —
// fli dev:desktop points it at the screens' dev server. That page's origin is
// the server's, not tauri://localhost, so an origin or CORS fault shows only
// in the bundled build.
//
// A release build reads neither variable and registers no command, so a
// shipped app cannot be scripted or repointed from its environment.
//
// A webview with no new-window handler drops every target=_blank link without
// a sound, so each one goes to the system browser instead.
//
// The tray icon shows and hides the window. Linux's AppIndicator delivers no
// click events -- a click only ever opens the menu -- so the toggle lives in
// the menu as well as on a left click.

use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Runtime, WebviewUrl, WebviewWindowBuilder};
use tauri::webview::NewWindowResponse;

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

// A minimized window still reports visible, so it is brought back rather than
// hidden; otherwise the first click would seem to do nothing.
fn toggle_window<R: Runtime>(app: &AppHandle<R>, label: &MenuItem<R>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let shown = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
    if shown {
        let _ = window.hide();
        let _ = label.set_text("Show Workbench");
    } else {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        let _ = label.set_text("Hide Workbench");
    }
}

fn build_tray<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle", "Hide Workbench", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Workbench", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &quit])?;

    let mut tray = TrayIconBuilder::with_id("workbench")
        .tooltip("Workbench")
        .menu(&menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    let on_menu = toggle.clone();
    tray.on_menu_event(move |app, event| match event.id.as_ref() {
        "toggle" => toggle_window(app, &on_menu),
        "quit" => app.exit(0),
        _ => {}
    })
    .on_tray_icon_event(move |tray, event| {
        if let TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        } = event
        {
            toggle_window(tray.app_handle(), &toggle);
        }
    })
    .build(app)?;
    Ok(())
}

fn main() {
    let probe = probe_script();
    let page = match dev_url() {
        Some(url) => WebviewUrl::External(url),
        None => WebviewUrl::App("index.html".into()),
    };

    let builder = tauri::Builder::default();
    #[cfg(debug_assertions)]
    let builder = if probe.is_some() {
        builder.invoke_handler(tauri::generate_handler![probe_report, probe_done])
    } else {
        builder
    };

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
            build_tray(app.handle())?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the desktop shell failed to start");
}
