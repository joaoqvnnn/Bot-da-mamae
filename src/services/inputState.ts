// src/services/inputState.ts
import { Context } from 'telegraf';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { getSettings } from '../config/settings';
import { formatMessageText, getMessage } from '../config/messages';

// Tipos de validação disponíveis
export type ValidationType =
  | 'email'
  | 'whatsapp'
  | 'cpf'
  | 'cnpj'
  | 'pix_key'
  | 'quantity'
  | 'money'
  | 'gift_card'
  | 'password'
  | 'confirmation'
  | 'search'
  | 'bank_agency'
  | 'bank_account'
  | 'bank_digit'
  | 'product_name'
  | 'product_price'
  | 'product_category'
  | 'product_description'
  | 'phone'
  | 'any';

export interface InputStateData {
  userId: number;
  type: string; // InputStateType do schema, pode ser string para flexibilidade
  data?: Record<string, any>; // dados adicionais (ex: produtoId, valor, etc.)
  chatId?: number; // chat onde a mensagem foi pedida (para editar depois)
  messageId?: number; // id da mensagem do bot que será editada/apagada
}

/**
 * Cria um novo estado de entrada para o usuário.
 * Deve ser chamado quando o bot pede uma informação.
 */
export async function createInputState(
  userId: number,
  type: string,
  data?: Record<string, any>,
  chatId?: number,
  messageId?: number
): Promise<void> {
  // Remove qualquer estado anterior para evitar conflito
  await prisma.inputState.deleteMany({ where: { userId } });

  await prisma.inputState.create({
    data: {
      userId,
      type,
      data: data || {},
    },
  });
}

/**
 * Obtém o estado de entrada ativo do usuário.
 */
export async function getActiveInputState(userId: number) {
  return prisma.inputState.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
}

/**
 * Remove o estado de entrada ativo.
 */
export async function clearInputState(userId: number): Promise<void> {
  await prisma.inputState.deleteMany({ where: { userId } });
}

/**
 * Processa a entrada recebida do usuário (texto) de acordo com o tipo de estado.
 * Retorna um objeto com validação e dados processados, ou lança erro se inválido.
 */
export async function processInput(
  ctx: Context,
  state: any,
  inputText: string
): Promise<{ valid: boolean; errorMessage?: string; data?: any }> {
  const text = inputText.trim();
  const type = state.type as string;

  // Se o usuário digitou /cancelar, retorna cancelamento
  if (text.toLowerCase() === '/cancelar') {
    await clearInputState(state.userId);
    return { valid: false, errorMessage: 'cancelar' };
  }

  let valid = true;
  let errorMessage: string | undefined;
  let processedData: any;

  switch (type) {
    case 'WAITING_FOR_EMAIL':
      if (!isValidEmail(text)) {
        valid = false;
        errorMessage = '❌ E-mail inválido. Digite novamente.';
      } else {
        processedData = { email: text.toLowerCase() };
      }
      break;

    case 'WAITING_FOR_WHATSAPP':
    case 'WAITING_FOR_PHONE':
      if (!isValidPhone(text)) {
        valid = false;
        errorMessage = '❌ Número de telefone inválido. Use formato DDD+número.';
      } else {
        processedData = { phone: normalizePhone(text) };
      }
      break;

    case 'WAITING_FOR_CPF':
      if (!isValidCPF(text)) {
        valid = false;
        errorMessage = '❌ CPF inválido.';
      } else {
        processedData = { cpf: normalizeCPF(text) };
      }
      break;

    case 'WAITING_FOR_CNPJ':
      if (!isValidCNPJ(text)) {
        valid = false;
        errorMessage = '❌ CNPJ inválido.';
      } else {
        processedData = { cnpj: normalizeCNPJ(text) };
      }
      break;

    case 'WAITING_FOR_PIX_KEY':
      if (!isValidPixKey(text)) {
        valid = false;
        errorMessage = '❌ Chave Pix inválida. Digite CPF, CNPJ, e-mail, telefone ou chave aleatória.';
      } else {
        processedData = { pixKey: text };
      }
      break;

    case 'WAITING_FOR_QUANTITY':
      const qty = Number(text);
      if (!Number.isInteger(qty) || qty <= 0) {
        valid = false;
        errorMessage = '❌ Quantidade inválida. Digite um número inteiro positivo.';
      } else {
        processedData = { quantity: qty };
      }
      break;

    case 'WAITING_FOR_VALUE':
    case 'WAITING_FOR_MONEY':
      const value = parseFloat(text.replace(',', '.'));
      if (isNaN(value) || value <= 0) {
        valid = false;
        errorMessage = '❌ Valor inválido. Digite um número positivo.';
      } else {
        processedData = { value: value.toFixed(2) };
      }
      break;

    case 'WAITING_FOR_GIFT_CARD':
      // Apenas aceita string não vazia, a validação de existência será feita depois
      if (text.length < 3) {
        valid = false;
        errorMessage = '❌ Código de Gift Card inválido.';
      } else {
        processedData = { giftCardCode: text.toUpperCase() };
      }
      break;

    case 'WAITING_FOR_PASSWORD':
      // Senha mínima 4 caracteres (pode ser configurável)
      if (text.length < 4) {
        valid = false;
        errorMessage = '❌ Senha muito curta. Mínimo 4 caracteres.';
      } else {
        processedData = { password: text };
      }
      break;

    case 'WAITING_FOR_CONFIRMATION':
      const lower = text.toLowerCase();
      if (['sim', 's', 'yes', 'y', 'confirmar'].includes(lower)) {
        processedData = { confirmed: true };
      } else if (['não', 'nao', 'n', 'no', 'cancelar'].includes(lower)) {
        processedData = { confirmed: false };
      } else {
        valid = false;
        errorMessage = '❌ Responda com Sim ou Não.';
      }
      break;

    case 'WAITING_FOR_SEARCH':
      if (text.length < 2) {
        valid = false;
        errorMessage = '❌ Digite pelo menos 2 caracteres para pesquisar.';
      } else {
        processedData = { searchTerm: text };
      }
      break;

    case 'WAITING_FOR_BANK_AGENCY':
      if (!/^\d{1,4}$/.test(text)) {
        valid = false;
        errorMessage = '❌ Agência inválida. Use apenas números.';
      } else {
        processedData = { agency: text };
      }
      break;

    case 'WAITING_FOR_BANK_ACCOUNT':
      if (!/^\d{3,12}$/.test(text)) {
        valid = false;
        errorMessage = '❌ Conta inválida. Use apenas números.';
      } else {
        processedData = { account: text };
      }
      break;

    case 'WAITING_FOR_BANK_DIGIT':
      if (!/^\d{1,2}$/.test(text)) {
        valid = false;
        errorMessage = '❌ Dígito inválido. Use apenas números.';
      } else {
        processedData = { digit: text };
      }
      break;

    case 'WAITING_FOR_PRODUCT_NAME':
      if (text.length < 2) {
        valid = false;
        errorMessage = '❌ Nome muito curto.';
      } else {
        processedData = { name: text };
      }
      break;

    case 'WAITING_FOR_PRODUCT_PRICE':
      const price = parseFloat(text.replace(',', '.'));
      if (isNaN(price) || price < 0) {
        valid = false;
        errorMessage = '❌ Preço inválido.';
      } else {
        processedData = { price: price.toFixed(2) };
      }
      break;

    case 'WAITING_FOR_PRODUCT_CATEGORY':
      if (text.length < 2) {
        valid = false;
        errorMessage = '❌ Categoria muito curta.';
      } else {
        processedData = { category: text };
      }
      break;

    case 'WAITING_FOR_PRODUCT_DESCRIPTION':
      processedData = { description: text };
      break;

    default:
      valid = false;
      errorMessage = '❌ Tipo de entrada não suportado.';
  }

  return { valid, errorMessage, data: processedData };
}

