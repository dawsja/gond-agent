import { execFile } from "node:child_process";
import { basename } from "node:path";
import { ClassifiedRetryFailure, classifyRetryFailure } from "./retry";

// Never use a caller-supplied executable path or argument as a diagnostic label.
const executableLabel = (file: string) => {
  const name = basename(file);
  return ["git", "gh", "tar", "node", "docker"].includes(name) ? name : "command";
};

// gh --include emits response headers on stdout, including on nonzero exits.
function responseMetadata(out: Buffer) {
  let output = out.toString("utf8", 0, Math.min(out.length, 64 * 1024));
  let response: { status?: number; headers?: { "retry-after": string | undefined } } = {};
  while (/^HTTP\/\d(?:\.\d)?\s+\d{3}\b/.test(output)) {
    const boundary = /\r?\n\r?\n/.exec(output);
    if (!boundary) break;
    const head = output.slice(0, boundary.index);
    response = {
      status: Number(head.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})/)![1]),
      headers: { "retry-after": head.match(/^retry-after:[ \t]*([^\r\n]*)/im)?.[1] },
    };
    output = output.slice(boundary.index + boundary[0].length);
  }
  return response;
}
export function command(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    input?: Buffer | string;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
    maxBuffer?: number;
    onStderr?: (text: string) => void;
  } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout ?? 120_000,
        maxBuffer: options.maxBuffer ?? 256 * 1024 * 1024,
        env: options.env ?? process.env,
        encoding: "buffer",
      },
      (error, out, err) => {
        if (error) {
          const failure = new ClassifiedRetryFailure(classifyRetryFailure({
            message: error.message,
            code: error.code,
            stderr: err,
            stdout: out,
            ...responseMetadata(out),
            timedOut: error.killed === true && error.signal === "SIGTERM" && error.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER",
          }));
          const operation = executableLabel(file);
          // Preserve the fixed max-buffer marker consumed by archive size handling.
          const code = typeof error.code === "number" ? error.code : error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ? error.code : "unknown";
          failure.message = `${operation} failed (${code}): ${failure.reason}`;
          console.error("command failed", { operation, class: failure.class, reason: failure.reason });
          reject(failure);
        } else resolve(out);
      },
    );
    if (options.onStderr) child.stderr?.on("data", (chunk: Buffer) => options.onStderr!(chunk.toString()));
    child.stdin?.end(options.input);
  });
}
