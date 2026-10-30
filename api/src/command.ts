import { execFile } from "node:child_process";
export function command(
  file: string,
  args: string[],
  options: {
    cwd?: string;
    input?: Buffer | string;
    timeout?: number;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      file,
      args,
      {
        cwd: options.cwd,
        timeout: options.timeout ?? 120_000,
        maxBuffer: 256 * 1024 * 1024,
        env: options.env ?? process.env,
        encoding: "buffer",
      },
      (error, out, err) => {
        if (error) {
          console.error(
            "command failed",
            file,
            args[0],
            err.toString().slice(-1000),
          );
          reject(new Error(`${file} failed (${error.code ?? "unknown"})`));
        } else resolve(out);
      },
    );
    child.stdin?.end(options.input);
  });
}
