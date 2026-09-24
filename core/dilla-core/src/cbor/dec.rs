use super::{CborError, MAX_NESTING};

/// A strict, borrowing, position-tracking CBOR decoder.
///
/// Byte strings and text strings are returned as slices of the input, so decoding allocates
/// nothing. Every read that fails on a *type* leaves the position untouched, so a caller can
/// branch (that is how `try_null` is built); every read that fails on *well-formedness* leaves
/// the decoder unusable, which is fine because such an input is rejected outright.
pub struct Decoder<'a> {
    input: &'a [u8],
    pos: usize,
}

impl<'a> Decoder<'a> {
    pub fn new(input: &'a [u8]) -> Self {
        Self { input, pos: 0 }
    }

    pub fn position(&self) -> usize {
        self.pos
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], CborError> {
        let end = self.pos.checked_add(n).ok_or(CborError::Truncated)?;
        if end > self.input.len() {
            return Err(CborError::Truncated);
        }
        let s = &self.input[self.pos..end];
        self.pos = end;
        Ok(s)
    }

    /// Reads one head and returns `(major, argument)`.
    ///
    /// This is where every strictness rule lives: majors 1, 5 and 6 are refused outright, so are
    /// additional-information values 28..=31, floats and every simple value but 22, and an
    /// argument encoded in more bytes than it needs.
    fn head(&mut self) -> Result<(u8, u64), CborError> {
        let b = *self.input.get(self.pos).ok_or(CborError::Truncated)?;
        self.pos += 1;
        let major = b >> 5;
        let ai = b & 0x1f;

        if major == 7 {
            return match ai {
                22 => Ok((7, 22)), // null
                0..=21 | 23 => Err(CborError::SimpleForbidden(ai)),
                24 => Err(CborError::SimpleForbidden(self.take(1)?[0])),
                25..=27 => Err(CborError::FloatForbidden),
                other => Err(CborError::IndefiniteOrReserved(other)),
            };
        }
        if ai >= 28 {
            return Err(CborError::IndefiniteOrReserved(ai));
        }
        match major {
            1 => return Err(CborError::NegativeForbidden),
            5 => return Err(CborError::MapForbidden),
            6 => return Err(CborError::TagForbidden),
            _ => {}
        }

        let arg = match ai {
            0..=23 => u64::from(ai),
            24 => {
                let v = u64::from(self.take(1)?[0]);
                if v < 24 {
                    return Err(CborError::NonMinimalInt);
                }
                v
            }
            25 => {
                let mut a = [0u8; 2];
                a.copy_from_slice(self.take(2)?);
                let v = u64::from(u16::from_be_bytes(a));
                if v < 0x100 {
                    return Err(CborError::NonMinimalInt);
                }
                v
            }
            26 => {
                let mut a = [0u8; 4];
                a.copy_from_slice(self.take(4)?);
                let v = u64::from(u32::from_be_bytes(a));
                if v < 0x1_0000 {
                    return Err(CborError::NonMinimalInt);
                }
                v
            }
            _ => {
                let mut a = [0u8; 8];
                a.copy_from_slice(self.take(8)?);
                let v = u64::from_be_bytes(a);
                if v < 0x1_0000_0000 {
                    return Err(CborError::NonMinimalInt);
                }
                v
            }
        };
        Ok((major, arg))
    }

    /// Reads an array head and requires exactly `expected` elements.
    pub fn array(&mut self, expected: usize) -> Result<(), CborError> {
        let actual = self.array_len()?;
        if actual != expected {
            return Err(CborError::WrongArrayLen { expected, actual });
        }
        Ok(())
    }

    /// Reads an array head and returns its element count.
    ///
    /// The count is bounded by the input: every element costs at least one byte, so a head
    /// claiming more elements than there are bytes left is `Err(Truncated)` rather than an
    /// attacker-chosen `usize`. That keeps `Vec::with_capacity(d.array_len()?)` from turning
    /// nine bytes of ciphertext into an out-of-memory abort. The count is still *input-derived*:
    /// it bounds a pre-allocation only because it can never exceed the remaining input, so a
    /// caller must not scale it into a larger allocation.
    pub fn array_len(&mut self) -> Result<usize, CborError> {
        let at = self.pos;
        let (major, arg) = self.head()?;
        if major != 4 {
            self.pos = at;
            return Err(CborError::TypeMismatch {
                expected: "array",
                offset: at,
            });
        }
        if arg > (self.input.len() - self.pos) as u64 {
            return Err(CborError::Truncated);
        }
        usize::try_from(arg).map_err(|_| CborError::IntegerOverflow)
    }

