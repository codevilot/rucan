use serde::Serialize;
use vt100::{Color, MouseProtocolEncoding, MouseProtocolMode, Screen};

#[derive(Serialize, PartialEq, Eq)]
struct Style(u8, i32, i32);

// Packed colors keep indexed and RGB colors distinct on the wire.
fn pack(color: Color) -> i32 {
    match color {
        Color::Default => -1,
        Color::Idx(index) => i32::from(index),
        Color::Rgb(red, green, blue) => {
            256 + (i32::from(red) << 16) + (i32::from(green) << 8) + i32::from(blue)
        }
    }
}

#[derive(Serialize)]
struct Span(u16, String, Style);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Grid {
    pub rows: u16,
    pub cols: u16,
    lines: Vec<Vec<Span>>,
    cursor_hidden: bool,
    application_cursor: bool,
    application_keypad: bool,
    bracketed_paste: bool,
    mouse: &'static str,
    mouse_encoding: &'static str,
}

impl Grid {
    pub(crate) fn project(screen: &Screen) -> Self {
        let (rows, cols) = screen.size();
        let (rows, cols) = (rows.get(), cols.get());
        let mut lines = Vec::with_capacity(usize::from(rows));
        for row in 0..rows {
            let mut spans: Vec<Span> = Vec::new();
            for col in 0..cols {
                let Some(cell) = screen.cell(row, col) else {
                    break;
                };
                if cell.is_wide_continuation() {
                    continue;
                }
                let style = Style(
                    u8::from(cell.bold())
                        | (u8::from(cell.dim()) << 1)
                        | (u8::from(cell.italic()) << 2)
                        | (u8::from(cell.underline()) << 3)
                        | (u8::from(cell.inverse()) << 4),
                    pack(cell.fgcolor()),
                    pack(cell.bgcolor()),
                );
                let width = if cell.is_wide() { 2 } else { 1 };
                let text = cell.contents();
                let text = if text.is_empty() || text.chars().any(char::is_control) {
                    " "
                } else {
                    text
                };
                if let Some(Span(span_width, span_text, span_style)) = spans.last_mut()
                    && *span_style == style
                {
                    *span_width += width;
                    span_text.push_str(text);
                } else {
                    spans.push(Span(width, text.into(), style));
                }
            }
            // Default trailing blanks are restored by the compositor.
            if let Some(Span(width, text, Style(0, -1, -1))) = spans.last_mut() {
                let trimmed = text.trim_end_matches(' ').len();
                *width -= u16::try_from(text.len() - trimmed).unwrap_or(*width);
                text.truncate(trimmed);
                if *width == 0 {
                    spans.pop();
                }
            }
            lines.push(spans);
        }
        Self {
            rows,
            cols,
            lines,
            cursor_hidden: screen.hide_cursor(),
            application_cursor: screen.application_cursor(),
            application_keypad: screen.application_keypad(),
            bracketed_paste: screen.bracketed_paste(),
            mouse: match screen.mouse_protocol_mode() {
                MouseProtocolMode::None => "none",
                MouseProtocolMode::Press => "press",
                MouseProtocolMode::PressRelease => "press-release",
                MouseProtocolMode::ButtonMotion => "button-motion",
                MouseProtocolMode::AnyMotion => "any-motion",
            },
            mouse_encoding: match screen.mouse_protocol_encoding() {
                MouseProtocolEncoding::Default => "default",
                MouseProtocolEncoding::Utf8 => "utf8",
                MouseProtocolEncoding::Sgr => "sgr",
            },
        }
    }
}

/// Replies go back to the child PTY. Escape requests never reach the outer terminal.
pub(crate) struct TerminalReplies(pub crate::session::PtyInput);

impl TerminalReplies {
    fn send(&self, data: Vec<u8>) {
        if let Ok(input) = self.0.lock()
            && let Some(input) = input.as_ref()
        {
            let _ = input.try_send(data);
        }
    }
}

impl vt100::Callbacks for TerminalReplies {
    fn unhandled_csi(
        &mut self,
        screen: &mut Screen,
        i1: Option<u8>,
        i2: Option<u8>,
        params: &[&[u16]],
        action: char,
    ) {
        let first = params
            .first()
            .and_then(|group| group.first())
            .copied()
            .unwrap_or(0);
        if (i1, i2, action) == (Some(b'?'), Some(b'$'), 'p') {
            let enabled = match first {
                1 => Some(screen.application_cursor()),
                25 => Some(!screen.hide_cursor()),
                1049 => Some(screen.alternate_screen()),
                2004 => Some(screen.bracketed_paste()),
                _ => None,
            };
            let mode = enabled.map_or(0, |enabled| if enabled { 1 } else { 2 });
            self.send(format!("\x1b[?{first};{mode}$y").into_bytes());
            return;
        }
        if i2.is_some() {
            return;
        }
        let response = match (i1, first, action) {
            (None, 5, 'n') => "\x1b[0n".into(),
            (private @ (None | Some(b'?')), 6, 'n') => {
                let (row, column) = screen.cursor_position();
                let marker = if private.is_some() { "?" } else { "" };
                format!("\x1b[{marker}{};{}R", row + 1, column + 1)
            }
            (None, 0, 'c') => "\x1b[?1;2c".into(),
            (Some(b'>'), 0, 'c') => "\x1b[>0;0;0c".into(),
            (Some(b'?'), 0, 'u') => "\x1b[?0u".into(),
            _ => return,
        };
        self.send(response.into_bytes());
    }

    fn unhandled_osc(&mut self, _: &mut Screen, params: &[&[u8]]) {
        let response: &[u8] = match params {
            [b"10", b"?"] => b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
            [b"11", b"?"] => b"\x1b]11;rgb:0000/0000/0000\x1b\\",
            _ => return,
        };
        self.send(response.to_vec());
    }
}
