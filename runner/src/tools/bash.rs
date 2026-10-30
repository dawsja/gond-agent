#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

use futures::future::BoxFuture;
use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, BufReader};
use tokio::process::Command;

use super::{Tool, ToolCtx, ToolOutput, clip, schema, str_arg};
use crate::permissions::Access;

const DEFAULT_TIMEOUT: u64 = 120_000;
const MAX_TIMEOUT: u64 = 600_000;
const MAX_OUTPUT: usize = 30_000;
/// Output streamed to the transcript per command; past it only the end is kept (a `yes`-style command
/// mustn't fill memory or the event stream).
const MAX_STREAM: usize = 256 * 1024;

pub struct Bash;

/// The command that runs `cmd` in this platform's shell, with stderr merged into stdout so output keeps
/// its real interleaving. Unix: bash (or sh) in its own process group. Windows: PowerShell (`pwsh` when
/// installed, else the built-in Windows PowerShell) with UTF-8 output and no console window.
fn shell_command(cmd: &str) -> Command {
    #[cfg(unix)]
    {
        let sh = if std::path::Path::new("/bin/bash").exists() { "/bin/bash" } else { "/bin/sh" };
        let mut c = Command::new(sh);
        c.arg("-c").arg(format!("exec 2>&1\n{cmd}")).process_group(0);
        c.env("GOND_AGENT", "1").env_remove("GOND_AGENT_TOKEN");
        c
    }
    #[cfg(windows)]
    {
        let mut c = Command::new(powershell());
        c.args(["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]).arg(windows_script(cmd));
        // CREATE_NO_WINDOW: no console flashes up for each command.
        c.creation_flags(0x0800_0000);
        c.env("GOND_AGENT", "1").env_remove("GOND_AGENT_TOKEN");
        c
    }
}

/// The PowerShell around a command: UTF-8 in and out, no progress bars, errors as plain text in the
/// output, and the exit code of the last program that ran (or 1 if a PowerShell command failed).
#[cfg(any(windows, test))]
fn windows_script(cmd: &str) -> String {
    format!(
        "$ProgressPreference = 'SilentlyContinue'\n\
         [Console]::OutputEncoding = [Text.Encoding]::UTF8\n\
         $OutputEncoding = [Text.Encoding]::UTF8\n\
         $global:LASTEXITCODE = 0\n\
         $failed = $false\n\
         & {{\n{cmd}\n}} 2>&1 | ForEach-Object {{ if ($_ -is [System.Management.Automation.ErrorRecord]) {{ $failed = $true; $_.ToString() }} else {{ $_ }} }} | Out-String -Stream -Width 4096\n\
         if ($LASTEXITCODE) {{ exit $LASTEXITCODE }} elseif ($failed) {{ exit 1 }}"
    )
}

/// `pwsh` (PowerShell 7) when it's on PATH, else Windows PowerShell, which every Windows has.
#[cfg(windows)]
fn powershell() -> &'static str {
    static FOUND: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    FOUND.get_or_init(|| {
        let on_path = std::env::var_os("PATH").is_some_and(|p| std::env::split_paths(&p).any(|d| d.join("pwsh.exe").is_file()));
        if on_path { "pwsh" } else { "powershell" }
    })
}

/// What the model is told about the shell tool on this platform.
#[cfg(not(windows))]
const DESCRIPTION: &str = "Run a shell command in the working directory and return its combined stdout/stderr and exit code. Each call is a fresh shell; use absolute paths or `cd dir && cmd`. Default timeout 2 minutes (max 10). Set run_in_background for long-running processes.";
#[cfg(windows)]
const DESCRIPTION: &str = "Run a PowerShell command in the working directory (this is Windows: the shell is PowerShell, not bash) and return its combined output and exit code. Write PowerShell: `Get-ChildItem`, `Select-String`, `Get-Content`, `Remove-Item -Recurse -Force`, `$env:NAME = 'x'`; join commands with `;` (or `&&` in PowerShell 7). For a cmd.exe-only command use `cmd /c \"...\"`. Each call is a fresh shell. Default timeout 2 minutes (max 10). Set run_in_background for long-running processes.";

impl Tool for Bash {
    fn name(&self) -> &'static str {
        "bash"
    }
    fn description(&self) -> &'static str {
        DESCRIPTION
    }
    fn schema(&self) -> Value {
        schema(
            json!({
                "command": {"type": "string"},
                "timeout_ms": {"type": "integer", "description": "Timeout in milliseconds (max 600000)"},
                "run_in_background": {"type": "boolean", "description": "Start it and return a shell id right away (dev servers, watchers); read output with bash_output"}
            }),
            &["command"],
        )
    }
    fn access(&self) -> Access {
        Access::Exec
    }
    fn title(&self, input: &Value) -> String {
        str_arg(input, "command").unwrap_or("?").to_owned()
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let Some(cmd) = str_arg(&input, "command") else { return ToolOutput::err("command is required") };
            if input.get("run_in_background").and_then(Value::as_bool).unwrap_or(false) {
                return start_background(ctx, cmd);
            }
            let timeout = input.get("timeout_ms").and_then(Value::as_u64).unwrap_or(DEFAULT_TIMEOUT).min(MAX_TIMEOUT);
            let started = Instant::now();
            let mut child = match shell_command(cmd)
                .current_dir(&ctx.cwd)
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
            {
                Ok(c) => c,
                Err(e) => return ToolOutput::err(format!("failed to start shell: {e}")),
            };
            let mut stdout = BufReader::new(child.stdout.take().expect("piped stdout"));
            let mut collected = Output::default();
            let mut buf = [0u8; 8192];
            let deadline = tokio::time::sleep(Duration::from_millis(timeout));
            tokio::pin!(deadline);
            let mut outcome: Option<String> = None;
            loop {
                tokio::select! {
                    n = stdout.read(&mut buf) => match n {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            if collected.total < MAX_STREAM {
                                ctx.output(String::from_utf8_lossy(&buf[..n]).into_owned());
                            } else if collected.total - n < MAX_STREAM {
                                ctx.output("\n… (more output; the end shows when the command finishes)\n".into());
                            }
                            collected.push(&buf[..n]);
                        }
                    },
                    _ = &mut deadline => { outcome = Some(format!("timed out after {}s", timeout / 1000)); break; }
                    _ = ctx.cancel.cancelled() => { outcome = Some("interrupted".into()); break; }
                }
            }
            let status = if outcome.is_some() {
                kill_group(&child);
                // A moment to exit cleanly, then everything in the group is killed.
                tokio::time::sleep(Duration::from_millis(300)).await;
                if let Some(pid) = child.id() {
                    kill_group_now(pid);
                }
                let _ = child.kill().await;
                None
            } else {
                child.wait().await.ok()
            };
            let secs = started.elapsed().as_secs_f64();
            let raw = collected.text();
            let out = clip(raw.trim_end(), MAX_OUTPUT);
            let code = status.and_then(|s| s.code());
            let (ok, summary) = match (&outcome, code) {
                (Some(why), _) => (false, why.clone()),
                (None, Some(0)) => (true, format!("{secs:.1}s")),
                (None, Some(c)) => (false, format!("exit {c} · {secs:.1}s")),
                (None, None) => (false, "killed by signal".to_owned()),
            };
            let mut model_text = if out.is_empty() { "(no output)".to_owned() } else { out.clone() };
            match (&outcome, code) {
                (Some(why), _) => model_text.push_str(&format!("\n[{why}]")),
                (None, Some(c)) if c != 0 => model_text.push_str(&format!("\n[exit code {c}]")),
                _ => {}
            }
            ToolOutput { ok, content: vec![crate::api::wire::ResultPart::Text { text: model_text }], summary, display: out, diff: None }
        })
    }
}

