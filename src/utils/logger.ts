type LogContext = Record<string, unknown>;

export type LogLevel = "info" | "warn" | "error";

export type LogEntry = {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: LogContext;
};

const recentLogs: LogEntry[] = [];
const maxRecentLogs = 300;

function remember(entry: LogEntry): void {
  recentLogs.push(entry);
  if (recentLogs.length > maxRecentLogs) {
    recentLogs.splice(0, recentLogs.length - maxRecentLogs);
  }
}

function write(level: LogLevel, message: string, context?: LogContext): void {
  const timestamp = new Date().toISOString();
  remember({ timestamp, level, message, context });

  const payload = context ? ` ${JSON.stringify(context)}` : "";
  const line = `[${timestamp}] ${level.toUpperCase()} ${message}${payload}`;

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}

export const logger = {
  info: (message: string, context?: LogContext) => write("info", message, context),
  warn: (message: string, context?: LogContext) => write("warn", message, context),
  error: (message: string, context?: LogContext) => write("error", message, context),
};

export function getRecentLogs(input?: { level?: LogLevel | "all"; limit?: number }): LogEntry[] {
  const level = input?.level ?? "all";
  const limit = input?.limit ?? 20;
  const logs = level === "all" ? recentLogs : recentLogs.filter((entry) => entry.level === level);

  return logs.slice(-limit).reverse();
}
