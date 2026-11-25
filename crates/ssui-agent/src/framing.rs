use std::io::{Error, ErrorKind, Result};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

pub const MAX_FRAME_BYTES: usize = 1024 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct Frame {
    pub kind: u8,
    pub payload: Vec<u8>,
}

fn validate_length(length: usize) -> Result<()> {
    if !(1..=MAX_FRAME_BYTES).contains(&length) {
        return Err(Error::new(
            ErrorKind::InvalidData,
            "invalid IPC frame length",
        ));
    }
    Ok(())
}

fn validate_kind(kind: u8) -> Result<()> {
    if kind == 0 {
        return Err(Error::new(ErrorKind::InvalidData, "invalid IPC frame kind"));
    }
    Ok(())
}

/// EOF between frames is clean. EOF inside a frame is a protocol error.
pub async fn read_frame(reader: &mut (impl AsyncRead + Unpin)) -> Result<Option<Frame>> {
    let mut header = [0; 4];
    if reader.read(&mut header[..1]).await? == 0 {
        return Ok(None);
    }
    reader.read_exact(&mut header[1..]).await?;
    let length = u32::from_be_bytes(header) as usize;
    validate_length(length)?;
    let kind = reader.read_u8().await?;
    validate_kind(kind)?;
    let mut payload = vec![0; length - 1];
    reader.read_exact(&mut payload).await?;
    Ok(Some(Frame { kind, payload }))
}

/// Await the underlying transport so frames are subject to stream backpressure.
pub async fn write_frame(
    writer: &mut (impl AsyncWrite + Unpin),
    kind: u8,
    payload: &[u8],
) -> Result<()> {
    let length = payload.len().saturating_add(1);
    validate_length(length)?;
    validate_kind(kind)?;
    writer.write_u32(length as u32).await?;
    writer.write_u8(kind).await?;
    writer.write_all(payload).await
}
