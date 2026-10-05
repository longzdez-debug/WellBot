type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

class Logger {
  private level(): LogLevel {
    const configured = String(process.env.LOG_LEVEL || '').trim().toLowerCase();
    if (configured === 'debug' || configured === 'info' || configured === 'warn' || configured === 'error') {
      return configured;
    }
    return process.env.DEBUG === 'true' ? 'debug' : 'info';
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVELS[level] >= LOG_LEVELS[this.level()];
  }

  private formatMessage(level: LogLevel, message: string, context?: Record<string, any>): string {
    const timestamp = new Date().toISOString();
    const contextStr = context ? ` ${JSON.stringify(context)}` : '';
    return `[${timestamp}] [${level.toUpperCase()}] ${message}${contextStr}`;
  }

  info(message: string, context?: Record<string, any>): void {
    if (this.shouldLog('info')) console.log(this.formatMessage('info', message, context));
  }

  warn(message: string, context?: Record<string, any>): void {
    if (this.shouldLog('warn')) console.warn(this.formatMessage('warn', message, context));
  }

  error(message: string, context?: Record<string, any>): void {
    if (this.shouldLog('error')) console.error(this.formatMessage('error', message, context));
  }

  debug(message: string, context?: Record<string, any>): void {
    if (this.shouldLog('debug')) console.debug(this.formatMessage('debug', message, context));
  }
}

export const logger = new Logger();
