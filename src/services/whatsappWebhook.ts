// src/services/whatsappWebhook.ts
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { getSettings } from '../config/settings';
import { sendWhatsAppMessage } from './whatsapp';
import { processMessageFromWhatsApp } from './whatsappChat';
import { enqueueNotification } from './notification';

/**
 * Processa o payload do webhook do WhatsApp.
 * Pode incluir mensagens, status de entrega, chamadas, etc.
 * @param payload Corpo da requisição do webhook
 */
export async function processWhatsAppWebhook(payload: any): Promise<void> {
  try {
    if (!payload || !payload.entry || !Array.isArray(payload.entry)) {
      logger.warn('Payload de webhook WhatsApp inválido');
      return;
    }

    for (const entry of payload.entry) {
      if (!entry.changes || !Array.isArray(entry.changes)) continue;

      for (const change of entry.changes) {
        const field = change.field;
        const value = change.value;

        if (field === 'messages') {
          await handleMessageEvent(value);
        } else if (field === 'call') {
          await handleCallEvent(value);
        } else {
          logger.debug(`Campo desconhecido no webhook WhatsApp: ${field}`);
        }
      }
    }
  } catch (error) {
    logger.error('Erro ao processar webhook WhatsApp', error);
    throw error;
  }
}

/**
 * Processa eventos de mensagens recebidas.
 */
async function handleMessageEvent(value: any): Promise<void> {
  const messages = value.messages;

  if (!messages || !Array.isArray(messages) || messages.length === 0) return;

  const phoneNumberId = value.metadata?.phone_number_id;

  for (const message of messages) {
    if (message.type !== 'text') continue;

    const from = message.from;
    const text = message.text?.body;

    if (!from || !text) continue;

    logger.info(`Mensagem WhatsApp recebida de ${from}: ${text}`);

    await processMessageFromWhatsApp(from, text, phoneNumberId);
  }
}

/**
 * Processa eventos de chamada recebida.
 * A regra: se ligar, bloqueia o contato temporariamente (4 horas).
 */
async function handleCallEvent(value: any): Promise<void> {
  const callId = value.call_id;
  const from = value.from;
  const status = value.status;

  if (!from) {
    logger.warn('Evento de chamada sem remetente');
    return;
  }

  logger.info(`Chamada recebida de ${from} (status: ${status})`);

  await blockContactTemporarily(from, 'Chamada recebida', 4 * 60 * 60 * 1000);

  await enqueueNotification({
    userId: 0,
    channel: 'telegram',
    type: 'HUMAN_SUPPORT',
    message: {
      text: `🚫 CHAMADA RECEBIDA E CONTATO BLOQUEADO POR 4H\n📱 Número: ${from}\n🆔 Call ID: ${callId || 'N/A'}\nStatus: ${status || 'desconhecido'}`,
    },
  });
}

/**
 * Bloqueia temporariamente um contato do WhatsApp.
 * Apenas registra no banco; não chama API externa de bloqueio.
 */
async function blockContactTemporarily(
  phone: string,
  reason: string,
  durationMs: number = 4 * 60 * 60 * 1000
): Promise<void> {
  const now = new Date();
  const expiresAt = new Date(now.getTime() + durationMs);

  const existing = await prisma.rateLimit.findFirst({
    where: {
      phone,
      action: 'BLOCK_TEMP',
      expiresAt: { gt: now },
    },
  });

  if (existing) {
    logger.info(`Contato ${phone} já possui bloqueio temporário ativo até ${existing.expiresAt}`);
    return;
  }

  await prisma.rateLimit.create({
    data: {
      phone,
      type: 'AI_MESSAGE',
      action: 'BLOCK_TEMP',
      count: 999,
      expiresAt,
    },
  });

  logger.info(`Contato ${phone} bloqueado por 4h por ligação - motivo: ${reason}`);
}