/// A command's output, keeping the start and the end (MAX_OUTPUT each) and counting what's between.
#[derive(Default)]
struct Output {
    head: Vec<u8>,
    tail: VecDeque<u8>,
    total: usize,
}

impl Output {
    fn push(&mut self, mut b: &[u8]) {
        self.total += b.len();
        let room = MAX_OUTPUT.saturating_sub(self.head.len());
        let take = room.min(b.len());
        self.head.extend_from_slice(&b[..take]);
        b = &b[take..];
        self.tail.extend(b);
        if self.tail.len() > MAX_OUTPUT {
            self.tail.drain(..self.tail.len() - MAX_OUTPUT);
        }
    }

    fn text(&self) -> String {
        let mut bytes = self.head.clone();
        let omitted = self.total - self.head.len() - self.tail.len();
        if omitted > 0 {
            bytes.extend_from_slice(format!("\n… {} KB omitted …\n", omitted / 1024).as_bytes());
        }
        bytes.extend(self.tail.iter());
        String::from_utf8_lossy(&bytes).into_owned()
    }
}

const BG_BUFFER: usize = 1 << 20;
/// Background shell ids are never reused, so a stopped shell's id can't point at a new one.
static NEXT_SHELL: AtomicU64 = AtomicU64::new(1);

/// The last BG_BUFFER bytes of a background shell's output; `start` is the offset of the first one kept.
#[derive(Default)]
struct Ring {
    buf: VecDeque<u8>,
    start: usize,
}

