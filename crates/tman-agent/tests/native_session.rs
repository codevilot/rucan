use portable_pty::{CommandBuilder, PtySize};
use std::time::{Duration, Instant};
use tman_agent::session::{NativeSession, Persistence, ProcessState};

async fn await_condition(mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(5);
    while !condition() {
        assert!(Instant::now() < deadline, "PTY condition timed out");
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

#[tokio::test]
async fn updates_policy_and_restores_alternate_screen_with_same_child() {
    let mut command = CommandBuilder::new("/bin/sh");
    command.args([
        "-c",
        "printf '\x1b[?1049hREADY\n'; IFS= read -r input; printf '\nreply:%s\n' \"$input\"; IFS= read -r next; printf '\x1b[?1049l'",
    ]);
    command.env("TERM", "xterm-256color");
    let session = NativeSession::spawn(
        command,
        PtySize {
            rows: 24,
            cols: 80,
            pixel_width: 0,
            pixel_height: 0,
        },
        100,
        Persistence::Temporary,
    )
    .expect("spawn a real PTY");
    let pid = session.pid().expect("PTY child PID");
    await_condition(|| {
        session.with_snapshot(|snapshot| snapshot.screen.contents().contains("READY"))
    })
    .await;
    assert!(session.with_snapshot(|snapshot| snapshot.screen.alternate_screen()));
    let sequence = session.with_snapshot(|snapshot| snapshot.sequence);

    session.set_persistence(Persistence::Persistent);
    assert_eq!(session.persistence(), Persistence::Persistent);
    session
        .write_input(b"hello\n")
        .expect("write to same child");
    await_condition(|| {
        session.with_snapshot(|snapshot| snapshot.screen.contents().contains("reply:hello"))
    })
    .await;
    session.with_snapshot(|snapshot| {
        assert!(snapshot.screen.alternate_screen());
        assert!(snapshot.sequence > sequence);
    });
    assert_eq!(session.pid(), Some(pid));

    session.set_persistence(Persistence::Temporary);
    assert_eq!(session.persistence(), Persistence::Temporary);
    session.write_input(b"exit\n").expect("finish child");
    await_condition(|| matches!(session.process_state(), ProcessState::Exited(_))).await;
    await_condition(|| !session.with_snapshot(|snapshot| snapshot.screen.alternate_screen())).await;
}
