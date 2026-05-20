type Level = "debug" | "info" | "warn" | "error";

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  constructor(private level: Level = "info") {}

  private log(at: Level, args: unknown[]): void {
    if (order[at] < order[this.level]) return;
    const ts = new Date().toISOString();
    const tag = at.toUpperCase().padEnd(5);
    const stream = at === "error" || at === "warn" ? process.stderr : process.stdout;
    stream.write(`[${ts}] ${tag} ${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ")}\n`);
  }

  debug(...a: unknown[]): void { this.log("debug", a); }
  info(...a: unknown[]): void { this.log("info", a); }
  warn(...a: unknown[]): void { this.log("warn", a); }
  error(...a: unknown[]): void { this.log("error", a); }
}

export const createLogger = (level: Level = "info"): Logger => new Logger(level);
