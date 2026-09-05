// src/config/messages.ts
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';

// Tipos para botões (agora inclui key, screen e position)
export interface ButtonConfig {
  key: string;
  screen?: string | null;
  text: string;
  emoji?: string | null;
  action: string;
  position: number;   // posição dentro do teclado (para agrupar em linhas)
  order: number;      // ordem de prioridade
  isActive: boolean;
  permission?: string | null;
}

// Tipos para mensagens
export interface MessageConfig {
  key: string;
  screen?: string | null;
  title?: string | null;
  text: string;
  imageUrl?: string | null;
  videoUrl?: string | null;
  buttons?: ButtonConfig[] | null;
  componentOrder?: string[] | null;
  order: number;
  isActive: boolean;
}

// Cache em memória
let cachedMessages: MessageConfig[] | null = null;
let cachedButtons: ButtonConfig[] | null = null;

async function loadMessages(): Promise<MessageConfig[]> {
  if (cachedMessages) return cachedMessages;

  const dbMessages = await prisma.message.findMany({
    where: { isActive: true },
    orderBy: [{ screen: 'asc' }, { order: 'asc' }],
  });

  const messages: MessageConfig[] = dbMessages.map((m) => ({
    key: m.key,
    screen: m.screen,
    title: m.title,
    text: m.text,
    imageUrl: m.imageUrl,
    videoUrl: m.videoUrl,
    buttons: m.buttons ? (m.buttons as ButtonConfig[]) : null,
    componentOrder: m.componentOrder ? (m.componentOrder as string[]) : null,
    order: m.order,
    isActive: m.isActive,
  }));

  cachedMessages = messages;
  return messages;
}

async function loadButtons(): Promise<ButtonConfig[]> {
  if (cachedButtons) return cachedButtons;

  const dbButtons = await prisma.button.findMany({
    where: { isActive: true },
    orderBy: [{ screen: 'asc' }, { order: 'asc' }, { position: 'asc' }],
  });

  const buttons: ButtonConfig[] = dbButtons.map((b) => ({
    key: b.key,
    screen: b.screen,
    text: b.text,
    emoji: b.emoji,
    action: b.action,
    position: b.position,
    order: b.order,
    isActive: b.isActive,
    permission: b.permission,
  }));

  cachedButtons = buttons;
  return buttons;
}

export function invalidateMessagesCache() {
  cachedMessages = null;
  cachedButtons = null;
}

export async function getMessage(key: string): Promise<MessageConfig | null> {
  const messages = await loadMessages();
  return messages.find((m) => m.key === key) || null;
}

export async function getMessagesByScreen(screen: string): Promise<MessageConfig[]> {
  const messages = await loadMessages();
  return messages.filter((m) => m.screen === screen);
}

export async function getButtonsByScreen(screen: string): Promise<ButtonConfig[]> {
  const buttons = await loadButtons();
  return buttons.filter((b) => b.screen === screen);
}

export async function getButtonByKey(key: string): Promise<ButtonConfig | null> {
  const buttons = await loadButtons();
  return buttons.find((b) => b.key === key) || null;
}

export function formatMessageText(text: string, variables: Record<string, string | number>): string {
  let formatted = text;
  for (const [key, value] of Object.entries(variables)) {
    const regex = new RegExp(`\\{${key}\\}`, 'g');
    formatted = formatted.replace(regex, String(value));
  }
  return formatted;
}

/**
 * Monta um teclado inline a partir dos botões configurados para uma tela.
 * O callback_data será apenas o `action` do botão (string curta).
 * Para dados adicionais, o caller deve armazenar o contexto em Redis/cache e usar um ID curto
 * ou implementar um mapeamento temporário.
 */
export async function buildInlineKeyboard(screen: string, context?: Record<string, any>) {
  const buttons = await getButtonsByScreen(screen);
  if (!buttons || buttons.length === 0) return undefined;

  // Agrupa botões por 'position' em linhas
  const keyboard: { text: string; callback_data: string }[][] = [];
  let currentRow: { text: string; callback_data: string }[] = [];
  let lastPosition = buttons[0]?.position ?? 0;

  for (const btn of buttons) {
    if (btn.position !== lastPosition) {
      if (currentRow.length > 0) keyboard.push(currentRow);
      currentRow = [];
    }
    const label = `${btn.emoji ? btn.emoji + ' ' : ''}${btn.text}`;
    // Usa apenas action (curta) para evitar limite de 64 bytes
    currentRow.push({
      text: label,
      callback_data: btn.action,
    });
    lastPosition = btn.position;
  }

  if (currentRow.length > 0) keyboard.push(currentRow);

  // Se houver contexto e for necessário, armazenar em cache/Redis e incluir um identificador curto.
  // Exemplo: usar um hash curto e salvar no Redis com TTL.
  // Mas para simplificar, aqui retornamos apenas com action.

  return keyboard;
}

export async function updateMessage(key: string, data: Partial<MessageConfig>) {
  await prisma.message.update({
    where: { key },
    data: {
      title: data.title,
      text: data.text,
      imageUrl: data.imageUrl,
      videoUrl: data.videoUrl,
      buttons: data.buttons as any,
      componentOrder: data.componentOrder as any,
      order: data.order,
      isActive: data.isActive,
      screen: data.screen,
    },
  });
  invalidateMessagesCache();
  logger.info(`Mensagem ${key} atualizada`);
}

export async function updateButton(key: string, data: Partial<ButtonConfig>) {
  await prisma.button.update({
    where: { key }, // 'key' é único no schema (confirmed)
    data: {
      text: data.text,
      emoji: data.emoji,
      action: data.action,
      position: data.position,
      order: data.order,
      isActive: data.isActive,
      permission: data.permission,
      screen: data.screen,
    },
  });
  invalidateMessagesCache();
  logger.info(`Botão ${key} atualizado`);
}

export async function getAllMessages() {
  return loadMessages();
}

export async function getAllButtons() {
  return loadButtons();
}
