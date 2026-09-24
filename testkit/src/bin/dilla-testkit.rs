use clap::{Parser, Subcommand};
use dilla_testkit::{Runner, parse};

#[derive(Parser)]
#[command(
    name = "dilla-testkit",
    about = "dilla's headless multi-client harness"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Run one scenario file.
    Run {
        path: std::path::PathBuf,
        /// Fixes every client's identity material and MLS signature keypair, so a failing
        /// scenario replays with the same structure. The OpenMLS provider still draws its HPKE
        /// keys, leaf secrets and nonces from the OS RNG, so the bytes on the wire differ run to
        /// run: reproduction is structural, not byte-for-byte.
        #[arg(long, default_value_t = 0x5eed)]
        seed: u64,
    },
    /// Check the committed protocol vectors and print the report.
    Vectors,
}

fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Run { path, seed } => {
            let src = match std::fs::read_to_string(&path) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{}: {e}", path.display());
                    return std::process::ExitCode::from(2);
                }
            };
            let name = path
                .file_name()
                .map(|s| s.to_string_lossy().into_owned())
                .unwrap_or_default();
            let scenario = match parse(&src, &name) {
                Ok(s) => s,
                Err(e) => {
                    eprintln!("{}:{}: {}", path.display(), e.line, e.message);
                    return std::process::ExitCode::from(2);
                }
            };
            let mut runner = Runner::new(seed);
            match runner.run(&scenario) {
                Ok(report) => {
                    print!("{}", report.to_text());
                    if report.is_ok() {
                        std::process::ExitCode::SUCCESS
                    } else {
                        std::process::ExitCode::FAILURE
                    }
                }
                Err(e) => {
                    eprintln!("{e}");
                    std::process::ExitCode::FAILURE
                }
            }
        }
        Command::Vectors => {
            let report = dilla_core::vectors::run_all();
            print!("{}", report.to_text());
            if report.is_ok() {
                std::process::ExitCode::SUCCESS
            } else {
                std::process::ExitCode::FAILURE
            }
        }
    }
}
