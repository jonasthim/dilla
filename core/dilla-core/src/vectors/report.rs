//! The report shape every target returns: native as a Rust value, wasm32-unknown-unknown as JSON
//! over wasm-bindgen, wasm32-wasip1 as the CBOR body of the `vectors_check` ABI response.

use crate::cbor::Encoder;

/// One checked field of one case.
#[derive(Clone, PartialEq, Eq, Debug)]
pub struct CaseReport {
    pub case: String,
    pub field: &'static str,
    pub ok: bool,
    pub expected: String,
    pub actual: String,
}

impl CaseReport {
    pub(crate) fn compare(
        case: impl Into<String>,
        field: &'static str,
        expected: impl Into<String>,
        actual: impl Into<String>,
    ) -> Self {
        let (expected, actual) = (expected.into(), actual.into());
        Self {
            case: case.into(),
            field,
            ok: expected == actual,
            expected,
            actual,
        }
    }
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct SuiteReport {
    pub name: &'static str,
    pub cases: Vec<CaseReport>,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub struct VectorReport {
    pub suites: Vec<SuiteReport>,
    pub passed: u32,
    pub failed: u32,
}

impl VectorReport {
    pub(crate) fn from_suites(suites: Vec<SuiteReport>) -> Self {
        let mut passed = 0u32;
        let mut failed = 0u32;
        for suite in &suites {
            for case in &suite.cases {
                if case.ok {
                    passed += 1;
                } else {
                    failed += 1;
                }
            }
        }
        Self {
            suites,
            passed,
            failed,
        }
    }

    pub fn is_ok(&self) -> bool {
        self.failed == 0
    }

    pub fn to_text(&self) -> String {
        let mut out = String::new();
        for suite in &self.suites {
            let failed = suite.cases.iter().filter(|c| !c.ok).count();
            out.push_str(&format!(
                "{}: {} case(s), {} failed\n",
                suite.name,
                suite.cases.len(),
                failed
            ));
            for case in suite.cases.iter().filter(|c| !c.ok) {
                out.push_str(&format!(
                    "  FAIL {} {}: expected {} got {}\n",
                    case.case, case.field, case.expected, case.actual
                ));
            }
        }
        out.push_str(&format!("passed {} failed {}\n", self.passed, self.failed));
        out
    }

    /// `[passed, failed, [[suite_name, [[case, field, ok, expected, actual], ...]], ...]]`,
    /// with `ok` as 0 or 1. This is the body of the wasi `vectors_check` response.
    pub fn encode(&self) -> Vec<u8> {
        let mut e = Encoder::with_capacity(4096);
        e.array(3)
            .uint(u64::from(self.passed))
            .uint(u64::from(self.failed));
        e.array(self.suites.len());
        for suite in &self.suites {
            e.array(2).text(suite.name);
            e.array(suite.cases.len());
            for case in &suite.cases {
                e.array(5)
                    .text(&case.case)
                    .text(case.field)
                    .uint(u64::from(case.ok))
                    .text(&case.expected)
                    .text(&case.actual);
            }
        }
        e.into_vec()
    }
}
