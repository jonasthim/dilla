use super::head_len;

/// A deterministic CBOR encoder for fixed-position arrays.
///
/// Every method is chainable and infallible: the caller decides the array lengths, so there is
/// nothing to validate here. Shortest-form integers and definite lengths are structural.
#[derive(Clone, Debug, Default)]
pub struct Encoder {
    buf: Vec<u8>,
}

impl Encoder {
    pub fn new() -> Self {
        Self { buf: Vec::new() }
    }

    pub fn with_capacity(n: usize) -> Self {
        Self {
            buf: Vec::with_capacity(n),
        }
    }

    fn head(&mut self, major: u8, arg: u64) {
        let m = major << 5;
        match head_len(arg) {
            1 => self.buf.push(m | arg as u8),
            2 => {
                self.buf.push(m | 24);
                self.buf.push(arg as u8);
            }
            3 => {
                self.buf.push(m | 25);
                self.buf.extend_from_slice(&(arg as u16).to_be_bytes());
            }
            5 => {
                self.buf.push(m | 26);
                self.buf.extend_from_slice(&(arg as u32).to_be_bytes());
            }
            _ => {
                self.buf.push(m | 27);
                self.buf.extend_from_slice(&arg.to_be_bytes());
            }
        }
    }

    /// Writes an array head of `len` elements. The elements follow as separate calls.
    pub fn array(&mut self, len: usize) -> &mut Self {
        self.head(4, len as u64);
        self
    }

    pub fn uint(&mut self, v: u64) -> &mut Self {
        self.head(0, v);
        self
    }

    pub fn bytes(&mut self, v: &[u8]) -> &mut Self {
        self.head(2, v.len() as u64);
        self.buf.extend_from_slice(v);
        self
    }

    pub fn text(&mut self, v: &str) -> &mut Self {
        self.head(3, v.len() as u64);
        self.buf.extend_from_slice(v.as_bytes());
        self
    }

    pub fn null(&mut self) -> &mut Self {
        self.buf.push(0xf6);
        self
    }

    pub fn opt_bytes(&mut self, v: Option<&[u8]>) -> &mut Self {
        match v {
            Some(b) => self.bytes(b),
            None => self.null(),
        }
    }

    pub fn opt_uint(&mut self, v: Option<u64>) -> &mut Self {
        match v {
            Some(n) => self.uint(n),
            None => self.null(),
        }
    }

    /// Splices an already-encoded sub-item in verbatim. Used where a nested structure has its own
    /// `encode()` (a `dilla_binding` inside an ABI response, an envelope inside an archive chunk).
    pub fn raw(&mut self, already_encoded: &[u8]) -> &mut Self {
        self.buf.extend_from_slice(already_encoded);
        self
    }

    pub fn as_slice(&self) -> &[u8] {
        &self.buf
    }

    pub fn into_vec(self) -> Vec<u8> {
        self.buf
    }
}
