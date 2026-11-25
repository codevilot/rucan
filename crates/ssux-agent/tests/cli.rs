use std::process::Command;

#[test]
fn reports_version_and_rejects_session_commands() {
    let binary = env!("CARGO_BIN_EXE_ssux-agent");
    let version = Command::new(binary)
        .arg("--version")
        .output()
        .expect("run version command");
    assert!(version.status.success());
    assert_eq!(
        String::from_utf8_lossy(&version.stdout),
        concat!("ssux-agent ", env!("CARGO_PKG_VERSION"), "\n"),
    );
    let unsupported = Command::new(binary)
        .arg("serve")
        .output()
        .expect("run unsupported command");
    assert!(!unsupported.status.success());
    assert!(String::from_utf8_lossy(&unsupported.stderr).contains("Usage"));
}