/// A process started with run_in_background. Killed when dropped (Gond Agent exiting).
pub struct BgShell {
    pub command: String,
    output: std::sync::Arc<std::sync::Mutex<Ring>>,
    /// Offset of the output read so far.
    read: usize,
    status: std::sync::Arc<std::sync::Mutex<Option<String>>>,
    pid: Option<u32>,
    kill: Option<tokio::sync::oneshot::Sender<()>>,
}

impl Drop for BgShell {
    fn drop(&mut self) {
        if let Some(k) = self.kill.take() {
            let _ = k.send(());
        }
        if let (Some(pid), None) = (self.pid, self.status.lock().unwrap().as_ref()) {
            term_group(pid);
        }
    }
}

fn start_background(ctx: &ToolCtx, cmd: &str) -> ToolOutput {
    let mut child = match shell_command(cmd)
        .current_dir(&ctx.cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
    {
        Ok(c) => c,
        Err(e) => return ToolOutput::err(format!("failed to start shell: {e}")),
    };
    let output = std::sync::Arc::new(std::sync::Mutex::new(Ring::default()));
    let status = std::sync::Arc::new(std::sync::Mutex::new(None::<String>));
    let (ktx, krx) = tokio::sync::oneshot::channel::<()>();
    let pid = child.id();
    let (out, st) = (output.clone(), status.clone());
    let mut stdout = child.stdout.take().expect("piped stdout");
    tokio::spawn(async move {
        let mut buf = [0u8; 8192];
        tokio::pin!(krx);
        loop {
            tokio::select! {
                n = stdout.read(&mut buf) => match n {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        let mut o = out.lock().unwrap();
                        o.buf.extend(&buf[..n]);
                        if o.buf.len() > BG_BUFFER {
                            let cut = o.buf.len() - BG_BUFFER;
                            o.buf.drain(..cut);
                            o.start += cut;
                        }
                    }
                },
                _ = &mut krx => {
                    kill_group(&child);
                    let _ = child.kill().await;
                    *st.lock().unwrap() = Some("killed".into());
                    return;
                }
            }
        }
        let code = child.wait().await.ok().and_then(|s| s.code());
        *st.lock().unwrap() = Some(match code {
            Some(c) => format!("exited with code {c}"),
            None => "killed by signal".into(),
        });
    });
    let mut shells = ctx.shells.lock().unwrap();
    let id = format!("bg-{}", NEXT_SHELL.fetch_add(1, Ordering::Relaxed));
    shells.insert(id.clone(), BgShell { command: cmd.to_owned(), output, read: 0, status, pid, kill: Some(ktx) });
    ToolOutput::ok(
        format!("Started background shell {id}. Read its output with bash_output {{\"shell_id\": \"{id}\"}}; stop it with kill_shell."),
        format!("background · {id}"),
    )
}

pub struct BashOutput;

impl Tool for BashOutput {
    fn name(&self) -> &'static str {
        "bash_output"
    }
    fn description(&self) -> &'static str {
        "Read new output from a background shell since the last read, plus whether it is still running."
    }
    fn schema(&self) -> Value {
        schema(json!({"shell_id": {"type": "string"}}), &["shell_id"])
    }
    fn access(&self) -> Access {
        Access::Read
    }
    fn title(&self, input: &Value) -> String {
        str_arg(input, "shell_id").unwrap_or("?").to_owned()
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let id = str_arg(&input, "shell_id").unwrap_or("");
            let mut shells = ctx.shells.lock().unwrap();
            let Some(sh) = shells.get_mut(id) else {
                let known: Vec<_> = shells.keys().cloned().collect();
                return ToolOutput::err(format!("no background shell `{id}` (running: {})", if known.is_empty() { "none".into() } else { known.join(", ") }));
            };
            let out = sh.output.lock().unwrap();
            let skipped = out.start.saturating_sub(sh.read);
            let from = sh.read.max(out.start) - out.start;
            let bytes: Vec<u8> = out.buf.iter().skip(from).copied().collect();
            let total = out.start + out.buf.len();
            drop(out);
            sh.read = total;
            let mut new = String::from_utf8_lossy(&bytes).into_owned();
            if skipped > 0 {
                new = format!("… {} KB of earlier output dropped …\n{new}", skipped / 1024);
            }
            let state = sh.status.lock().unwrap().clone().unwrap_or_else(|| "running".into());
            let body = clip(new.trim_end(), MAX_OUTPUT);
            let text = format!("[{id}: {state}] {}\n{}", sh.command, if body.is_empty() { "(no new output)" } else { &body });
            let mut o = ToolOutput::ok(text, format!("{state} · {} new lines", body.lines().count()));
            o.display = body;
            o
        })
    }
}

