use std::{
  fs::{self, OpenOptions},
  io::{Read, Write},
  net::{SocketAddr, TcpStream},
  path::PathBuf,
  process::{Child, Command, Stdio},
  sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
  },
  time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

use tauri::{Manager, WindowEvent};

struct BackendState(Mutex<Option<Child>>);

static DESKTOP_CONSOLE_LOGGING: AtomicBool = AtomicBool::new(false);

#[cfg(windows)]
mod windows_console {
  #[link(name = "kernel32")]
  extern "system" {
    fn AttachConsole(dw_process_id: u32) -> i32;
  }

  const ATTACH_PARENT_PROCESS: u32 = 0xFFFF_FFFF;

  pub fn attach_parent_console() -> bool {
    // SAFETY: AttachConsole is a process-wide Windows API. Passing the documented
    // ATTACH_PARENT_PROCESS constant only asks Windows to connect this GUI-subsystem
    // process to the launching console, when one exists.
    unsafe { AttachConsole(ATTACH_PARENT_PROCESS) != 0 }
  }
}

fn desktop_debug_requested() -> bool {
  let env_enabled = std::env::var("CODEXMATE_DESKTOP_LOG")
    .map(|value| matches!(value.trim().to_ascii_lowercase().as_str(), "1" | "true" | "yes" | "on" | "trace" | "debug"))
    .unwrap_or(false);
  if env_enabled {
    return true;
  }

  std::env::args().skip(1).any(|arg| {
    matches!(
      arg.as_str(),
      "--debug-console" | "--console-log" | "--log-to-console" | "--verbose" | "--trace"
    )
  })
}

fn desktop_log_file_path() -> PathBuf {
  if let Ok(value) = std::env::var("CODEXMATE_DESKTOP_LOG_FILE") {
    let trimmed = value.trim();
    if !trimmed.is_empty() {
      return PathBuf::from(trimmed);
    }
  }

  desktop_default_logs_dir().join("desktop.log")
}

fn desktop_default_logs_dir() -> PathBuf {
  let base_dir = std::env::var_os("LOCALAPPDATA")
    .map(PathBuf::from)
    .unwrap_or_else(|| std::env::temp_dir());
  base_dir
    .join("CodexMate")
    .join("logs")
}

fn backend_startup_log_file_path() -> PathBuf {
  desktop_default_logs_dir().join("startup.log")
}

fn now_epoch_millis() -> u128 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .map(|value| value.as_millis())
    .unwrap_or(0)
}

fn write_console_log(line: &str) {
  #[cfg(windows)]
  if let Ok(mut console) = OpenOptions::new().write(true).open("CONOUT$") {
    let _ = console.write_all(line.as_bytes());
    return;
  }

  let _ = std::io::stderr().write_all(line.as_bytes());
}

fn desktop_log(message: impl AsRef<str>) {
  let line = format!("[{}] {}\n", now_epoch_millis(), message.as_ref());
  if DESKTOP_CONSOLE_LOGGING.load(Ordering::Relaxed) {
    write_console_log(&line);
  }

  append_log_line(desktop_log_file_path(), &line);
  append_log_line(backend_startup_log_file_path(), &line);
}

fn append_log_line(log_path: PathBuf, line: &str) {
  if let Some(parent) = log_path.parent() {
    let _ = fs::create_dir_all(parent);
  }
  if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(log_path) {
    let _ = file.write_all(line.as_bytes());
  }
}

fn backend_startup_log_stdio() -> Stdio {
  let log_path = backend_startup_log_file_path();
  if let Some(parent) = log_path.parent() {
    let _ = fs::create_dir_all(parent);
  }
  OpenOptions::new()
    .create(true)
    .append(true)
    .open(log_path)
    .map(Stdio::from)
    .unwrap_or_else(|_| Stdio::null())
}

fn configure_desktop_console_logging() -> bool {
  if !desktop_debug_requested() {
    DESKTOP_CONSOLE_LOGGING.store(false, Ordering::Relaxed);
    return false;
  }

  #[cfg(windows)]
  let attached = windows_console::attach_parent_console();
  #[cfg(not(windows))]
  let attached = true;

  DESKTOP_CONSOLE_LOGGING.store(attached, Ordering::Relaxed);
  attached
}

pub fn init_desktop_diagnostics() {
  let console_attached = configure_desktop_console_logging();
  let log_path = desktop_log_file_path();
  std::panic::set_hook(Box::new(move |panic_info| {
    desktop_log(format!("panic: {panic_info}"));
  }));

  desktop_log(format!(
    "codexmate desktop starting; console_logging={}; log_file={}; startup_log_file={}",
    console_attached,
    log_path.display(),
    backend_startup_log_file_path().display()
  ));
  desktop_log(format!(
    "args={}",
    std::env::args().collect::<Vec<_>>().join(" ")
  ));
}

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
  let status_ok = response.starts_with("HTTP/1.1 200") || response.starts_with("HTTP/1.0 200");
  let identity_ok = response.contains("\"ok\":true");
  status_ok && identity_ok
}

