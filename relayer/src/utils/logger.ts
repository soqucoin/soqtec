/**
 * SOQ-TEC Logger
 * 
 * Structured logging with Winston.
 * Format matches the terminal dashboard aesthetic.
 */

import winston from 'winston';

const terminalFormat = winston.format.printf(({ level, message, timestamp }) => {
  const levelColors: Record<string, string> = {
    error: '\x1b[31m',  // red
    warn:  '\x1b[33m',  // yellow
    info:  '\x1b[32m',  // green (Pip-Boy green)
    debug: '\x1b[90m',  // dim
  };
  const color = levelColors[level] || '\x1b[37m';
  const reset = '\x1b[0m';
  const ts = new Date(timestamp as string).toISOString().slice(11, 19);
  return `${color}[${ts}] [${level.toUpperCase().padEnd(5)}]${reset} ${message}`;
});

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || 'info',
  format: winston.format.combine(
    winston.format.timestamp(),
    terminalFormat,
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: 'logs/relayer.log',
      maxsize: 10 * 1024 * 1024, // 10MB
      maxFiles: 5,
    }),
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
      maxsize: 10 * 1024 * 1024,
      maxFiles: 3,
    }),
  ],
});
