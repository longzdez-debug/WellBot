type LogLevel = 'info' | 'warn' | 'error' | 'debug';

type LogContext = Record<string, unknown>;

function serializeContext(context: LogContext | undefined): string {
  if (!context) return '';
  try {
    return ` ${JSON.stringify(context, (_key, value: unknown) => {
      if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
      if (typeof value === 'bigint') return value.toString();
      return value;
    })}`;
  } catch {
    return ' {"contextSerializationError":true}';
  }
}

class Logger {
  private formatMessage(level: LogLevel, message: string, context?: LogContext): string {
    const timestamp = new Date().toISOString();
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${serializeContext(context)}`;
  }
  info(message: string, context?: LogContext): void { console.log(this.formatMessage('info', message, context)); }
  warn(message: string, context?: LogContext): void { console.warn(this.formatMessage('warn', message, context)); }
  error(message: string, context?: LogContext): void { console.error(this.formatMessage('error', message, context)); }
  debug(message: string, context?: LogContext): void { if (process.env.DEBUG === 'true') console.debug(this.formatMessage('debug', message, context)); }
}

export const logger = new Logger();
