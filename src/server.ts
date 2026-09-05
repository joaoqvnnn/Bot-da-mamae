// src/server.ts
import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import Bull from 'bull';
import { Telegraf } from 'telegraf';
import pino from 'pino';
import cron from 'node-cron';

// Importações de módulos internos (a implementar)
import { setupTelegramBot } from './bots/telegram/setup';
import { setupWebhooks } from './webhooks/setup';
import { setupQueues } from './queues/setup';
import { startReconciliationWorkers } from './workers/reconciliation';
import { initializeMaintenanceCheck } from './services/maintenance';
import { startScheduledBroadcasts } from './services/scheduledBroadcasts';
import { logger } from './utils/logger';

// Inicialização do Prisma
export const prisma = new PrismaClient();

// Inicialização do Redis (usado também pelas filas Bull)
export const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
  password: process.env.REDIS_PASSWORD || undefined,
  maxRetriesPerRequest: null, // necessário para Bull
});

// Inicialização do Express
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Inicialização do servidor HTTP
const httpServer = createServer(app);

// Configuração padrão das filas Bull (usando a instância Redis já criada)
const queueDefaultOptions = {
  redis: redis, // usa a mesma conexão ioredis configurada com REDIS_URL
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: true,   // remove jobs concluídos para evitar acúmulo
    removeOnFail: false,      // mantém jobs falhos para investigação
  },
};

// Inicialização das filas
export const notificationQueue = new Bull('notifications', queueDefaultOptions);
export const reconciliationQueue = new Bull('reconciliation', queueDefaultOptions);

// Função principal de inicialização
async function main() {
  logger.info('🚀 Iniciando Larizinha Store...');

  // Conectar banco de dados
  try {
    await prisma.$connect();
    logger.info('✅ Banco de dados conectado');
  } catch (error) {
    logger.fatal('❌ Falha ao conectar no banco de dados', error);
    process.exit(1);
  }

  // Verificar Redis
  try {
    await redis.ping();
    logger.info('✅ Redis conectado');
  } catch (error) {
    logger.fatal('❌ Falha ao conectar no Redis', error);
    process.exit(1);
  }

  // Configurar bot do Telegram
  const telegramToken = process.env.BOT_MODE === 'test'
    ? process.env.TELEGRAM_BOT_TOKEN_TEST || process.env.TELEGRAM_BOT_TOKEN
    : process.env.TELEGRAM_BOT_TOKEN;

  if (!telegramToken) {
    logger.error('❌ Token do Telegram não configurado. Definir TELEGRAM_BOT_TOKEN no .env');
  } else {
    const bot = new Telegraf(telegramToken);
    await setupTelegramBot(bot);
    logger.info('✅ Bot do Telegram inicializado');
  }

  // Configurar webhooks
  setupWebhooks(app);
  logger.info('✅ Webhooks configurados');

  // Configurar filas e workers
  setupQueues(notificationQueue, reconciliationQueue);
  await startReconciliationWorkers(reconciliationQueue);
  logger.info('✅ Filas e workers iniciados');

  // Iniciar servidor HTTP
  const port = parseInt(process.env.PORT || '3000', 10);
  httpServer.listen(port, () => {
    logger.info(`🌐 Servidor HTTP ouvindo na porta ${port}`);
  });

  // Inicializar manutenção e agendamentos
  await initializeMaintenanceCheck();
  logger.info('✅ Verificação de manutenção configurada');

  await startScheduledBroadcasts();
  logger.info('✅ Agendador de broadcasts iniciado');

  // Tarefas periódicas de reconciliação (com deduplicação via jobId fixo)
  cron.schedule('* * * * *', async () => {
    try {
      // Job para reconciliar pagamentos
      await reconciliationQueue.add(
        { type: 'reconcile_payments' },
        { jobId: 'cron-reconcile-payments', removeOnComplete: true }
      );

      // Job para liberar reservas expiradas
      await reconciliationQueue.add(
        { type: 'release_expired_reservations' },
        { jobId: 'cron-release-reservations', removeOnComplete: true }
      );

      // Job para processar notificações pendentes
      await reconciliationQueue.add(
        { type: 'process_pending_notifications' },
        { jobId: 'cron-process-notifications', removeOnComplete: true }
      );
    } catch (err) {
      logger.error('Erro ao adicionar jobs de reconciliação', err);
    }
  });

  logger.info('✅ Sistema iniciado com sucesso');
}

// Encerramento gracioso
async function shutdown() {
  logger.info('⏳ Encerrando aplicação...');
  try {
    await prisma.$disconnect();
    await redis.quit();
    await notificationQueue.close();
    await reconciliationQueue.close();
    httpServer.close(() => {
      logger.info('✅ Servidor HTTP fechado');
      process.exit(0);
    });
  } catch (err) {
    logger.error('Erro durante shutdown', err);
    process.exit(1);
  }
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Iniciar
main().catch((err) => {
  logger.fatal('Erro fatal na inicialização', err);
  process.exit(1);
});
