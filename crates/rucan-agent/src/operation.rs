// Generated from packages/protocol/control.schema.json by scripts/generate-control.mjs.

use serde::Deserialize;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct Request {
    pub id: u32,
    pub operation: Operation,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "kebab-case", tag = "type")]
pub(crate) enum Operation {
    List,
    Shutdown {
        force: bool,
    },
    Rename {
        session: String,
        name: String,
    },
    Scroll {
        session: String,
        offset: usize,
    },
    TmuxList,
    TmuxOpen {
        target: Option<String>,
        name: String,
        cwd: String,
        rows: u16,
        cols: u16,
    },
    WorkspaceCwd {
        session: String,
    },
    FsList {
        path: String,
        exclusions: Vec<String>,
    },
    FsPreview {
        path: String,
    },
    Create {
        command: String,
        args: Vec<String>,
        cwd: String,
        name: String,
        rows: u16,
        cols: u16,
        persistent: bool,
        scrollback: Option<usize>,
    },
    Attach {
        session: String,
    },
    Detach {
        session: String,
        force: Option<bool>,
    },
    Snapshot {
        session: String,
    },
    Watch {
        session: String,
        after: u64,
    },
    Pin {
        session: String,
        persistent: bool,
    },
    Resize {
        session: String,
        rows: u16,
        cols: u16,
    },
    Kill {
        session: String,
    },
}