    pub fn uint(&mut self) -> Result<u64, CborError> {
        let at = self.pos;
        let (major, arg) = self.head()?;
        if major != 0 {
            self.pos = at;
            return Err(CborError::TypeMismatch {
                expected: "uint",
                offset: at,
            });
        }
        Ok(arg)
    }

    pub fn bytes(&mut self) -> Result<&'a [u8], CborError> {
        let at = self.pos;
        let (major, arg) = self.head()?;
        if major != 2 {
            self.pos = at;
            return Err(CborError::TypeMismatch {
                expected: "bytes",
                offset: at,
            });
        }
        let n = usize::try_from(arg).map_err(|_| CborError::IntegerOverflow)?;
        self.take(n)
    }

    pub fn bytes_exact<const N: usize>(&mut self) -> Result<[u8; N], CborError> {
        let s = self.bytes()?;
        if s.len() != N {
            return Err(CborError::WrongByteLen {
                expected: N,
                actual: s.len(),
            });
        }
        let mut out = [0u8; N];
        out.copy_from_slice(s);
        Ok(out)
    }

    pub fn text(&mut self) -> Result<&'a str, CborError> {
        let at = self.pos;
        let (major, arg) = self.head()?;
        if major != 3 {
            self.pos = at;
            return Err(CborError::TypeMismatch {
                expected: "text",
                offset: at,
            });
        }
        let n = usize::try_from(arg).map_err(|_| CborError::IntegerOverflow)?;
        core::str::from_utf8(self.take(n)?).map_err(|_| CborError::InvalidUtf8)
    }

    pub fn null(&mut self) -> Result<(), CborError> {
        let at = self.pos;
        let (major, arg) = self.head()?;
        if major != 7 || arg != 22 {
            self.pos = at;
            return Err(CborError::TypeMismatch {
                expected: "null",
                offset: at,
            });
        }
        Ok(())
    }

    /// Consumes `0xf6` and returns true; otherwise consumes nothing and returns false.
    pub fn try_null(&mut self) -> Result<bool, CborError> {
        if self.input.get(self.pos) == Some(&0xf6) {
            self.pos += 1;
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn opt_bytes_exact<const N: usize>(&mut self) -> Result<Option<[u8; N]>, CborError> {
        if self.try_null()? {
            Ok(None)
        } else {
            Ok(Some(self.bytes_exact::<N>()?))
        }
    }

    pub fn opt_uint(&mut self) -> Result<Option<u64>, CborError> {
        if self.try_null()? {
            Ok(None)
        } else {
            Ok(Some(self.uint()?))
        }
    }

    /// Skips one complete item, enforcing every strictness rule on the way, and returns the bytes
    /// it consumed.
    pub fn skip(&mut self) -> Result<&'a [u8], CborError> {
        let start = self.pos;
        self.skip_inner(0)?;
        Ok(&self.input[start..self.pos])
    }

    fn skip_inner(&mut self, depth: usize) -> Result<(), CborError> {
        if depth > MAX_NESTING {
            return Err(CborError::TooDeep(MAX_NESTING));
        }
        let (major, arg) = self.head()?;
        match major {
            2 | 3 => {
                let n = usize::try_from(arg).map_err(|_| CborError::IntegerOverflow)?;
                let s = self.take(n)?;
                if major == 3 {
                    core::str::from_utf8(s).map_err(|_| CborError::InvalidUtf8)?;
                }
                Ok(())
            }
            4 => {
                let n = usize::try_from(arg).map_err(|_| CborError::IntegerOverflow)?;
                for _ in 0..n {
                    self.skip_inner(depth + 1)?;
                }
                Ok(())
            }
            // major 0 (uint) and major 7 arg 22 (null) carry no payload; every other major and
            // every other simple value already errored inside `head`.
            _ => Ok(()),
        }
    }

    /// `Err(TrailingBytes)` if anything remains after the top-level item.
    pub fn finish(self) -> Result<(), CborError> {
        if self.pos == self.input.len() {
            Ok(())
        } else {
            Err(CborError::TrailingBytes)
        }
    }
}

/// Decodes a whole buffer with trailing-byte rejection built in.
pub fn decode_strict<T>(
    input: &[u8],
    f: impl FnOnce(&mut Decoder<'_>) -> Result<T, CborError>,
) -> Result<T, CborError> {
    let mut d = Decoder::new(input);
    let value = f(&mut d)?;
    d.finish()?;
    Ok(value)
}
