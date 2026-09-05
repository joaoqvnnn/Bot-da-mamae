// src/services/maintenance.ts
import { prisma } from '../database/prisma';
import { getSettings, updateMaintenance } from '../config/settings';
import { logger } from '../utils/logger';
import { Telegraf } from 'telegraf';

// Função chamada na inicialização para verificar estado de manutenção e notificar administradores
export async function initializeMaintenanceCheck() {
  const settings = await getSettings();

  if (settings.maintenance.isActive) {
    logger.warn('🔧 Sistema está em modo manutenção');
  }

  // Aqui pode-se configurar workers para notificar usuários quando manutenção terminar,
  // mas por enquanto apenas registra o estado.
}

// Verifica se o bot está em manutenção
export async function isMaintenanceActive(): Promise<boolean> {
  const settings = await getSettings();
  return settings.maintenance.isActive;
}

// Obtém a mensagem de manutenção
export async function getMaintenanceMessage(): Promise<string> {
  const settings = await getSettings();
  return settings.maintenance.message;
}

// Obtém a mensagem de aviso de bot online novamente
export async function getOnlineMessage(): Promise<string> {
  const settings = await getSettings();
  return settings.maintenance.onlineMessage;
}

// Ativa o modo manutenção
export async function activateMaintenance(message?: string, onlineMessage?: string) {
  await updateMaintenance(true, message, onlineMessage);
  logger.info('Manutenção ativada');
}

// Desativa o modo manutenção
export async function deactivateMaintenance(message?: string, onlineMessage?: string) {
  await updateMaintenance(false, message, onlineMessage);
  logger.info('Manutenção desativada');
}

// Função middleware para o bot: verifica se o usuário pode usar o bot.
// Se manutenção ativa e usuário não é admin, bloqueia.
export async function checkMaintenanceMiddleware(ctx: any, next: () => Promise<void>) {
  const settings = await getSettings();

  if (!settings.maintenance.isActive) {
    return next();
  }

  const userId = ctx.from?.id;
  const isAdmin = settings.adminIds.includes(userId) || userId === settings.ownerId;

  if (isAdmin) {
    return next();
  }

  // Usuário não-admin durante manutenção
  await ctx.reply(settings.maintenance.message);
  return;
}

// Função para notificar todos os usuários que o bot voltou online (pode ser agendada ou chamada na desativação)
export async function notifyUsersOnline(bot: Telegraf) {
  const settings = await getSettings();
  const message = settings.maintenance.onlineMessage;

  // Aqui poderia buscar todos os usuários ativos e enviar a mensagem.
  // Para evitar flood, pode ser feito via fila de notificações.
  // Exemplo simplificado (não recomendado em produção sem fila):
  // const users = await prisma.user.findMany({ where: { status: 'ACTIVE' } });
  // for (const user of users) {
  //   try {
  //     await bot.telegram.sendMessage(user.telegramId, message);
  //   } catch (error) {
  //     logger.error(`Falha ao notificar usuário ${user.telegramId}`, error);
  //   }
  // }

  // Em vez disso, registra um log e delega para fila de notificações
  logger.info(`Notificação de bot online agendada para todos os usuários: ${message}`);
  // Exemplo de enfileiramento (a ser implementado em setupQueues):
  // await notificationQueue.add({ type: 'broadcast_online', message });
}
