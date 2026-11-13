// ClaudePanel: icono en la barra de menú + popover 380×560 que carga la UI del
// daemon (http://127.0.0.1:7437). Si el daemon no responde, muestra una página
// local con un botón para arrancarlo (vía launchd), nunca una pantalla en blanco.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering::SeqCst};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::image::Image;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::webview::PageLoadEvent;
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
use tauri_plugin_positioner::{Position, WindowExt};

const WINDOW: &str = "popover";
const TRAY: &str = "main";
const DEFAULT_SHORTCUT: &str = "Alt+Super+P";
const DAEMON_LABEL: &str = "com.claudepanel.daemon";

const ICON: &[u8] = include_bytes!("../icons/tray@2x.png");
const ICON_ACTIVE: &[u8] = include_bytes!("../icons/tray-active@2x.png");

struct AppState {
    /// Momento en que el popover se ocultó por perder el foco: un clic en el
    /// icono provoca primero ese blur y no debe volver a abrirlo al instante.
    last_hidden: Mutex<Instant>,
    /// ¿Está el popover mostrando la página del daemon (true) o la local (false)?
    on_daemon: AtomicBool,
    /// El positioner solo sabe dónde está el icono tras el primer evento de bandeja.
    tray_known: AtomicBool,
    /// Token en caché. Se relee del disco si falta (primer arranque: el daemon
    /// aún no lo ha creado) o tras un 401 (lo ha regenerado). Nunca se registra.
    token: Mutex<Option<String>>,
}

// ── entorno ──────────────────────────────────────────────────────────────────

fn port() -> u16 {
    std::env::var("CPANEL_PORT").ok().and_then(|p| p.parse().ok()).unwrap_or(7437)
}

fn daemon_url() -> Url {
    Url::parse(&format!("http://127.0.0.1:{}/", port())).expect("url del daemon")
}

fn offline_url() -> Url {
    Url::parse("tauri://localhost/index.html").expect("url local")
}

fn home() -> PathBuf {
    std::env::var_os("HOME").map(PathBuf::from).unwrap_or_default()
}

fn panel_home() -> PathBuf {
    std::env::var_os("CPANEL_HOME").map(PathBuf::from).unwrap_or_else(|| home().join(".claude-panel"))
}

/// Token local (64 hex). Se inyecta en la página del daemon (y viaja en el
/// fragmento de la URL al abrir el navegador); el daemon nunca lo sirve.
fn read_token() -> Option<String> {
    let raw = std::fs::read_to_string(panel_home().join("token")).ok()?;
    let t = raw.trim();
    (t.len() == 64 && t.bytes().all(|b| b.is_ascii_hexdigit())).then(|| t.to_ascii_lowercase())
}

/// Token en caché; si aún no lo había, lo intenta leer del disco. Si acaba de
/// aparecer, se lo pasa a la página del daemon.
fn token(app: &AppHandle) -> Option<String> {
    let (t, appeared) = {
        let st = app.state::<AppState>();
        let mut cache = st.token.lock().ok()?;
        let missing = cache.is_none();
        if missing {
            *cache = read_token();
        }
        (cache.clone(), missing && cache.is_some())
    };
    if appeared {
        push_token(app);
    }
    t
}

/// Relee el token del disco (tras un 401). Devuelve true si ha cambiado, y en
/// ese caso se lo pasa también a la página del daemon.
fn refresh_token(app: &AppHandle) -> bool {
    let fresh = read_token();
    let changed = {
        let st = app.state::<AppState>();
        let Ok(mut cache) = st.token.lock() else { return false };
        let changed = *cache != fresh;
        *cache = fresh;
        changed
    };
    if changed {
        push_token(app);
    }
    changed
}

/// Atajo de ~/.claude-panel/config.json → "shortcut" (por defecto ⌥⌘P).
fn read_shortcut() -> String {
    std::fs::read_to_string(panel_home().join("config.json"))
        .ok()
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .and_then(|v| v.get("shortcut").and_then(|s| s.as_str()).map(str::to_owned))
        .filter(|s| !s.trim().is_empty() && s.len() <= 60)
        .unwrap_or_else(|| DEFAULT_SHORTCUT.to_owned())
}

// ── daemon ───────────────────────────────────────────────────────────────────

