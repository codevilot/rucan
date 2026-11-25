use serde_json::json;
use std::{
    path::{Path, PathBuf},
    process::ExitCode,
};

#[tokio::main(flavor = "current_thread")]
async fn main() -> ExitCode {
    let args: Vec<_> = std::env::args_os().skip(1).collect();
    match args.as_slice() {
        [flag] if flag == "--version" => {
            println!("rucan-agent {}", env!("CARGO_PKG_VERSION"));
            ExitCode::SUCCESS
        }
        [action, command, tail @ ..] if action == "ctl" => {
            let Some(command) = command.to_str() else {
                eprintln!("rucan-agent ctl: expected a UTF-8 command");
                return ExitCode::FAILURE;
            };
            let path = std::env::var_os("RUCAN_AGENT_SOCKET").map_or_else(
                || PathBuf::from(format!("/tmp/rucan-{}/agent.sock", nix::unistd::geteuid())),
                PathBuf::from,
            );
            let session = tail
                .first()
                .and_then(|value| value.to_str())
                .map(str::to_owned)
                .or_else(|| std::env::var("RUCAN_SESSION_ID").ok());
            let operation = match (command, tail.len(), session) {
                ("ls", 0, _) => json!({"type": "list"}),
                ("pin" | "unpin", 0 | 1, Some(session)) => {
                    json!({"type": "pin", "session": session, "persistent": command == "pin"})
                }
                ("kill", 0 | 1, Some(session)) => {
                    eprintln!("Stopping session {session} on {}", path.display());
                    json!({"type": "kill", "session": session})
                }
                _ => {
                    eprintln!(
                        "Usage: rucan-agent ctl ls | pin [session] | unpin [session] | kill [session]"
                    );
                    return ExitCode::FAILURE;
                }
            };
            match rucan_agent::client::control(&path, operation).await {
                Ok(reply) => {
                    println!("{reply}");
                    ExitCode::SUCCESS
                }
                Err(error) => {
                    eprintln!("rucan-agent ctl: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        [action, flag, path]
            if (action == "bridge" || action == "connect") && flag == "--socket" =>
        {
            match rucan_agent::bridge::bridge(Path::new(path), action == "connect") {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("rucan-agent bridge: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        [action, flag, path] if action == "start" && flag == "--socket" => {
            let result = rucan_agent::bridge::start_daemon(Path::new(path));
            match result {
                Ok(_) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("rucan-agent start: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        [action, flag, path] if (action == "serve" || action == "daemon") && flag == "--socket" => {
            if action == "daemon"
                && let Err(error) = nix::unistd::setsid()
            {
                eprintln!("rucan-agent detach: {error}");
                return ExitCode::FAILURE;
            }
            nix::sys::stat::umask(nix::sys::stat::Mode::from_bits_truncate(0o077));
            match rucan_agent::transport::serve(Path::new(path)).await {
                Ok(()) => ExitCode::SUCCESS,
                Err(error) => {
                    eprintln!("rucan-agent: {error}");
                    ExitCode::FAILURE
                }
            }
        }
        _ => {
            eprintln!(
                "Usage: rucan-agent [--version | (serve|start|bridge|connect) --socket <absolute path>]"
            );
            ExitCode::FAILURE
        }
    }
}
