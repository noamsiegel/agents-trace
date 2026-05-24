export interface CommandResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  run(cmd: string, args: string[], opts?: { input?: string; cwd?: string }): Promise<CommandResult>;
}

export const realRunner: CommandRunner = {
  async run(cmd: string, args: string[], opts: { input?: string; cwd?: string } = {}): Promise<CommandResult> {
    const proc = Bun.spawn([cmd, ...args], {
      cwd: opts.cwd,
      stdin: opts.input === undefined ? 'ignore' : 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    });

    if (opts.input !== undefined) {
      proc.stdin?.write(opts.input);
      proc.stdin?.end();
    }

    const [stdout, stderr, status] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);

    return { status, stdout, stderr };
  },
};
