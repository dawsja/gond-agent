//! Bounded subprocess I/O shared by workspace tooling; cancellation also kills descendants.
use std::process::Stdio;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;

use super::ToolCtx;

pub async fn capture(ctx: &ToolCtx, mut command: Command, input: Vec<u8>, max: usize, timeout: u64) -> Result<Vec<u8>, String> {
    command.current_dir(&ctx.cwd).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true);
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command.spawn().map_err(|_| "Could not start workspace tooling. Rebuild the worker image with its required dependencies.".to_owned())?;
    let group = ProcessGroup(child.id());
    let mut stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let work = async {
        let write = async move {
            stdin.write_all(&input).await?;
            // Closing the pipe delivers EOF. shutdown() alone need not close a child pipe.
            drop(stdin);
            Ok::<_, std::io::Error>(())
        };
        let read = async {
            let mut bytes = Vec::new();
            stdout.take(max as u64 + 1).read_to_end(&mut bytes).await?;
            Ok::<_, std::io::Error>(bytes)
        };
        let (_, bytes) = tokio::try_join!(write, read).map_err(|_| "Workspace tool I/O failed".to_owned())?;
        if bytes.len() > max { return Err("Workspace tool output exceeded its limit; narrow the request".to_owned()); }
        let status = child.wait().await.map_err(|_| "Workspace tool did not exit cleanly".to_owned())?;
        if !status.success() { return Err("Workspace tool failed. Check the tool input and worker dependencies.".to_owned()); }
        Ok(bytes)
    };
    let result = tokio::select! {
        r = work => r,
        _ = ctx.cancel.cancelled() => Err("interrupted".into()),
        _ = tokio::time::sleep(Duration::from_secs(timeout)) => Err("Workspace tool timed out".into()),
    };
    drop(group);
    result
}

struct ProcessGroup(Option<u32>);
impl Drop for ProcessGroup {
    fn drop(&mut self) {
        #[cfg(unix)]
        if let Some(pid) = self.0.and_then(|pid| libc::pid_t::try_from(pid).ok()).filter(|pid| *pid > 1) {
            // SAFETY: this child owns a process group; a negative pid targets only its descendants.
            unsafe { libc::kill(-pid, libc::SIGKILL); }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn delivers_stdin_eof_bounds_output_and_cancels() {
        let dir = tempfile::tempdir().unwrap();
        let (ctx, _rx) = crate::tools::testutil::ctx(dir.path());
        let cmd = Command::new("cat");
        assert_eq!(capture(&ctx, cmd, b"hello".to_vec(), 100, 2).await.unwrap(), b"hello");
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "printf 123456789"]);
        assert!(capture(&ctx, cmd, vec![], 4, 2).await.unwrap_err().contains("limit"));
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "exit 7"]);
        assert!(capture(&ctx, cmd, vec![], 100, 2).await.is_err());
        let mut cmd = Command::new("sh");
        cmd.args(["-c", "sleep 30"]);
        ctx.cancel.cancel();
        assert_eq!(capture(&ctx, cmd, vec![], 100, 2).await.unwrap_err(), "interrupted");
    }
}
