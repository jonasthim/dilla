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
    /// Drive the native peer of the browser web tests, one JSON request per stdin line.
    WebDriver {
        #[arg(long)]
        ds: String,
        #[arg(long, default_value_t = 0x5eed)]
        seed: u64,
    },
    /// The real-network voice probe (L-PROBE-1): `prepare` once, then `start` on each side's own
    /// machine right before its probe page presses Start.
    Netprobe {
        #[command(subcommand)]
        verb: Netprobe,
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
    /// Generate the committed registration fixture: one-leaf groups as an honest device registers
    /// them, and one tree that hides a leaf the member list cannot name.
    GenRegistrationGroups {
        #[arg(long, default_value_t = 4)]
        groups: usize,
        #[arg(long)]
        out: std::path::PathBuf,
        /// The 1,500-leaf fixture's seed, so the creator is that fixture's leaf 0.
        #[arg(long, default_value_t = 0x5eed)]
        seed: u64,
    },
    /// Generate the committed directory KeyPackage fixture: one honest KeyPackage per device.
    GenKeyPackages {
        #[arg(long, default_value_t = 16)]
        count: usize,
        #[arg(long)]
        out: std::path::PathBuf,
        /// Not the public-group fixture's 0x5eed: a device's id is derived from its seed, and the
        /// 1,500-leaf fixture's members take seeds 0x5eed + 1 .. 0x5eed + 1499, so a package set
        /// from the same seed would name devices that are already members of that group.
        #[arg(long, default_value_t = 0x00c0_ffee_0000)]
        seed: u64,
    },
}

#[derive(Subcommand)]
enum Netprobe {
    /// Sign up two throwaway accounts through an invite, open their DM and its call group, and
    /// write each side's device state to <out>/side-a/ and <out>/side-b/.
    Prepare {
        /// The instance's base URL, plain http:// (the probe page's dev server proxies a TLS one).
        #[arg(long)]
        instance: String,
        /// An invite code with two uses left.
        #[arg(long)]
        invite: String,
        #[arg(long)]
        out: std::path::PathBuf,
        /// The invite's id as `dillad admin invite create` logged it, printed in the cleanup lines.
        #[arg(long)]
        invite_id: Option<String>,
    },
    /// Load one side, sync its call group, start or join the DM's call and write the start JSON.
    /// The probe page must press Start within 30 s of this command.
    Start {
        #[arg(long)]
        instance: String,
        /// The side directory `prepare` wrote (side-a/ or side-b/).
        #[arg(long)]
        state: std::path::PathBuf,
        /// Where the start JSON goes.
        #[arg(long)]
        out: std::path::PathBuf,
    },
}

fn netprobe(verb: Netprobe) -> std::process::ExitCode {
    match verb {
        Netprobe::Prepare {
            instance,
            invite,
            out,
            invite_id,
        } => match dilla_testkit::netprobe_prepare(&instance, &invite, &out) {
            Ok(p) => {
                let id = invite_id.unwrap_or_else(|| "<invite id>".into());
                println!("account a: {}", p.names.0);
                println!("account b: {}", p.names.1);
                println!("call group {} at epoch {}", p.group_id, p.epoch);
                println!("side a: {}", p.side_a.display());
                println!("side b: {}", p.side_b.display());
                println!("cleanup, after the session:");
                println!("  dillad admin user delete --username={} --yes", p.names.0);
                println!("  dillad admin user delete --username={} --yes", p.names.1);
                println!("  dillad admin invite revoke --id={id}");
                println!(
                    "  rm -r {} {} (and every start JSON)",
                    p.side_a.display(),
                    p.side_b.display()
                );
                std::process::ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("netprobe prepare: {e}");
                std::process::ExitCode::FAILURE
            }
        },
        Netprobe::Start {
            instance,
            state,
            out,
        } => match dilla_testkit::netprobe_start(&instance, &state, &out) {
            Ok(v) => {
                println!(
                    "{} written (call {}, epoch {}): press Start on the probe page within 30 s",
                    out.display(),
                    v["callId"].as_str().unwrap_or(""),
                    v["keys"]["epoch"].as_str().unwrap_or("")
                );
                std::process::ExitCode::SUCCESS
            }
            Err(e) => {
                eprintln!("netprobe start: {e}");
                std::process::ExitCode::FAILURE
            }
        },
    }
}

fn main() -> std::process::ExitCode {
    let cli = Cli::parse();
    match cli.command {
        Command::Netprobe { verb } => netprobe(verb),
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
        Command::WebDriver { ds, seed } => {
            let mut driver = dilla_testkit::WebDriver::new(ds, seed);
            let stdin = std::io::stdin();
            let stdout = std::io::stdout();
            match driver.serve(stdin.lock(), stdout.lock()) {
                Ok(()) => std::process::ExitCode::SUCCESS,
                Err(e) => {
                    eprintln!("web-driver: {e}");
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
        Command::GenRegistrationGroups { groups, out, seed } => {
            match dilla_testkit::gen_registration_groups(&dilla_testkit::RegistrationSpec {
                out,
                seed,
                groups,
            }) {
                Ok(manifest) => {
                    println!(
                        "{} groups, not_after {}",
                        manifest.groups.len(),
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
        Command::GenKeyPackages { count, out, seed } => {
            match dilla_testkit::gen_key_packages(&dilla_testkit::KeyPackageSetSpec {
                count,
                out,
                seed,
            }) {
                Ok(manifest) => {
                    println!(
                        "{} key packages, not_after {}",
                        manifest.key_packages.len(),
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
