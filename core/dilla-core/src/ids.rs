//! The six 16-byte identifiers of protocol/00-overview.md.
//!
//! Every one is a CBOR byte string on the wire and lowercase hex without a prefix in JSON and in
//! the vector files. They are distinct types on purpose: passing a `ChannelId` where a `UserId`
//! belongs is the single easiest way to build a group nobody can join.

use crate::error::ProtocolError;

macro_rules! id16 {
    ($($(#[$meta:meta])* $name:ident),* $(,)?) => {$(
        $(#[$meta])*
        #[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
        pub struct $name(pub [u8; 16]);

        impl $name {
            pub const fn from_bytes(b: [u8; 16]) -> Self {
                Self(b)
            }

            pub const fn as_bytes(&self) -> &[u8; 16] {
                &self.0
            }

            /// Parses exactly 32 lowercase hex digits. Uppercase is rejected: the protocol
            /// documents and the vectors are lowercase without a prefix, and accepting both
            /// spellings would make two different strings name the same identifier.
            pub fn from_hex(s: &str) -> Result<Self, ProtocolError> {
                if s.len() != 32 {
                    return Err(ProtocolError::Credential);
                }
                let mut out = [0u8; 16];
                for (i, byte) in out.iter_mut().enumerate() {
                    let pair = &s[2 * i..2 * i + 2];
                    if pair.bytes().any(|c| !matches!(c, b'0'..=b'9' | b'a'..=b'f')) {
                        return Err(ProtocolError::Credential);
                    }
                    *byte = u8::from_str_radix(pair, 16).map_err(|_| ProtocolError::Credential)?;
                }
                Ok(Self(out))
            }

            /// Lowercase, no prefix.
            pub fn to_hex(&self) -> String {
                let mut s = String::with_capacity(32);
                for b in self.0 {
                    s.push(char::from_digit(u32::from(b >> 4), 16).expect("nibble"));
                    s.push(char::from_digit(u32::from(b & 0x0f), 16).expect("nibble"));
                }
                s
            }
        }
    )*};
}

id16! {
    /// The instance (server) this group belongs to.
    InstanceId,
    /// A community. `null` in a DM, group DM, pairing or interaction group.
    CommunityId,
    /// A text or voice channel.
    ChannelId,
    /// A member.
    UserId,
    /// One device of one member. This is what a leaf is bound to.
    DeviceId,
    /// A message, chosen by the sender; edits, deletes and reactions reference it.
    MsgId,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips_for_every_id_type() {
        let raw = [
            0x00, 0x11, 0x22, 0x33, 0x44, 0x55, 0x66, 0x77, 0x88, 0x99, 0xaa, 0xbb, 0xcc, 0xdd,
            0xee, 0xff,
        ];
        let expect = "00112233445566778899aabbccddeeff";
        assert_eq!(InstanceId::from_bytes(raw).to_hex(), expect);
        assert_eq!(CommunityId::from_bytes(raw).to_hex(), expect);
        assert_eq!(ChannelId::from_bytes(raw).to_hex(), expect);
        assert_eq!(UserId::from_bytes(raw).to_hex(), expect);
        assert_eq!(DeviceId::from_bytes(raw).to_hex(), expect);
        assert_eq!(MsgId::from_bytes(raw).to_hex(), expect);

        assert_eq!(
            InstanceId::from_hex(expect).unwrap(),
            InstanceId::from_bytes(raw)
        );
        assert_eq!(UserId::from_hex(expect).unwrap(), UserId::from_bytes(raw));
        assert_eq!(MsgId::from_hex(expect).unwrap().as_bytes(), &raw);
    }

    #[test]
    fn from_hex_rejects_bad_input() {
        assert!(UserId::from_hex("00112233445566778899aabbccddee").is_err()); // 15 bytes
        assert!(UserId::from_hex("00112233445566778899aabbccddeeffaa").is_err()); // 17 bytes
        assert!(UserId::from_hex("00112233445566778899aabbccddeegg").is_err()); // not hex
        assert!(UserId::from_hex("00112233445566778899AABBCCDDEEFF").is_err()); // uppercase
    }
}
