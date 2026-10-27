#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::env;
use std::hash::{Hash, Hasher};
use std::io::{Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::State;

const GATEWAY_HOST: &str = "127.0.0.1";
const GATEWAY_PORT: u16 = 43210;
const GATEWAY_URL: &str = "http://127.0.0.1:43210";

#[derive(Default)]
struct GatewayState {
    process: Mutex<Option<ManagedGateway>>,
}

struct ManagedGateway {
    child: Child,
    token: String,
}

impl Drop for ManagedGateway {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct GatewayStatus {
    api_base: &'static str,
    token: String,
    managed: bool,
}

fn gateway_is_healthy() -> bool {
    let address = (GATEWAY_HOST, GATEWAY_PORT)
        .to_socket_addrs()
        .ok()
        .and_then(|mut addresses| addresses.next());
    let Some(address) = address else { return false };
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_millis(250)) else { return false };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(250)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(250)));
    if stream.write_all(b"GET /health HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n").is_err() { return false; }
    let mut response = [0_u8; 256];
    let Ok(size) = stream.read(&mut response) else { return false };
    let text = String::from_utf8_lossy(&response[..size]);
    text.starts_with("HTTP/1.1 200") || text.starts_with("HTTP/1.0 200")
}

fn desktop_token() -> String {
    let now = SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_nanos();
    let mut first = std::collections::hash_map::DefaultHasher::new();
    (now, std::process::id()).hash(&mut first);
    let mut second = std::collections::hash_map::DefaultHasher::new();
    (std::process::id(), now.rotate_left(17)).hash(&mut second);
    format!("desktop-{:016x}{:016x}", first.finish(), second.finish())
}

fn command_candidates() -> Vec<Command> {
    let mut candidates = Vec::new();
    if let Ok(path) = env::var("AGENTCORPS_CLI") {
        let path = PathBuf::from(path);
        if path.extension().and_then(|extension| extension.to_str()) == Some("js") {
            let mut command = Command::new("node");
            command.arg(path);
            candidates.push(command);
        } else {
            candidates.push(Command::new(path));
        }
    }

    let repository_cli = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../apps/cli/dist/index.js");
    if repository_cli.exists() {
        let mut command = Command::new("node");
        command.arg(repository_cli);
        candidates.push(command);
    }

    candidates.push(Command::new("agentcorps"));
    candidates
}

fn spawn_gateway(token: &str) -> Result<Child, String> {
    let mut errors = Vec::new();
    for mut command in command_candidates() {
        let description = format!("{:?}", command);
        let result = command
            .arg("serve")
            .arg("--host")
            .arg(GATEWAY_HOST)
            .arg("--port")
            .arg(GATEWAY_PORT.to_string())
            .arg("--token")
            .arg(token)
            .arg("--cors-origin")
            .arg("*")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn();
        match result {
            Ok(child) => return Ok(child),
            Err(error) => errors.push(format!("{description}: {error}")),
        }
    }
    Err(format!(
        "Could not start the local gateway. Install the AgentCorps CLI or set AGENTCORPS_CLI to its executable. Attempts: {}",
        errors.join("; ")
    ))
}

#[tauri::command]
fn ensure_gateway(state: State<'_, GatewayState>) -> Result<GatewayStatus, String> {
    let mut process = state.process.lock().map_err(|_| "Gateway supervisor is unavailable".to_string())?;
    if gateway_is_healthy() {
        if let Some(managed) = process.as_mut() {
            return Ok(GatewayStatus { api_base: GATEWAY_URL, token: managed.token.clone(), managed: true });
        }
        return Ok(GatewayStatus { api_base: GATEWAY_URL, token: String::new(), managed: false });
    }

    *process = None;
    let token = desktop_token();
    let mut child = spawn_gateway(&token)?;
    let deadline = Instant::now() + Duration::from_secs(8);
    while Instant::now() < deadline {
        if gateway_is_healthy() {
            *process = Some(ManagedGateway { child, token: token.clone() });
            return Ok(GatewayStatus { api_base: GATEWAY_URL, token, managed: true });
        }
        if let Ok(Some(status)) = child.try_wait() {
            return Err(format!("The local gateway exited before becoming ready ({status}). Run agentcorps doctor for diagnostics."));
        }
        thread::sleep(Duration::from_millis(100));
    }
    let _ = child.kill();
    let _ = child.wait();
    Err("The local gateway did not become ready within 8 seconds. Run agentcorps doctor for diagnostics.".to_string())
}

pub fn run() {
    tauri::Builder::default()
        .manage(GatewayState::default())
        .invoke_handler(tauri::generate_handler![ensure_gateway])
        .run(tauri::generate_context!())
        .expect("error while running AgentCorps desktop");
}