/// GET mínimo a 127.0.0.1 (HTTP/1.0: sin chunked). Evita traer un cliente HTTP entero.
/// Toda la API salvo /api/health exige el token (cabecera x-cpanel-token).
fn http_get(path: &str, token: Option<&str>) -> Option<(u16, String)> {
    let addr = SocketAddr::from(([127, 0, 0, 1], port()));
    let mut s = TcpStream::connect_timeout(&addr, Duration::from_millis(400)).ok()?;
    s.set_read_timeout(Some(Duration::from_millis(1500))).ok()?;
    s.set_write_timeout(Some(Duration::from_millis(500))).ok()?;
    let auth = token.map(|t| format!("x-cpanel-token: {t}\r\n")).unwrap_or_default();
    write!(s, "GET {path} HTTP/1.0\r\nHost: 127.0.0.1:{}\r\n{auth}Connection: close\r\n\r\n", port()).ok()?;
    let mut buf = Vec::new();
    s.take(1 << 20).read_to_end(&mut buf).ok()?;
    let text = String::from_utf8_lossy(&buf);
    let status = text.split_whitespace().nth(1)?.parse().ok()?;
    let body = text.split_once("\r\n\r\n").map(|(_, b)| b.to_owned()).unwrap_or_default();
    Some((status, body))
}

fn daemon_up() -> bool {
    matches!(http_get("/api/health", None), Some((200, _)))
}

/// GET autenticado: si el daemon responde 401, relee el token y, si ha
/// cambiado, reintenta una vez.
fn api_get(app: &AppHandle, path: &str) -> Option<(u16, String)> {
    let res = http_get(path, token(app).as_deref())?;
    if res.0 == 401 && refresh_token(app) {
        return http_get(path, token(app).as_deref());
    }
    Some(res)
}

fn stats(app: &AppHandle) -> Option<(u64, u64)> {
    let (status, body) = api_get(app, "/api/stats")?;
    if status != 200 {
        return None;
    }
    let v: serde_json::Value = serde_json::from_str(&body).ok()?;
    Some((v["active"].as_u64()?, v["paused"].as_u64().unwrap_or(0)))
}

fn uid() -> Option<String> {
    let out = Command::new("/usr/bin/id").arg("-u").output().ok()?;
    let s = String::from_utf8(out.stdout).ok()?.trim().to_owned();
    s.bytes().all(|b| b.is_ascii_digit()).then_some(s)
}

// ── ventana ──────────────────────────────────────────────────────────────────

/// ¿Es exactamente el origen del daemon (http://127.0.0.1:<puerto>)?
fn is_daemon_url(url: &Url) -> bool {
    url.scheme() == "http" && url.host_str() == Some("127.0.0.1") && url.port() == Some(port())
}

/// JS que define window.__CPANEL_TOKEN__, solo si la página es la del daemon.
/// configurable: la app lo redefine si el token cambia; la página no puede
/// sobrescribirlo por asignación. El token son 64 hex validados (sin comillas).
fn token_js(token: &str) -> String {
    format!(
        "if (location.origin === 'http://127.0.0.1:{p}') {{ Object.defineProperty(window, '__CPANEL_TOKEN__', {{ value: '{token}', writable: false, configurable: true }}); }}",
        p = port()
    )
}

/// Inyecta el token actual en el popover si está en la página del daemon.
/// Se llama cuando el token aparece o cambia; la UI lo lee en cada petición,
/// así que su siguiente sondeo ya va autenticado.
fn push_token(app: &AppHandle) {
    let Some(t) = app.state::<AppState>().token.lock().ok().and_then(|c| c.clone()) else { return };
    let h = app.clone();
    let _ = app.run_on_main_thread(move || {
        let Some(w) = h.get_webview_window(WINDOW) else { return };
        if w.url().is_ok_and(|u| is_daemon_url(&u)) {
            let _ = w.eval(token_js(&t));
        }
    });
}

/// Pone en el popover la página que toca según si el daemon responde.
fn sync_page(app: &AppHandle, up: bool) {
    let Some(w) = app.get_webview_window(WINDOW) else { return };
    let st = app.state::<AppState>();
    if st.on_daemon.load(SeqCst) == up {
        return;
    }
    if w.navigate(if up { daemon_url() } else { offline_url() }).is_ok() {
        st.on_daemon.store(up, SeqCst);
    }
}

fn show(app: &AppHandle, w: &WebviewWindow) {
    sync_page(app, daemon_up());
    let pos = if app.state::<AppState>().tray_known.load(SeqCst) { Position::TrayCenter } else { Position::TopRight };
    let _ = w.as_ref().window().move_window(pos);
    let _ = w.show();
    let _ = w.set_focus();
}

