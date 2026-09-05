// src/workers/reconciliation.ts
import { Job, Queue } from 'bull';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { reconcilePendingPayments, expireOldPayments } from '../services/payment';
import { releaseExpiredReservations } from '../services/purchase';
import { processPendingNotifications } from '../services/notification';

/**
 * Inicializa os workers de reconciliação na fila.
 * @param queue Fila Bull de reconciliação
 */
export async function startReconciliationWorkers(queue: Queue): Promise<void> {
  // Processa jobs do tipo 'reconcile_payments'
  queue.process('reconcile_payments', async (job: Job) => {
    logger.info('Iniciando job: reconcile_payments');
    try {
      await reconcilePendingPayments();
      await expireOldPayments();
      logger.info('Job reconcile_payments concluído');
    } catch (error) {
      logger.error('Erro no job reconcile_payments', error);
      throw error; // permite retry
    }
  });

  // Processa jobs do tipo 'release_expired_reservations'
  queue.process('release_expired_reservations', async (job: Job) => {
    logger.info('Iniciando job: release_expired_reservations');
    try {
      await releaseExpiredReservations();
      logger.info('Job release_expired_reservations concluído');
    } catch (error) {
      logger.error('Erro no job release_expired_reservations', error);
      throw error;
    }
  });

  // Processa jobs do tipo 'process_pending_notifications'
  queue.process('process_pending_notifications', async (job: Job) => {
    logger.info('Iniciando job: process_pending_notifications');
    try {
      await processPendingNotifications();
      logger.info('Job process_pending_notifications concluído');
    } catch (error) {
      logger.error('Erro no job process_pending_notifications', error);
      throw error;
    }
  });

  // Tratamento de eventos (opcional)
  queue.on('completed', (job: Job) => {
    logger.info(`Job ${job.id} concluído com sucesso`);
  });

  queue.on('failed', (job: Job, error: Error) => {
    logger.error(`Job ${job.id} falhou: ${error.message}`);
  });

  logger.info('Workers de reconciliação registrados');
}
