use rucan_agent::framing::{Frame, read_frame, write_frame};

fn hex_bytes(hex: &str) -> Vec<u8> {
    if hex == "-" {
        return Vec::new();
    }
    assert!(hex.len().is_multiple_of(2));
    (0..hex.len())
        .step_by(2)
        .map(|offset| u8::from_str_radix(&hex[offset..offset + 2], 16).expect("valid hex"))
        .collect()
}

#[tokio::test]
async fn matches_the_shared_wire_vectors() {
    let vectors = include_str!("../../../packages/protocol/framing-vectors.txt");
    for line in vectors.lines().filter(|line| !line.starts_with('#')) {
        let fields: Vec<_> = line.split_whitespace().collect();
        let kind = fields[0].parse().expect("frame kind");
        let payload = hex_bytes(fields[1]);
        let expected = hex_bytes(fields[2]);
        let mut output = Vec::new();
        write_frame(&mut output, kind, &payload)
            .await
            .expect("encode frame");
        assert_eq!(output, expected);
        let mut input = output.as_slice();
        assert_eq!(
            read_frame(&mut input).await.expect("decode frame"),
            Some(Frame { kind, payload })
        );
        assert_eq!(read_frame(&mut input).await.expect("clean EOF"), None);
    }
}

#[tokio::test]
async fn rejects_invalid_frames() {
    for hex in ["00000000", "00100001", "0000000100", "0000000201", "0000"] {
        let data = hex_bytes(hex);
        assert!(read_frame(&mut data.as_slice()).await.is_err());
    }
}