fn toggle(app: &AppHandle) {
    let Some(w) = app.get_webview_window(WINDOW) else { return };
    if w.is_visible().unwrap_or(false) {
        let _ = w.hide();
        return;
    }
    if app.state::<AppState>().last_hidden.lock().map(|t| t.elapsed() < Duration::from_millis(300)).unwrap_or(false) {
        return; // el clic en el icono acaba de cerrarla por blur
    }
    show(app, &w);
}

fn open_external(url: &Url) {
    if matches!(url.scheme(), "http" | "https") {
        let _ = Command::new("/usr/bin/open").arg(url.as_str()).spawn();
    }
}

/// «Abrir en el navegador»: la UI con el token en el fragmento (#t=…), que el
/// navegador no envía al servidor. La URL va por stdin a osascript, no en argv
/// (otros usuarios verían el token en `ps`).
fn open_in_browser(app: &AppHandle) {
    let Some(token) = token(app) else {
        open_external(&daemon_url());
        return;
    };
    let script = format!("open location \"http://127.0.0.1:{}/#t={token}\"\n", port());
    let child = Command::new("/usr/bin/osascript").arg("-").stdin(Stdio::piped()).spawn();
    if let Ok(mut child) = child {
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(script.as_bytes());
        }
        // sin esperar en el hilo de la UI: se recoge en segundo plano
        std::thread::spawn(move || {
            let _ = child.wait();
        });
    }
}

/// Solo se navega dentro del popover a la UI del daemon o a la página local;
/// cualquier otro enlace (p. ej. un PR) se abre en el navegador por defecto.
fn allow_navigation(url: &Url) -> bool {
    let local = url.scheme() == "tauri" || (url.scheme() == "about" && url.path() == "blank");
    if local || is_daemon_url(url) {
        return true;
    }
    open_external(url);
    false
}

// ── icono ────────────────────────────────────────────────────────────────────

fn update_tray(app: &AppHandle, up: bool, active: u64, paused: u64) {
    let Some(tray) = app.tray_by_id(TRAY) else { return };
    let bytes = if up && active > 0 { ICON_ACTIVE } else { ICON };
    if let Ok(img) = Image::from_bytes(bytes) {
        let _ = tray.set_icon(Some(img));
        let _ = tray.set_icon_as_template(true);
    }
    let tip = if !up {
        "ClaudePanel: daemon apagado".to_owned()
    } else {
        let a = if active == 1 { "1 activa".to_owned() } else { format!("{active} activas") };
        format!("ClaudePanel: {a}, {paused} en pausa")
    };
    let _ = tray.set_tooltip(Some(tip));
}

// ── comandos (solo para la página local) ─────────────────────────────────────

#[tauri::command]
fn daemon_status() -> bool {
    daemon_up()
}

/// Arranca el daemon a través de launchd (el mismo agente que al iniciar sesión).
#[tauri::command]
fn start_daemon() -> Result<(), String> {
    let plist = home().join("Library/LaunchAgents").join(format!("{DAEMON_LABEL}.plist"));
    if !plist.exists() {
        return Err("El servicio no está instalado. En una terminal: cpanel launchd install".into());
    }
    let domain = format!("gui/{}", uid().ok_or("no se pudo obtener el uid")?);
    // si ya estaba cargado, bootstrap falla y da igual: kickstart lo arranca
    let _ = Command::new("/bin/launchctl").args(["bootstrap", &domain]).arg(&plist).output();
    let out = Command::new("/bin/launchctl")
        .args(["kickstart", &format!("{domain}/{DAEMON_LABEL}")])
        .output()
        .map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        Err(format!("launchctl: {}", String::from_utf8_lossy(&out.stderr).trim()))
    }
}

#[tauri::command]
fn open_panel(app: AppHandle) {
    sync_page(&app, daemon_up());
}

