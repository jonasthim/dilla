#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_controls_and_rejects_extra_fields_or_bad_values() {
        assert_eq!(parse_control(br#"{"op":"pause"}"#).unwrap(), Control::Pause);
        assert_eq!(
            parse_control(br#"{"op":"seek","position_ms":3}"#).unwrap(),
            Control::Seek { position_ms: 3 }
        );
        for input in [
            br#"{"op":"pause","extra":1}"#.as_slice(),
            br#"{"op":"volume","value":101}"#,
            br#"{"op":"seek"}"#,
            br#"{"op":"pause"} {}"#,
            br#"{"op":"skip"}"#,
        ] {
            assert!(parse_control(input).is_err(), "accepted {input:?}");
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Control {
    Pause,
    Resume,
    Stop,
    Seek { position_ms: u32 },
    Volume { value: u8 },
}

pub fn parse_control(line: &[u8]) -> Result<Control, &'static str> {
    if line.is_empty() || line.len() > 4096 {
        return Err("invalid control");
    }
    #[derive(serde::Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Wire {
        op: String,
        #[serde(default)]
        position_ms: Option<u32>,
        #[serde(default)]
        value: Option<u8>,
    }
    let wire: Wire = serde_json::from_slice(line).map_err(|_| "invalid control")?;
    let value: serde_json::Value = serde_json::from_slice(line).map_err(|_| "invalid control")?;
    let object = value.as_object().ok_or("invalid control")?;
    match (wire.op.as_str(), wire.position_ms, wire.value) {
        ("pause", None, None) if object.len() == 1 => Ok(Control::Pause),
        ("resume", None, None) if object.len() == 1 => Ok(Control::Resume),
        ("stop", None, None) if object.len() == 1 => Ok(Control::Stop),
        ("seek", Some(position_ms), None)
            if object.len() == 2 && object.get("position_ms").is_some_and(|v| v.is_u64()) =>
        {
            Ok(Control::Seek { position_ms })
        }
        ("volume", None, Some(value))
            if value <= 100
                && object.len() == 2
                && object.get("value").is_some_and(|v| v.is_u64()) =>
        {
            Ok(Control::Volume { value })
        }
        _ => Err("invalid control"),
    }
}
