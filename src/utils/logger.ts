// src/utils/logger.ts
import pino from 'pino';
import pretty from 'pino-pretty';

const isProduction = process.env.NODE_ENV === 'production';
const logLevel = process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug');

// Em desenvolvimento, usa pino-pretty para logs legíveis
const stream = isProduction
  ? undefined // em produção, usa saída padrão JSON
  : pretty({
      colorize: true,
      translateTime: 'SYS:dd/mm/yyyy HH:MM:ss',
      ignore: 'pid,hostname',
    });

export const logger = pino(
  {
    level: logLevel,
    base: { service: 'larizinha-store' },
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  stream
);

// Helper para logs com contexto
export function createLogger(context: string) {
  return logger.child({ context });
}

// Exemplo de uso:
// import { logger } from './utils/logger';
// logger.info('Mensagem', { data: 'valor' });