// ── main ─────────────────────────────────────────────────────────────────────

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(w) = app.get_webview_window(WINDOW) {
                show(app, &w);
            }
        }))
        .plugin(tauri_plugin_positioner::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == ShortcutState::Pressed {
                        toggle(app);
                    }
                })
                .build(),
        )
        .manage(AppState {
            last_hidden: Mutex::new(Instant::now() - Duration::from_secs(10)),
            on_daemon: AtomicBool::new(false),
            tray_known: AtomicBool::new(false),
            token: Mutex::new(None),
        })
        .invoke_handler(tauri::generate_handler![daemon_status, start_daemon, open_panel])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            // popover
            // El script de inicialización lleva el token del arranque (si ya
            // existe); on_page_load lo reinyecta con el valor actual en cada
            // carga o recarga de la página del daemon, por si faltaba o cambió.
            let init_js = token(app.handle()).map(|t| token_js(&t)).unwrap_or_default();
            let up = daemon_up();
            let url = if up { WebviewUrl::External(daemon_url()) } else { WebviewUrl::App("index.html".into()) };
            let w = WebviewWindowBuilder::new(app, WINDOW, url)
                .title("ClaudePanel")
                .inner_size(380.0, 560.0)
                .resizable(false)
                .decorations(false)
                .shadow(true)
                .visible(false)
                .always_on_top(true)
                .skip_taskbar(true)
                .initialization_script(&init_js)
                .on_navigation(allow_navigation)
                .on_page_load(|w, payload| {
                    let load = matches!(payload.event(), PageLoadEvent::Started | PageLoadEvent::Finished);
                    if load && is_daemon_url(payload.url()) {
                        // token() relee el disco si aún no lo había
                        if let Some(t) = token(w.app_handle()) {
                            let _ = w.eval(token_js(&t));
                        }
                    }
                })
                .build()?;
            app.state::<AppState>().on_daemon.store(up, SeqCst);

            let handle = app.handle().clone();
            w.on_window_event(move |ev| {
                if let WindowEvent::Focused(false) = ev {
                    if let Some(w) = handle.get_webview_window(WINDOW) {
                        let _ = w.hide();
                    }
                    if let Ok(mut t) = handle.state::<AppState>().last_hidden.lock() {
                        *t = Instant::now();
                    }
                }
            });

            // icono y menú (clic izquierdo: popover; derecho: menú)
            let menu = Menu::with_items(
                app,
                &[
                    &MenuItem::with_id(app, "open", "Abrir panel", true, None::<&str>)?,
                    &MenuItem::with_id(app, "browser", "Abrir en el navegador", true, None::<&str>)?,
                    &PredefinedMenuItem::separator(app)?,
                    &MenuItem::with_id(app, "quit", "Salir de ClaudePanel", true, None::<&str>)?,
                ],
            )?;
            TrayIconBuilder::with_id(TRAY)
                .icon(Image::from_bytes(ICON)?)
                .icon_as_template(true)
                .tooltip("ClaudePanel")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, ev| match ev.id().as_ref() {
                    "open" => {
                        if let Some(w) = app.get_webview_window(WINDOW) {
                            show(app, &w);
                        }
                    }
                    "browser" => open_in_browser(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, ev| {
                    let app = tray.app_handle();
                    tauri_plugin_positioner::on_tray_event(app, &ev);
                    app.state::<AppState>().tray_known.store(true, SeqCst);
                    if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = ev {
                        toggle(app);
                    }
                })
                .build(app)?;

            // atajo global (configurable); si el configurado no vale, el de por defecto
            let sc = read_shortcut();
            if let Err(e) = app.global_shortcut().register(sc.as_str()) {
                eprintln!("atajo «{sc}» no válido o en uso: {e}");
                if sc != DEFAULT_SHORTCUT {
                    if let Err(e) = app.global_shortcut().register(DEFAULT_SHORTCUT) {
                        eprintln!("atajo por defecto no disponible: {e}");
                    }
                }
            }

            // sondeo: punto en el icono si hay sesiones activas; cambio de página si el daemon cae o vuelve
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                let mut last: Option<(bool, u64, u64)> = None;
                loop {
                    let up = daemon_up();
                    let (a, p) = if up { stats(&handle).unwrap_or((0, 0)) } else { (0, 0) };
                    if last != Some((up, a, p)) {
                        last = Some((up, a, p));
                        let h = handle.clone();
                        let _ = handle.run_on_main_thread(move || update_tray(&h, up, a, p));
                    }
                    let visible = handle.get_webview_window(WINDOW).and_then(|w| w.is_visible().ok()).unwrap_or(false);
                    if visible {
                        let h = handle.clone();
                        let _ = handle.run_on_main_thread(move || sync_page(&h, up));
                    }
                    std::thread::sleep(Duration::from_secs(5));
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error al arrancar ClaudePanel");
}
