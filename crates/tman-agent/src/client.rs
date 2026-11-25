use crate::framing::{read_frame, write_frame};
use serde_json::{Value, json};
use std::io::{self, ErrorKind};
use std::path::Path;
use std::time::Duration;
use tokio::net::UnixStream;

async fn exchange(socket: &mut UnixStream, payload: Value) -> io::Result<Value> {
    write_frame(socket, 1, &serde_json::to_vec(&payload)?).await?;
    let frame = read_frame(socket).await?.ok_or_else(|| {
        io::Error::new(ErrorKind::UnexpectedEof, "agent closed without a response")
    })?;
    if frame.kind != 1 {
        return Err(io::Error::new(
            ErrorKind::InvalidData,
            "unexpected agent frame kind",
        ));
    }
    Ok(serde_json::from_slice(&frame.payload)?)
}

/// Run one same-user operation without installing a Node.js client on the host.
pub async fn control(path: &Path, operation: Value) -> io::Result<Value> {
    crate::transport::private_socket_directory(path)?;
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut socket = UnixStream::connect(path).await?;
        let hello = exchange(&mut socket, json!({
            "type": "hello", "minVersion": 1, "maxVersion": 1, "capabilities": ["native-session"],
        })).await?;
        if hello["type"] != "welcome" || hello["version"] != 1 {
            return Err(io::Error::new(
                ErrorKind::InvalidData,
                "agent protocol version mismatch",
            ));
        }
        let response = exchange(&mut socket, json!({"id": 1, "operation": operation})).await?;
        if response["id"] != 1 || response["ok"] != true {
            let message = response["error"]
                .as_str()
                .unwrap_or("invalid agent response");
            return Err(io::Error::other(message));
        }
        Ok(response["value"].clone())
    })
    .await?
}
