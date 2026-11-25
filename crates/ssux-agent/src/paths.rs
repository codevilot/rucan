use std::path::PathBuf;

pub(crate) fn resolve_path(value: &str) -> Result<PathBuf, String> {
    if value == "~" || value.starts_with("~/") {
        let home = std::env::var_os("HOME").ok_or("HOME is unavailable")?;
        let home = PathBuf::from(home);
        return Ok(value.strip_prefix("~/").map_or(home.clone(), |suffix| {
            home.join(suffix.trim_start_matches('/'))
        }));
    }
    let path = PathBuf::from(value);
    if path.is_absolute() {
        Ok(path)
    } else {
        Err("path must be absolute or start with ~".into())
    }
}