pub struct KillShell;

impl Tool for KillShell {
    fn name(&self) -> &'static str {
        "kill_shell"
    }
    fn description(&self) -> &'static str {
        "Stop a background shell."
    }
    fn schema(&self) -> Value {
        schema(json!({"shell_id": {"type": "string"}}), &["shell_id"])
    }
    fn access(&self) -> Access {
        Access::Internal
    }
    fn title(&self, input: &Value) -> String {
        str_arg(input, "shell_id").unwrap_or("?").to_owned()
    }
    fn run<'a>(&'a self, ctx: &'a ToolCtx, input: Value) -> BoxFuture<'a, ToolOutput> {
        Box::pin(async move {
            let id = str_arg(&input, "shell_id").unwrap_or("");
            match ctx.shells.lock().unwrap().remove(id) {
                Some(sh) => {
                    drop(sh); // Drop sends the kill
                    ToolOutput::ok(format!("stopped {id}"), "stopped")
                }
                None => ToolOutput::err(format!("no background shell `{id}`")),
            }
        })
    }
}

fn kill_group(child: &tokio::process::Child) {
    if let Some(pid) = child.id() {
        term_group(pid);
    }
}

/// SIGKILL to the shell's whole group, for what ignored SIGTERM (Windows: `taskkill /F` already did it).
#[cfg(unix)]
fn kill_group_now(pid: u32) {
    if let Ok(pid @ 2..) = libc::pid_t::try_from(pid) {
        // SAFETY: as in term_group.
        unsafe { libc::kill(-pid, libc::SIGKILL) };
    }
}
#[cfg(not(unix))]
fn kill_group_now(_: u32) {}

/// SIGTERM to the process group a shell was started in (`process_group(0)`, so the group id is its pid).
/// The system call, never the `kill` program: procps-ng 4.0 reads `kill -TERM -12345` as
/// `kill -TERM -1`, which signals every process the person owns.
#[cfg(unix)]
fn term_group(pid: u32) {
    // 0 and 1 would mean "my own group" and "everything": never a shell we started.
    if let Ok(pid @ 2..) = libc::pid_t::try_from(pid) {
        // SAFETY: kill(2) takes two integers and touches no memory.
        unsafe { libc::kill(-pid, libc::SIGTERM) };
    }
}
/// Windows: end the shell and everything it started (`taskkill /T`), so a dev server or test runner
/// doesn't outlive its command.
#[cfg(windows)]
fn term_group(pid: u32) {
    let _ = std::process::Command::new("taskkill")
        .args(["/T", "/F", "/PID", &pid.to_string()])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .creation_flags(0x0800_0000)
        .status();
}
#[cfg(not(any(unix, windows)))]
fn term_group(_: u32) {}

#[cfg(test)]
mod tests {
    use super::*;
    #[cfg(unix)]
    use crate::agent::events::AgentEvent;
    use crate::tools::testutil::{ctx, text};

