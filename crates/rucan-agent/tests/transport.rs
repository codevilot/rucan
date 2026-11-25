use rucan_agent::framing::{read_frame, write_frame};
use std::os::unix::fs::PermissionsExt;
use std::path::Path;
use std::process::{Child, Command, Stdio};
use std::time::Duration;
use tokio::net::UnixStream;

struct Service(Child);

impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn command(path: &Path) -> Command {
    let mut command = Command::new(env!("CARGO_BIN_EXE_rucan-agent"));
    command.arg("serve").arg("--socket").arg(path);
    command
}

async fn connect(path: &Path) -> UnixStream {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if let Ok(stream) = UnixStream::connect(path).await {
                return stream;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("connect to real agent")
}

async fn exchange(socket: &mut UnixStream, kind: u8, bytes: &[u8]) -> serde_json::Value {
    write_frame(socket, kind, bytes).await.expect("send hello");
    let frame = tokio::time::timeout(Duration::from_secs(5), read_frame(socket))
        .await
        .expect("read reply in time")
        .expect("read reply")
        .expect("reply frame");
    assert_eq!(frame.kind, 1);
    serde_json::from_slice(&frame.payload).expect("decode reply")
}

#[tokio::test]
async fn startup_lock_and_negotiation_use_private_socket() {
    let directory = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .expect("private test directory");
    let path = directory.path().join("agent.sock");
    let _first = Service(
        command(&path)
            .stderr(Stdio::piped())
            .spawn()
            .expect("start agent"),
    );
    let mut socket = connect(&path).await;
    let second = command(&path).output().expect("try competing start");
    assert!(!second.status.success());
    let permissions = std::fs::metadata(&path)
        .expect("socket metadata")
        .permissions();
    assert_eq!(permissions.mode() & 0o777, 0o600);

    let welcome = exchange(
        &mut socket,
        1,
        br#"{"type":"hello","minVersion":1,"maxVersion":1,"capabilities":["native-session"]}"#,
    )
    .await;
    assert_eq!(
        welcome,
        serde_json::json!({
            "type": "welcome", "version": 1, "maxFrameBytes": 1048576, "capabilities": ["native-session"]
        })
    );
    let mismatch = exchange(
        &mut connect(&path).await,
        1,
        br#"{"type":"hello","minVersion":2,"maxVersion":2,"capabilities":[]}"#,
    )
    .await;
    assert_eq!(mismatch["code"], "incompatible-version");
    let invalid = exchange(
        &mut connect(&path).await,
        1,
        br#"{"type":"hello","minVersion":1,"maxVersion":1,"capabilities":["fs","fs"]}"#,
    )
    .await;
    assert_eq!(invalid["code"], "invalid-hello");
}

async fn handshake(socket: &mut UnixStream) {
    let reply = exchange(
        socket,
        1,
        br#"{"type":"hello","minVersion":1,"maxVersion":1,"capabilities":["native-session"]}"#,
    )
    .await;
    assert_eq!(reply["type"], "welcome");
}

async fn request(socket: &mut UnixStream, operation: serde_json::Value) -> serde_json::Value {
    let encoded =
        serde_json::to_vec(&serde_json::json!({"id": 7, "operation": operation})).unwrap();
    let reply = exchange(socket, 1, &encoded).await;
    assert_eq!(reply["id"], 7);
    assert_eq!(reply["ok"], true, "{reply}");
    reply["value"].clone()
}

#[tokio::test]
async fn socket_disconnect_preserves_pid_pin_and_terminal_state() {
    use serde_json::json;
    let directory = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .expect("private test directory");
    let path = directory.path().join("agent.sock");
    let _agent = Service(command(&path).spawn().expect("start agent"));
    let mut original = connect(&path).await;
    handshake(&mut original).await;
    let created = request(&mut original, json!({
        "type": "create", "name": "test", "command": "/bin/sh", "cwd": "/",
        "args": ["-c", "printf '\x1b[?1049hREADY\n'; read line; printf '\nECHO:%s\n' \"$line\"; read line"],
        "rows": 24, "cols": 80, "persistent": false,
    })).await;
    let id = created["id"].as_str().unwrap();
    request(
        &mut original,
        json!({"type": "pin", "session": id, "persistent": true}),
    )
    .await;

    let mut observer = connect(&path).await;
    handshake(&mut observer).await;
    let attachment = request(&mut observer, json!({"type": "attach", "session": id})).await;
    assert_eq!(attachment["controlsInput"], false);
    drop(original);
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let attachment = request(&mut observer, json!({"type": "attach", "session": id})).await;
            if attachment["controlsInput"] == true {
                assert_eq!(attachment["session"]["pid"], created["pid"]);
                assert_eq!(attachment["session"]["persistent"], true);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("reclaim input lease");
    let initial = request(&mut observer, json!({"type": "snapshot", "session": id})).await;
    let mut sequence = initial["sequence"].as_u64().unwrap();
    let mut watcher = connect(&path).await;
    handshake(&mut watcher).await;
    let mut input = Vec::new();
    input.extend_from_slice(&8_u32.to_be_bytes());
    input.extend_from_slice(uuid::Uuid::parse_str(id).unwrap().as_bytes());
    input.extend_from_slice(b"unchanged\n");
    assert_eq!(exchange(&mut observer, 2, &input).await["ok"], true);

    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            let snapshot = request(
                &mut watcher,
                json!({"type": "watch", "session": id, "after": sequence}),
            )
            .await;
            sequence = snapshot["sequence"].as_u64().unwrap();
            let visible = request(&mut observer, json!({"type": "snapshot", "session": id})).await;
            if visible["text"].as_str().unwrap().contains("ECHO:unchanged") {
                assert_eq!(visible["alternate"], true);
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("same process produces output after reconnect");
    request(&mut observer, json!({"type": "kill", "session": id})).await;
}

#[tokio::test]
async fn explorer_lists_lazily_and_previews_only_regular_text_files() {
    use serde_json::json;
    use std::os::unix::fs::symlink;

    let directory = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .expect("private test directory");
    let path = directory.path().join("agent.sock");
    let project = directory.path().join("project");
    std::fs::create_dir_all(project.join("src")).unwrap();
    std::fs::create_dir_all(project.join("node_modules")).unwrap();
    let readme = project.join("README.md");
    std::fs::write(&readme, b"project file\n").unwrap();
    symlink(&readme, project.join("link")).unwrap();
    std::fs::write(project.join("binary"), b"\0hello").unwrap();
    let _agent = Service(command(&path).spawn().expect("start agent"));
    let mut socket = connect(&path).await;
    handshake(&mut socket).await;

    let listing = request(
        &mut socket,
        json!({
            "type": "fs-list", "path": project, "exclusions": ["node_modules"]
        }),
    )
    .await;
    assert_eq!(
        listing["entries"],
        json!([
            {"name": "src", "kind": "directory"},
            {"name": "README.md", "kind": "file"},
            {"name": "binary", "kind": "file"},
            {"name": "link", "kind": "symlink"}
        ])
    );
    let text = request(&mut socket, json!({"type": "fs-preview", "path": readme})).await;
    assert_eq!(text["text"], "project file\n");
    let binary = request(
        &mut socket,
        json!({
            "type": "fs-preview", "path": project.join("binary")
        }),
    )
    .await;
    assert_eq!(binary["binary"], true);
    let link = exchange(
        &mut socket,
        1,
        &serde_json::to_vec(&json!({
            "id": 8, "operation": {"type": "fs-preview", "path": project.join("link")}
        }))
        .unwrap(),
    )
    .await;
    assert_eq!(link["ok"], false);
}

#[tokio::test]
async fn stale_socket_recovers_and_shutdown_refuses_active_children() {
    use serde_json::json;
    let directory = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .expect("private test directory");
    let path = directory.path().join("agent.sock");
    drop(std::os::unix::net::UnixListener::bind(&path).expect("simulate a stale socket"));
    let mut daemon = Service(command(&path).spawn().expect("start agent"));
    let mut client = connect(&path).await;
    handshake(&mut client).await;
    request(
        &mut client,
        json!({
            "type": "create", "name": "running", "command": "/bin/sh", "cwd": "/",
            "args": ["-c", "read line"], "rows": 24, "cols": 80, "persistent": false,
        }),
    )
    .await;
    let graceful = exchange(
        &mut client,
        1,
        br#"{"id":8,"operation":{"type":"shutdown","force":false}}"#,
    )
    .await;
    assert_eq!(graceful["ok"], false);
    request(&mut client, json!({"type": "shutdown", "force": true})).await;
    assert!(daemon.0.wait().expect("agent shut down cleanly").success());
    assert!(!path.exists());
}

#[tokio::test]
async fn stalled_observer_cannot_hold_up_pty_output_or_other_clients() {
    use serde_json::json;
    let directory = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .expect("private test directory");
    let path = directory.path().join("agent.sock");
    let _agent = Service(command(&path).spawn().expect("start agent"));
    let mut controller = connect(&path).await;
    handshake(&mut controller).await;
    let fixture = "read line; awk 'BEGIN { for (i=0; i<10000; i++) printf \"\\033[38;2;%d;1;2mX\", i % 250; print \"\\033[0mSLOW-END\" }'; read line";
    let session = request(
        &mut controller,
        json!({
            "type": "create", "name": "output", "command": "/bin/sh", "cwd": "/",
            "args": ["-c", fixture], "rows": 100, "cols": 110, "persistent": false,
        }),
    )
    .await;
    let id = session["id"].as_str().unwrap();

    let initial = request(&mut controller, json!({"type": "snapshot", "session": id})).await;
    let mut slow = connect(&path).await;
    handshake(&mut slow).await;
    let watch =
        json!({"id":12,"operation":{"type":"watch","session":id,"after":initial["sequence"]}});
    write_frame(&mut slow, 1, &serde_json::to_vec(&watch).unwrap())
        .await
        .unwrap();

    let mut begin = Vec::new();
    begin.extend_from_slice(&9_u32.to_be_bytes());
    begin.extend_from_slice(uuid::Uuid::parse_str(id).unwrap().as_bytes());
    begin.extend_from_slice(b"begin\n");
    assert_eq!(exchange(&mut controller, 2, &begin).await["ok"], true);

    let mut independent = connect(&path).await;
    handshake(&mut independent).await;
    tokio::time::timeout(Duration::from_secs(6), async {
        loop {
            let snapshot =
                request(&mut independent, json!({"type": "snapshot", "session": id})).await;
            if snapshot["text"].as_str().unwrap().contains("SLOW-END") {
                break;
            }
            tokio::time::sleep(Duration::from_millis(15)).await;
        }
    })
    .await
    .expect("receive parsed PTY output while the observer does not read");
    drop(slow);
    drop(controller);
    let visible = request(&mut independent, json!({"type":"list"})).await;
    assert_eq!(visible[0]["pid"], session["pid"]);
    assert_eq!(visible[0]["state"]["type"], "running");
    request(&mut independent, json!({"type": "kill", "session": id})).await;
}