fn wait_for_backend(timeout: Duration) -> bool {
  let started = Instant::now();
  while started.elapsed() < timeout {
    if health_check_ready() {
      desktop_log("backend health check passed");
      return true;
    }
    std::thread::sleep(Duration::from_millis(200));
  }
  desktop_log("backend health check timed out");
  false
}

#[cfg(windows)]
fn configure_backend_process(command: &mut Command) {
  if DESKTOP_CONSOLE_LOGGING.load(Ordering::Relaxed) {
    return;
  }
  const CREATE_NO_WINDOW: u32 = 0x08000000;
  command.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn configure_backend_process(_command: &mut Command) {}

fn find_cli_path(app: &tauri::App) -> Result<PathBuf, Box<dyn std::error::Error>> {
  let mut candidates = Vec::new();

  if let Ok(resource_dir) = app.path().resource_dir() {
    candidates.push(resource_dir.join("codexmate").join("cli.js"));
    candidates.push(resource_dir.join("cli.js"));
  }

  #[cfg(debug_assertions)]
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
    desktop_log("backend spawn skipped by CODEXMATE_DESKTOP_SKIP_BACKEND=1");
    return Ok(None);
  }

  if health_check_ready() {
    desktop_log("existing backend already ready on 127.0.0.1:3737");
    return Ok(None);
  }

  let cli_path = find_cli_path(app)?;
  let cli_dir = cli_path
    .parent()
    .ok_or_else(|| "unable to resolve codexmate cli directory")?;
  let node_bin = std::env::var("CODEXMATE_NODE").unwrap_or_else(|_| "node".to_string());
  let inherit_backend_stdio = DESKTOP_CONSOLE_LOGGING.load(Ordering::Relaxed);

  desktop_log(format!(
    "spawning backend; node={}; cli={}; cwd={}; inherit_stdio={}",
    node_bin,
    cli_path.display(),
    cli_dir.display(),
    inherit_backend_stdio
  ));

  let mut command = Command::new(node_bin);
  command
    .arg(&cli_path)
    .arg("run")
    .arg("--host")
    .arg("127.0.0.1")
    .arg("--no-browser")
    .current_dir(cli_dir)
    .env("CODEXMATE_NO_BROWSER", "1")
    .env("CODEXMATE_HOST", "127.0.0.1")
    .env("CODEXMATE_PORT", "3737")
    .stdin(Stdio::null());

  if inherit_backend_stdio {
    command.stdout(Stdio::inherit()).stderr(Stdio::inherit());
  } else {
    command.stdout(backend_startup_log_stdio()).stderr(backend_startup_log_stdio());
  }

  configure_backend_process(&mut command);

  let mut child = command.spawn().map_err(|err| {
    desktop_log(format!("backend spawn failed: {err}"));
    format!("unable to start codexmate backend with Node.js: {err}")
  })?;

  desktop_log(format!("backend process spawned; pid={}", child.id()));

  if !wait_for_backend(Duration::from_secs(15)) {
    let _ = child.kill();
    let _ = child.wait();
    desktop_log("backend killed after readiness timeout");
    return Err("codexmate backend did not become ready on 127.0.0.1:3737".into());
  }

  Ok(Some(child))
}

fn stop_backend(window: &tauri::Window) {
  let state = window.state::<BackendState>();
  let child = {
    let mut guard = match state.0.lock() {
      Ok(value) => value,
      Err(_) => return,
    };
    guard.take()
  };

  if let Some(mut child) = child {
    desktop_log(format!("stopping backend process; pid={}", child.id()));
    let _ = child.kill();
    let _ = child.wait();
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  desktop_log("building tauri application");
  tauri::Builder::default()
    .setup(|app| {
      app.handle().plugin(
        tauri_plugin_log::Builder::default()
          .level(log::LevelFilter::Info)
          .build(),
      )?;
      if cfg!(debug_assertions) {
        desktop_log("debug build: backend managed by beforeDevCommand");
        app.manage(BackendState(Mutex::new(None)));
      } else {
        let child = spawn_backend(app)?;
        app.manage(BackendState(Mutex::new(child)));
      }
      Ok(())
    })
    .on_window_event(|window, event| {
      if window.label() == "main" && matches!(event, WindowEvent::Destroyed) {
        desktop_log("main window destroyed");
        stop_backend(window);
      }
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