    #[test]
    fn windows_script_wraps_the_command() {
        let s = windows_script("npm test; Get-ChildItem");
        assert!(s.contains("& {\nnpm test; Get-ChildItem\n} 2>&1"));
        assert!(s.contains("[Console]::OutputEncoding = [Text.Encoding]::UTF8"));
        assert!(s.ends_with("if ($LASTEXITCODE) { exit $LASTEXITCODE } elseif ($failed) { exit 1 }"));
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn runs_and_reports_exit_codes() {
        let dir = tempfile::tempdir().unwrap();
        let (c, mut rx) = ctx(dir.path());
        let ok = Bash.run(&c, json!({"command":"echo hi; echo err >&2"})).await;
        assert!(ok.ok);
        assert_eq!(ok.display, "hi\nerr");
        assert!(rx.try_recv().is_ok(), "streams output chunks");

        let fail = Bash.run(&c, json!({"command":"echo nope; exit 3"})).await;
        assert!(!fail.ok && fail.summary.starts_with("exit 3"));
        assert!(text(&fail).ends_with("[exit code 3]"));

        let slow = Bash.run(&c, json!({"command":"sleep 5","timeout_ms":200})).await;
        assert!(!slow.ok && slow.summary == "timed out after 0s");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn background_shells() {
        let dir = tempfile::tempdir().unwrap();
        let (c, _rx) = ctx(dir.path());
        let start = Bash.run(&c, json!({"command":"echo one; sleep 0.2; echo two; sleep 30","run_in_background":true})).await;
        let first = start.summary.strip_prefix("background · ").unwrap().to_owned();
        assert!(start.ok && first.starts_with("bg-"));
        tokio::time::sleep(std::time::Duration::from_millis(80)).await;
        let id = |s: &str| json!({ "shell_id": s });
        let a = BashOutput.run(&c, id(&first)).await;
        assert!(text(&a).contains("running") && a.display == "one", "{}", text(&a));
        tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        let b = BashOutput.run(&c, id(&first)).await;
        assert_eq!(b.display, "two", "only new output");
        // Stopping one shell stops only that shell: another one keeps running, and ids aren't reused.
        let second = Bash.run(&c, json!({"command":"sleep 30","run_in_background":true})).await;
        let second = second.summary.strip_prefix("background · ").unwrap().to_owned();
        assert!(KillShell.run(&c, id(&first)).await.ok);
        assert!(!BashOutput.run(&c, id(&first)).await.ok);
        let third = Bash.run(&c, json!({"command":"sleep 30","run_in_background":true})).await;
        assert!(!third.summary.ends_with(&second) && !third.summary.ends_with(&first), "{}", third.summary);
        tokio::time::sleep(std::time::Duration::from_millis(150)).await;
        assert!(text(&BashOutput.run(&c, id(&second)).await).contains("running"), "an unrelated shell survives");
        assert!(KillShell.run(&c, id(&second)).await.ok);
        c.shells.lock().unwrap().clear();
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn endless_output_keeps_the_start_and_the_end() {
        let dir = tempfile::tempdir().unwrap();
        let (c, mut rx) = ctx(dir.path());
        let r = Bash.run(&c, json!({"command":"echo first; head -c 5000000 /dev/zero | tr '\\0' y; echo; echo last"})).await;
        assert!(r.ok);
        let t = text(&r);
        assert!(t.starts_with("first") && t.trim_end().ends_with("last") && t.contains("omitted"), "{}", &t[..80]);
        let mut streamed = 0;
        while let Ok(AgentEvent::ToolOutput { chunk, .. }) = rx.try_recv() {
            streamed += chunk.len();
        }
        assert!(streamed < MAX_STREAM + 64 * 1024, "{streamed}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn background_output_keeps_reading_after_the_buffer_trims() {
        let dir = tempfile::tempdir().unwrap();
        let (c, _rx) = ctx(dir.path());
        let cmd = "echo start; sleep 0.3; head -c 1500000 /dev/zero | tr '\\0' a; echo; echo END; sleep 1; echo again";
        let r = Bash.run(&c, json!({"command": cmd, "run_in_background": true})).await;
        let id = json!({ "shell_id": r.summary.strip_prefix("background · ").unwrap() });
        tokio::time::sleep(Duration::from_millis(150)).await;
        assert_eq!(BashOutput.run(&c, id.clone()).await.display, "start");
        tokio::time::sleep(Duration::from_millis(500)).await;
        let t = text(&BashOutput.run(&c, id.clone()).await);
        assert!(t.contains("earlier output dropped") && t.trim_end().ends_with("END"), "{}", &t[..120]);
        tokio::time::sleep(Duration::from_millis(1000)).await;
        assert_eq!(BashOutput.run(&c, id).await.display, "again", "new output after the buffer filled");
        c.shells.lock().unwrap().clear();
    }

    #[cfg(windows)]
    #[tokio::test]
    async fn runs_powershell_and_cmd_on_windows() {
        let dir = tempfile::tempdir().unwrap();
        let (c, _rx) = ctx(dir.path());
        let ok = Bash.run(&c, json!({"command":"Write-Output 'héllo'; cmd /c \"echo from cmd\""})).await;
        assert!(ok.ok, "{}", text(&ok));
        assert!(ok.display.contains("héllo") && ok.display.contains("from cmd"), "{}", ok.display);
        let fail = Bash.run(&c, json!({"command":"cmd /c exit 3"})).await;
        assert!(!fail.ok && fail.summary.starts_with("exit 3"), "{}", fail.summary);
        let missing = Bash.run(&c, json!({"command":"Get-Item does-not-exist"})).await;
        assert!(!missing.ok && missing.display.contains("does-not-exist"), "{}", missing.display);
        let slow = Bash.run(&c, json!({"command":"Start-Sleep 5","timeout_ms":500})).await;
        assert!(!slow.ok && slow.summary == "timed out after 0s");
    }
}
