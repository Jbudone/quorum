import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

export interface SpawnLinesOptions {
  cwd?: string;
  stdin?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}

/** Spawns a CLI and yields each stdout line; throws with stderr tail on non-zero exit. */
export async function* spawnLines(
  cmd: string,
  args: string[],
  opts: SpawnLinesOptions = {},
): AsyncGenerator<string> {
  const child = spawn(cmd, args, {
    cwd: opts.cwd,
    env: opts.env ?? process.env,
    stdio: ["pipe", "pipe", "pipe"],
    signal: opts.signal,
  });
  let stderr = "";
  child.stderr.on("data", (d) => {
    stderr = (stderr + d).slice(-2000);
  });
  const exited = new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  exited.catch(() => {});
  child.stdin.end(opts.stdin ?? "");
  for await (const line of createInterface({ input: child.stdout })) yield line;
  const code = await exited;
  if (code !== 0) throw new Error(`${cmd} exited with ${code}: ${stderr.trim()}`);
}
