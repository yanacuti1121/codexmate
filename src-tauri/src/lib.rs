use std::{
  io::{Read, Write},
  net::{SocketAddr, TcpStream},
  path::PathBuf,
  process::{Child, Command, Stdio},
  sync::Mutex,
  time::{Duration, Instant},
};

use tauri::{Manager, WindowEvent};

struct BackendState(Mutex<Option<Child>>);

fn health_check_ready() -> bool {
  let addr: SocketAddr = match "127.0.0.1:3737".parse() {
    Ok(value) => value,
    Err(_) => return false,
  };
  let mut stream = match TcpStream::connect_timeout(&addr, Duration::from_millis(300)) {
    Ok(value) => value,
    Err(_) => return false,
  };
  let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
  let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));

  let body = r#"{"action":"health-check","params":{}}"#;
  let request = format!(
    "POST /api HTTP/1.1\r\nHost: 127.0.0.1:3737\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
    body.as_bytes().len(),
    body
  );
  if stream.write_all(request.as_bytes()).is_err() {
    return false;
  }

  let mut response = String::new();
  if stream.read_to_string(&mut response).is_err() {
    return false;
  }
  response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200")
}

fn wait_for_backend(timeout: Duration) -> bool {
  let started = Instant::now();
  while started.elapsed() < timeout {
    if health_check_ready() {
      return true;
    }
    std::thread::sleep(Duration::from_millis(200));
  }
  false
}

fn find_cli_path(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
  let mut candidates = Vec::new();

  if let Ok(resource_dir) = app.path().resource_dir() {
    candidates.push(resource_dir.join("codexmate").join("cli.js"));
    candidates.push(resource_dir.join("cli.js"));
  }

  if let Ok(current_dir) = std::env::current_dir() {
    candidates.push(current_dir.join("cli.js"));
  }

  candidates
    .into_iter()
    .find(|candidate| candidate.is_file())
    .ok_or_else(|| "unable to locate bundled codexmate cli.js".into())
}

fn spawn_backend(app: &tauri::App) -> Result<Option<Child>, Box<dyn std::error::Error>> {
  if std::env::var("CODEXMATE_DESKTOP_SKIP_BACKEND").ok().as_deref() == Some("1") {
    return Ok(None);
  }

  if health_check_ready() {
    return Ok(None);
  }

  let cli_path = find_cli_path(app)?;
  let cli_dir = cli_path
    .parent()
    .ok_or_else(|| "unable to resolve codexmate cli directory")?;
  let node_bin = std::env::var("CODEXMATE_NODE").unwrap_or_else(|_| "node".to_string());

  let child = Command::new(node_bin)
    .arg(&cli_path)
    .arg("run")
    .arg("--host")
    .arg("127.0.0.1")
    .arg("--no-browser")
    .current_dir(cli_dir)
    .env("CODEXMATE_NO_BROWSER", "1")
    .env("CODEXMATE_HOST", "127.0.0.1")
    .env("CODEXMATE_PORT", "3737")
    .stdin(Stdio::null())
    .stdout(Stdio::null())
    .stderr(Stdio::null())
    .spawn()
    .map_err(|err| format!("unable to start codexmate backend with Node.js: {err}"))?;

  if !wait_for_backend(Duration::from_secs(15)) {
    return Err("codexmate backend did not become ready on 127.0.0.1:3737".into());
  }

  Ok(Some(child))
}

fn stop_backend(window: &tauri::Window) {
  let state = window.state::<BackendState>();
  if let Ok(mut guard) = state.0.lock() {
    if let Some(mut child) = guard.take() {
      let _ = child.kill();
      let _ = child.wait();
    }
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
        app.manage(BackendState(Mutex::new(None)));
      } else {
        let child = spawn_backend(app)?;
        app.manage(BackendState(Mutex::new(child)));
      }
      Ok(())
    })
    .on_window_event(|window, event| {
      if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
        stop_backend(window);
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
