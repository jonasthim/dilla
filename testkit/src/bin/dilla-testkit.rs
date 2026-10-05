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
        /// Run against the dillad instance at this base URL (`http://127.0.0.1:<port>`) instead
        /// of the in-memory stub. Overrides the scenario's own `ds <url>` line. A remote run reads
        /// the bootstrap invite code from DILLA_TESTKIT_INVITE and the test host's control
        /// listener from DILLA_TESTKIT_CONTROL.
        #[arg(long)]
        ds: Option<String>,
    },
    /// Check the committed protocol vectors and print the report.
    Vectors,
    /// Drive native MLS clients for the browser media tests, one JSON request per stdin line.
    MediaDriver {
        #[arg(long)]
        ds: String,
        #[arg(long, default_value_t = 0x5eed)]
        seed: u64,
    },
    /// Generate the committed PublicGroup benchmark fixture.
    GenPublicGroup {
        #[arg(long, default_value_t = 1500)]
        leaves: usize,
        #[arg(long)]
        out: std::path::PathBuf,
        #[arg(long, default_value_t = 0x5eed)]
        seed: u64,
    },
}

fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::MediaDriver { ds, seed } => {
            let mut driver = dilla_testkit::MediaDriver::new(ds, seed);
            let stdin = std::io::stdin();
            let stdout = std::io::stdout();
            match driver.serve(stdin.lock(), stdout.lock()) {
                Ok(()) => std::process::ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("media-driver: {e}");
                    std::process::ExitCode::FAILURE
                }
            }
        }
        Command::Run { path, seed, ds } => {
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
            let mut runner = Runner::new(seed).with_ds(ds);
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
        Command::GenPublicGroup { leaves, out, seed } => {
            match dilla_testkit::gen_public_group(&dilla_testkit::FixtureSpec { leaves, out, seed })
            {
                Ok(manifest) => {
                    println!(
                        "{} leaves, epoch {}, tree_hash {}, {} files, not_after {}",
                        manifest.leaves,
                        manifest.epoch,
                        manifest.tree_hash_hex,
                        manifest.files.len(),
                        manifest.not_after
                    );
                    std::process::ExitCode::SUCCESS
                }
                Err(e) => {
                    eprintln!("{e}");
                    std::process::ExitCode::FAILURE
                }
            }
        }
    }
}
