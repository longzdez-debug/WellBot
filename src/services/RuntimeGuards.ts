import { logger } from '../utils/logger';

let shuttingDown = false;

/**
 * Installs process-level guards for failures that happen outside the main async
 * startup chain. These failures must be visible in production and must terminate
 * the process so Docker/systemd can restart a potentially inconsistent worker.
 */
export function installRuntimeGuards(): void {
  process.on('unhandledRejection', (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    const stack = reason instanceof Error ? reason.stack : undefined;
    logger.error('Unhandled promise rejection', { error: message, stack });
    process.exitCode = 1;
  });

  process.on('uncaughtException', (error: Error) => {
    logger.error('Uncaught exception; terminating process', {
      error: error.message,
      stack: error.stack,
    });
    if (!shuttingDown) {
      shuttingDown = true;
      process.exitCode = 1;
      setImmediate(() => process.exit(1));
    }
  });
}
