// src/services/notification.ts
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { notificationQueue } from '../queues'; // importa da fila central
import { getSettings } from '../config/settings';
import { Telegraf } from 'telegraf';
import { sendEmail as sendEmailService } from './email';
import { sendWhatsAppMessage as sendWhatsAppService } from './whatsapp';

// ==============================
// TIPOS
// ==============================

export interface NotificationPayload {
  userId?: number;          // ID interno do usuário (para Telegram)
  phone?: string;           // número WhatsApp
  email?: string;           // e-mail
  channel: 'telegram' | 'whatsapp' | 'email';
  type: string;             // tipo de notificação (ex: PURCHASE_COMPLETED)
  message: any;             // conteúdo (texto, botões, imagem, etc.)
  scheduledFor?: Date;
}

// ==============================
// ENFILEIRAR NOTIFICAÇÃO
// ==============================

export async function enqueueNotification(data: NotificationPayload): Promise<void> {
  const notif = await prisma.notification.create({
    data: {
      userId: data.userId,
      type: data.type as any,
      message: data.message,
      channel: data.channel,
      status: 'PENDING',
      scheduledFor: data.scheduledFor,
    },
  });

  if (data.scheduledFor && data.scheduledFor > new Date()) {
    await notificationQueue.add(
      { notificationId: notif.id },
      { delay: data.scheduledFor.getTime() - Date.now() }
    );
  } else {
    await notificationQueue.add({ notificationId: notif.id });
  }
}

// ==============================
// PROCESSAR NOTIFICAÇÕES PENDENTES
// ==============================

export async function processPendingNotifications(): Promise<void> {
  const pending = await prisma.notification.findMany({
    where: {
      status: 'PENDING',
      OR: [
        { scheduledFor: null },
        { scheduledFor: { lte: new Date() } },
      ],
    },
    take: 50,
    orderBy: { createdAt: 'asc' },
  });

  for (const notif of pending) {
    // Marca como processando para evitar duplicações
    await prisma.notification.update({
      where: { id: notif.id },
      data: { status: 'SENT' }, // temporário; se falhar, retorna a PENDING
    });

    try {
      await sendNotification(notif);
      await prisma.notification.update({
        where: { id: notif.id },
        data: { status: 'SENT', sentAt: new Date() },
      });
      logger.info(`Notificação ${notif.id} enviada`);
    } catch (error) {
      const attempts = notif.attempts + 1;
      const lastError = error.message;

      if (attempts >= 3) {
        await prisma.notification.update({
          where: { id: notif.id },
          data: { status: 'FAILED', attempts, lastError },
        });
      } else {
        await prisma.notification.update({
          where: { id: notif.id },
          data: { status: 'PENDING', attempts, lastError },
        });
        // Reenfileira com backoff
        await notificationQueue.add(
          { notificationId: notif.id },
          { delay: 60 * 1000 * attempts }
        );
      }

      logger.error(`Falha na notificação ${notif.id}: ${lastError}`);
    }
  }
}

// ==============================
// ENVIO REAL
// ==============================

async function sendNotification(notif: any): Promise<void> {
  switch (notif.channel) {
    case 'telegram':
      if (!notif.userId) throw new Error('userId ausente para Telegram');
      const bot = getTelegramBot();
      if (!bot) throw new Error('Bot Telegram não inicializado');
      await sendTelegramNotification(bot, notif.userId, notif.message);
      break;

    case 'whatsapp':
      if (!notif.phone) throw new Error('phone ausente para WhatsApp');
      await sendWhatsAppService(notif.phone, notif.message);
      break;

    case 'email':
      if (!notif.email) throw new Error('email ausente para Email');
      await sendEmailService(notif.email, notif.message);
      break;

    default:
      throw new Error(`Canal desconhecido: ${notif.channel}`);
  }
}

// ==============================
// FUNÇÕES AUXILIARES POR CANAL
// ==============================

async function sendTelegramNotification(bot: Telegraf, userId: number, payload: any): Promise<void> {
  // Aqui userId é o ID interno do usuário no banco
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw new Error('Usuário não encontrado');

  const { text, buttons, image } = payload;
  const extra: any = {};
  if (buttons) {
    extra.reply_markup = { inline_keyboard: buttons };
  }
  if (image) {
    await bot.telegram.sendPhoto(user.telegramId.toString(), image, {
      caption: text,
      ...extra,
    });
  } else {
    await bot.telegram.sendMessage(user.telegramId.toString(), text, extra);
  }
}

// ==============================
// INSTÂNCIA GLOBAL DO BOT
// ==============================

let botInstance: Telegraf | null = null;

export function setTelegramBot(bot: Telegraf) {
  botInstance = bot;
}

function getTelegramBot(): Telegraf | null {
  return botInstance;
}
