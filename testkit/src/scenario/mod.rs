//! A line-oriented scenario language. UTF-8, LF, `.scn`. Blank lines and lines whose first
//! non-space character is `#` are ignored. The last argument of `send` and `expect_decrypts` is
//! the rest of the line after the group name, trimmed, so bodies may contain spaces.

mod parse;
mod run;

pub use parse::{ParseError, Scenario, Stmt, parse};
pub use run::{RunReport, Runner, StepResult};
