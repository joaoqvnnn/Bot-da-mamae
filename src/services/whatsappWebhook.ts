// src/services/whatsappChat.ts
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { getSettings } from '../config/settings';
import { sendWhatsAppMessage } from './whatsapp';
import { enqueueNotification } from './notification';
import { getAIResponse } from './ai';

/**
 * Processa mensagens de texto recebidas do WhatsApp.
 */
export async function processMessageFromWhatsApp(
  phone: string,
  text: string,
  phoneNumberId?: string
): Promise<void> {
  const rateLimitOk = await checkRateLimit(phone);
  if (!rateLimitOk) {
    logger.warn(`Mensagem de ${phone} bloqueada por rate limit`);
    return;
  }

  const user = await prisma.user.findFirst({
    where: {
      whatsappContacts: {
        some: { phone },
      },
    },
    include: {
      whatsappContacts: true,
    },
  });

  if (!user) {
    await sendWhatsAppMessage(phone, {
      text: 'Olá! Não reconheço seu número. Fale com nosso suporte pelo Telegram.',
    });
    return;
  }

  if (isHumanSupportRequest(text)) {
    await createHumanSupportTicket(user.id, phone, text);
    await sendWhatsAppMessage(phone, {
      text: 'Um atendente humano foi acionado e responderá em breve.',
    });
    return;
  }

  try {
    const aiResponse = await getAIResponse(user.id, text);
    await sendWhatsAppMessage(phone, { text: aiResponse });
  } catch (error) {
    logger.error(`Erro ao processar mensagem de ${phone}`, error);
    await sendWhatsAppMessage(phone, {
      text: 'Desculpe, tive um problema. Tente novamente mais tarde.',
    });
  }
}

/**
 * Verifica rate limit para o número.
 * Retorna true se permitido, false se bloqueado.
 */
async function checkRateLimit(phone: string): Promise<boolean> {
  const settings = await getSettings();
  const now = new Date();

  // Verificar bloqueio temporário ativo
  const blocked = await prisma.rateLimit.findFirst({
    where: {
      phone,
      action: 'BLOCK_TEMP',
      expiresAt: { gt: now },
    },
  });
  if (blocked) {
    return false;
  }

  // Limpar registros antigos (mais de 24 horas) para evitar crescimento excessivo
  const cleanupBefore = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  await prisma.rateLimit.deleteMany({
    where: {
      phone,
      createdAt: { lt: cleanupBefore },
    },
  });

  const windowSeconds = settings.rateLimit.windowSeconds;
  const maxMessages = settings.rateLimit.maxMessages;
  const windowStart = new Date(now.getTime() - windowSeconds * 1000);

  // Contar mensagens na janela
  const count = await prisma.rateLimit.count({
    where: {
      phone,
      type: 'AI_MESSAGE',
      action: 'ALLOW',
      createdAt: { gte: windowStart },
    },
  });

  if (count >= maxMessages) {
    // Registrar bloqueio temporário
    await prisma.rateLimit.create({
      data: {
        phone,
        type: 'AI_MESSAGE',
        action: 'BLOCK_TEMP',
        count: count + 1,
        expiresAt: new Date(now.getTime() + settings.rateLimit.blockMinutes * 60 * 1000),
      },
    });
    return false;
  }

  // Registrar mensagem permitida
  await prisma.rateLimit.create({
    data: {
      phone,
      type: 'AI_MESSAGE',
      action: 'ALLOW',
      count: count + 1,
    },
  });

  return true;
}

function isHumanSupportRequest(text: string): boolean {
  const keywords = ['falar com humano', 'atendente', 'pessoa', 'suporte humano', 'falar com alguém'];
  const lower = text.toLowerCase();
  return keywords.some((k) => lower.includes(k));
}

async function createHumanSupportTicket(userId: number, phone: string, message: string): Promise<void> {
  const ticket = await prisma.supportTicket.create({
    data: {
      userId,
      subject: 'Atendimento via WhatsApp',
      message,
      status: 'HUMAN_REQUIRED',
    },
  });

  await enqueueNotification({
    userId: 0,
    channel: 'telegram',
    type: 'HUMAN_SUPPORT',
    message: {
      text: `🆘 NOVO ATENDIMENTO HUMANO\n👤 Telefone: ${phone}\n💬 Mensagem: ${message}`,
    },
  });

  logger.info(`Ticket humano criado: ${ticket.id}`);
}
