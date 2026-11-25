use crate::paths::resolve_path;
use serde::Serialize;
use std::fs::{self, OpenOptions};
use std::io::Read;
use std::os::unix::fs::OpenOptionsExt;
use std::path::PathBuf;

const MAX_ENTRIES: usize = 500;
const MAX_SCANNED: usize = 3000;
const MAX_PREVIEW: usize = 64 * 1024;

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum EntryKind {
    Directory,
    File,
    Symlink,
    Other,
}

#[derive(Serialize)]
struct Entry {
    name: String,
    kind: EntryKind,
}

#[derive(Serialize)]
pub(crate) struct Listing {
    path: String,
    entries: Vec<Entry>,
    truncated: bool,
}

#[derive(Serialize)]
pub(crate) struct Preview {
    text: String,
    truncated: bool,
    binary: bool,
}

fn path(value: &str) -> Result<PathBuf, String> {
    if value.len() > 4096 || value.contains('\0') {
        return Err("invalid filesystem path".into());
    }
    resolve_path(value)
}

pub(crate) fn list(value: &str, exclusions: &[String]) -> Result<Listing, String> {
    let path = path(value)?;
    if exclusions.len() > 64 || exclusions.iter().any(|name| name.len() > 255) {
        return Err("too many or oversized explorer exclusions".into());
    }
    if !fs::symlink_metadata(&path)
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err("explorer path is not a directory".into());
    }
    let iter = fs::read_dir(&path).map_err(|error| error.to_string())?;
    let mut entries = Vec::new();
    let mut truncated = false;
    for (index, item) in iter.enumerate() {
        if index == MAX_SCANNED || entries.len() == MAX_ENTRIES {
            truncated = true;
            break;
        }
        let item = item.map_err(|error| error.to_string())?;
        let Ok(name) = item.file_name().into_string() else {
            continue;
        };
        if exclusions.contains(&name) {
            continue;
        }
        let kind = match item.file_type() {
            Ok(kind) if kind.is_dir() => EntryKind::Directory,
            Ok(kind) if kind.is_file() => EntryKind::File,
            Ok(kind) if kind.is_symlink() => EntryKind::Symlink,
            Ok(_) => EntryKind::Other,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        };
        entries.push(Entry { name, kind });
    }
    entries.sort_unstable_by(|left, right| {
        matches!(right.kind, EntryKind::Directory)
            .cmp(&matches!(left.kind, EntryKind::Directory))
            .then_with(|| left.name.cmp(&right.name))
    });
    let path = path
        .into_os_string()
        .into_string()
        .map_err(|_| "path is not valid UTF-8")?;
    Ok(Listing {
        path,
        entries,
        truncated,
    })
}

pub(crate) fn preview(value: &str) -> Result<Preview, String> {
    let path = path(value)?;
    if !fs::symlink_metadata(&path)
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("preview requires a regular file".into());
    }
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(nix::libc::O_NOFOLLOW | nix::libc::O_NONBLOCK)
        .open(path)
        .map_err(|error| error.to_string())?;
    if !file
        .metadata()
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("preview requires a regular file".into());
    }
    let mut content = Vec::new();
    file.take((MAX_PREVIEW + 1) as u64)
        .read_to_end(&mut content)
        .map_err(|error| error.to_string())?;
    let truncated = content.len() > MAX_PREVIEW;
    content.truncate(MAX_PREVIEW);
    let text = if content.contains(&0) {
        None
    } else {
        match std::str::from_utf8(&content) {
            Ok(text) => Some(text),
            Err(error) if truncated && error.error_len().is_none() => {
                std::str::from_utf8(&content[..error.valid_up_to()]).ok()
            }
            Err(_) => None,
        }
    };
    Ok(Preview {
        text: text.unwrap_or_default().into(),
        truncated,
        binary: text.is_none(),
    })
}
