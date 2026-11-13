// desktop/shell/src/tray.rs — the tray icon and its menu.
//
// Linux's AppIndicator delivers no click events -- a click only ever opens the
// menu -- so everything a left click does elsewhere is in the menu too.
//
// The screens are listed here as well as in web/src/lib/nav.js; a path that
// no longer exists opens the page's not-found screen, nothing worse. The page
// is told by a `traygoto` DOM event (routes/_module.mesa), so it navigates
// through its own router and keeps its state.
//
// Start API runs this checkout's API with the bun and the origin
// deploy/build.mjs compiled in. A shell built by a bare `cargo build` has
// neither, says so, and offers no Start. An API the shell started is stopped
// when it quits, as `fli desktop:run` does with one it started.
//
// Start at login copies the launcher entry `fli desktop:install` wrote into
// the XDG autostart folder, so a login start goes through `desktop:run` and
// gets its API the same way a launcher click does. Without that entry there is
// nothing to copy, and the item says which command writes it.

use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::Duration;

use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager};

const SCREENS: &[(&str, &str)] = &[
    ("/workbench/",       "Chats"),
    ("/terminal/",        "Terminal"),
    ("/atlas/decide/",    "Decide"),
    ("/atlas/autopilot/", "Autopilot"),
    ("/notifications/",   "Notifications"),
];

// The page's origin is tauri://localhost (http://tauri.localhost on Windows),
// and an API that does not name both refuses the page's calls (FJS-3921).
const SHELL_ORIGINS: &str = "tauri://localhost,http://tauri.localhost";

const API:      Option<&str> = option_env!("WORKBENCH_SHELL_API");
const APP_ROOT: Option<&str> = option_env!("WORKBENCH_SHELL_APP_ROOT");
const BUN:      Option<&str> = option_env!("WORKBENCH_SHELL_BUN");

struct ApiTarget {
    origin: String,
    addr:   String,
    port:   u16,
    local:  bool,
}

fn api_target() -> Option<ApiTarget> {
    let url: tauri::Url = API.filter(|s| !s.is_empty())?.parse().ok()?;
    let host = url.host_str()?.to_string();
    let port = url.port_or_known_default()?;
    Some(ApiTarget {
        origin: url.origin().ascii_serialization(),
        addr:   format!("{host}:{port}"),
        port,
        local:  matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]"),
    })
}

// A port that answers is not proof it is this app's API (FJS-740); the line
// says "answering", which is all a connect can tell.
fn answers(addr: &str) -> bool {
    let Ok(addrs) = addr.to_socket_addrs() else { return false };
    addrs.into_iter().any(|a| TcpStream::connect_timeout(&a, Duration::from_millis(400)).is_ok())
}

/// The API this shell started, if any.
#[derive(Default)]
pub struct StartedApi(Mutex<Option<Child>>);

impl StartedApi {
    fn running(&self) -> bool {
        let mut slot = self.0.lock().unwrap();
        match slot.as_mut().map(|c| c.try_wait()) {
            Some(Ok(None)) => true,
            Some(_) => {
                *slot = None;
                false
            }
            None => false,
        }
    }
}

fn start_api(app: &AppHandle, api: &ApiTarget) {
    let (Some(bun), Some(root)) = (BUN, APP_ROOT) else { return };
    let started = app.state::<StartedApi>();
    if started.running() {
        return;
    }
    let cors = match std::env::var("FRONTIER_CORS_ORIGINS") {
        Ok(have) if !have.trim().is_empty() => format!("{have},{SHELL_ORIGINS}"),
        _ => SHELL_ORIGINS.to_string(),
    };
    let mut cmd = Command::new(bun);
    cmd.arg("api/index.ts")
        .current_dir(root)
        .env("PORT", api.port.to_string())
        .env("FRONTIER_CORS_ORIGINS", cors);
    // Its own group, so stopping it also stops the shells and `claude`
    // processes it spawned rather than leaving them holding the port.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    match cmd.spawn() {
        Ok(child) => *started.0.lock().unwrap() = Some(child),
        Err(e) => eprintln!("workbench: the API could not be started with {bun}: {e}"),
    }
}

/// Stop the API this shell started; one that was already running is left alone.
pub fn stop_api(app: &AppHandle) {
    let Some(mut child) = app.state::<StartedApi>().0.lock().unwrap().take() else { return };
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as libc::pid_t), libc::SIGTERM);
    }
    #[cfg(not(unix))]
    let _ = child.kill();
    let _ = child.wait();
}

// ─── start at login ──────────────────────────────────────────────────────

fn entry_name(app: &AppHandle) -> String {
    format!("{}.desktop", app.config().identifier)
}

fn launcher_entry(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().data_dir().ok()?.join("applications").join(entry_name(app)))
}

fn autostart_entry(app: &AppHandle) -> Option<PathBuf> {
    Some(app.path().config_dir().ok()?.join("autostart").join(entry_name(app)))
}

fn at_login(app: &AppHandle) -> bool {
    autostart_entry(app).is_some_and(|p| p.exists())
}