/**
 * Apaga a mensagem do usuário e a mensagem do bot, se possível, para manter o chat limpo.
 */
export async function cleanupMessages(ctx: Context, state: any): Promise<void> {
  try {
    // Tenta apagar a mensagem do usuário
    if (ctx.message && (ctx.message as any).message_id) {
      await ctx.deleteMessage((ctx.message as any).message_id);
    }
    // Tenta apagar a mensagem do bot (se tivermos o message_id salvo)
    if (state.data?.botMessageId && ctx.chat?.id) {
      await ctx.telegram.deleteMessage(ctx.chat.id, state.data.botMessageId);
    }
  } catch (error) {
    // Ignora erros de permissão ou mensagem não encontrada
    logger.warn('Falha ao limpar mensagens:', error);
  }
}

// ============ FUNÇÕES DE VALIDAÇÃO AUXILIARES ============

export function isValidEmail(email: string): boolean {
  const re = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return re.test(email);
}

export function isValidPhone(phone: string): boolean {
  // Aceita formatos comuns: (11) 99999-9999, 11999999999, +55 11 99999-9999, etc.
  const digits = phone.replace(/\D/g, '');
  return digits.length >= 10 && digits.length <= 13;
}

export function normalizePhone(phone: string): string {
  const digits = phone.replace(/\D/g, '');
  if (digits.startsWith('55') && digits.length === 13) return digits; // com código do país
  if (digits.length === 11) return `55${digits}`;
  if (digits.length === 10) return `55${digits}`;
  return digits;
}

export function isValidCPF(cpf: string): boolean {
  const clean = cpf.replace(/\D/g, '');
  if (clean.length !== 11) return false;
  // Implementação simplificada (pode-se adicionar verificação de dígitos)
  return true;
}

export function normalizeCPF(cpf: string): string {
  return cpf.replace(/\D/g, '');
}

export function isValidCNPJ(cnpj: string): boolean {
  const clean = cnpj.replace(/\D/g, '');
  return clean.length === 14;
}

export function normalizeCNPJ(cnpj: string): string {
  return cnpj.replace(/\D/g, '');
}

export function isValidPixKey(key: string): boolean {
  const trimmed = key.trim();
  // Chave aleatória: UUID ou 32-64 caracteres alfanuméricos
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) return true;
  // E-mail
  if (isValidEmail(trimmed)) return true;
  // Telefone
  if (isValidPhone(trimmed)) return true;
  // CPF
  if (isValidCPF(trimmed)) return true;
  // CNPJ
  if (isValidCNPJ(trimmed)) return true;
  // Chave aleatória (exemplo: 3d4f5a6b-7c8d-9e0f-1a2b-3c4d5e6f7a8b)
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) return true;
  return false;
}

// Função utilitária para aguardar entrada e processar
export async function waitForInput(
  userId: number,
  type: string,
  promptMessage: string,
  data?: Record<string, any>
): Promise<void> {
  await createInputState(userId, type, data);
  // O prompt deve ser enviado pelo chamador, aqui apenas registramos o estado.
}
