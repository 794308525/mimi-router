#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    fs::{self, OpenOptions},
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::Duration,
};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    App, AppHandle, Manager, RunEvent,
};

#[derive(Default)]
struct GatewayProcess(Mutex<Option<Child>>);

fn show_main_window(app: &AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn gateway_ready() -> bool {
    let address = SocketAddr::from(([127, 0, 0, 1], 18080));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else {
        return false;
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1:18080\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = Vec::with_capacity(2048);
    if stream.read_to_end(&mut response).is_err() {
        return false;
    }
    let response = String::from_utf8_lossy(&response);
    response.starts_with("HTTP/1.1 200") && response.contains("\"status\":\"running\"")
}

fn start_gateway(app: &App) -> Result<(), Box<dyn std::error::Error>> {
    if gateway_ready() {
        return Ok(());
    }

    let resource_dir = app.path().resource_dir()?;
    let data_dir = app.path().app_data_dir()?;
    let log_dir = app.path().app_log_dir()?;
    fs::create_dir_all(&data_dir)?;
    fs::create_dir_all(&log_dir)?;

    let node_path = resource_dir.join("runtime/node");
    let server_path = resource_dir.join("server/index.mjs");
    let log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_dir.join("gateway.log"))?;
    let error_log = log.try_clone()?;

    let child = Command::new(node_path)
        .arg("--no-warnings")
        .arg(server_path)
        .env("CODEX_ROUTER_DATA_DIR", &data_dir)
        .env("CODEX_ROUTER_HOST", "0.0.0.0")
        .env("CODEX_ROUTER_PORT", "18080")
        .stdin(Stdio::null())
        .stdout(Stdio::from(log))
        .stderr(Stdio::from(error_log))
        .spawn()?;

    *app.state::<GatewayProcess>().0.lock().unwrap() = Some(child);
    Ok(())
}

fn wait_for_gateway(app: AppHandle) {
    thread::spawn(move || {
        for _ in 0..80 {
            if gateway_ready() {
                show_main_window(&app);
                return;
            }
            thread::sleep(Duration::from_millis(100));
        }
        show_main_window(&app);
    });
}

fn stop_gateway(app: &AppHandle) {
    let state = app.state::<GatewayProcess>();
    let Ok(mut process) = state.0.lock() else {
        return;
    };
    if let Some(mut child) = process.take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .manage(GatewayProcess::default())
        .setup(|app| {
            let show = MenuItem::with_id(app, "show", "打开咪咪 Router", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &quit])?;

            let mut tray = TrayIconBuilder::with_id("codex-router")
                .tooltip("咪咪 Router")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main_window(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        button: MouseButton::Left,
                        button_state: MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main_window(tray.app_handle());
                    }
                });

            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.build(app)?;

            if cfg!(debug_assertions) {
                show_main_window(app.handle());
            } else {
                if let Err(error) = start_gateway(app) {
                    eprintln!("[desktop] 本地网关启动失败: {error}");
                }
                wait_for_gateway(app.handle().clone());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("failed to build 咪咪 Router desktop application");

    app.run(|app, event| {
        if matches!(event, RunEvent::Exit) {
            stop_gateway(app);
        }
    });
}