fn set_at_login(app: &AppHandle, want: bool) -> std::io::Result<()> {
    let target = autostart_entry(app).ok_or(std::io::ErrorKind::NotFound)?;
    if !want {
        return match std::fs::remove_file(&target) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
            _ => Ok(()),
        };
    }
    let source = launcher_entry(app).ok_or(std::io::ErrorKind::NotFound)?;
    std::fs::create_dir_all(target.parent().unwrap())?;
    std::fs::copy(source, target).map(|_| ())
}

// ─── the window ──────────────────────────────────────────────────────────

fn show(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
    }
}

// A minimized window still reports visible, so it is brought back rather than
// hidden; otherwise the first click would seem to do nothing.
fn toggle(app: &AppHandle, label: &MenuItem<tauri::Wry>) {
    let Some(window) = app.get_webview_window("main") else { return };
    let shown = window.is_visible().unwrap_or(false) && !window.is_minimized().unwrap_or(false);
    if shown {
        let _ = window.hide();
        let _ = label.set_text("Show Workbench");
    } else {
        show(app);
        let _ = label.set_text("Hide Workbench");
    }
}

fn go(app: &AppHandle, label: &MenuItem<tauri::Wry>, path: &str) {
    show(app);
    let _ = label.set_text("Hide Workbench");
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.eval(format!(
            "window.dispatchEvent(new CustomEvent('traygoto', {{ detail: '{path}' }}))"
        ));
    }
}

// ─── the tray ────────────────────────────────────────────────────────────

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    app.manage(StartedApi::default());
    let api = api_target();
    let can_start = api.as_ref().is_some_and(|a| a.local) && BUN.is_some() && APP_ROOT.is_some();

    let toggle_item = MenuItem::with_id(app, "toggle", "Hide Workbench", true, None::<&str>)?;
    let status = MenuItem::with_id(app, "api-status", "API: checking…", false, None::<&str>)?;
    let start = MenuItem::with_id(app, "api-start", "Start API", false, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit Workbench", true, None::<&str>)?;

    let menu = Menu::new(app)?;
    menu.append(&toggle_item)?;
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    for (path, label) in SCREENS {
        menu.append(&MenuItem::with_id(app, format!("go:{path}"), *label, true, None::<&str>)?)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    menu.append(&status)?;
    if can_start {
        menu.append(&start)?;
    }
    menu.append(&PredefinedMenuItem::separator(app)?)?;
    let login = if cfg!(target_os = "linux") {
        let installed = launcher_entry(app).is_some_and(|p| p.exists());
        let text = if installed { "Start at login" } else { "Start at login (needs fli desktop:install)" };
        let item = CheckMenuItem::with_id(app, "login", text, installed, at_login(app), None::<&str>)?;
        menu.append(&item)?;
        Some(item)
    } else {
        None
    };
    menu.append(&quit)?;

    let mut tray = TrayIconBuilder::with_id("workbench")
        .tooltip("Workbench")
        .menu(&menu)
        .show_menu_on_left_click(false);
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }

    let on_menu = toggle_item.clone();
    let start_item = start.clone();
    tray.on_menu_event(move |app, event| {
        let id = event.id().as_ref();
        match id {
            "toggle" => toggle(app, &on_menu),
            "quit" => app.exit(0),
            "api-start" => {
                if let Some(api) = api_target() {
                    start_api(app, &api);
                    let _ = start_item.set_enabled(false);
                }
            }
            "login" => {
                // The item has already toggled itself; the file follows it,
                // and a refusal puts the tick back to what is true.
                if let Some(item) = &login {
                    let want = item.is_checked().unwrap_or(false);
                    if let Err(e) = set_at_login(app, want) {
                        eprintln!("workbench: Start at login could not be {}: {e}", if want { "turned on" } else { "turned off" });
                    }
                    let _ = item.set_checked(at_login(app));
                }
            }
            _ => {
                if let Some(path) = id.strip_prefix("go:") {
                    go(app, &on_menu, path);
                }
            }
        }
    })
    .on_tray_icon_event(move |tray, event| {
        if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
            toggle(tray.app_handle(), &toggle_item);
        }
    })
    .build(app)?;

    watch_api(app.clone(), status, start, api, can_start);
    Ok(())
}

// The menu reads the port every few seconds rather than when it opens:
// AppIndicator gives no event for a menu about to show.
fn watch_api(app: AppHandle, status: MenuItem<tauri::Wry>, start: MenuItem<tauri::Wry>, api: Option<ApiTarget>, can_start: bool) {
    let Some(api) = api else {
        let _ = status.set_text("API: not known (built without build:desktop)");
        return;
    };
    std::thread::spawn(move || {
        let mut last = String::new();
        loop {
            let up = answers(&api.addr);
            let starting = !up && app.state::<StartedApi>().running();
            let text = if up {
                format!("API answering at {}", api.origin)
            } else if starting {
                "API starting…".to_string()
            } else {
                format!("API not answering at {}", api.origin)
            };
            if text != last {
                let _ = status.set_text(&text);
                if can_start {
                    let _ = start.set_enabled(!up && !starting);
                }
                last = text;
            }
            std::thread::sleep(Duration::from_secs(3));
        }
    });
}
