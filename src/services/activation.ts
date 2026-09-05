// src/services/activation.ts
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { getSettings } from '../config/settings';
import { hash, compare } from 'bcrypt';
import { randomBytes, createHash } from 'crypto';

// ==============================
// TIPOS
// ==============================

export interface ActivationResult {
  success: boolean;
  message?: string;
  login?: string;
  senha?: string;
  orderId?: number;
  productName?: string;
}

// ==============================
// GERAÇÃO DE TOKEN DE ATIVAÇÃO
// ==============================

/**
 * Gera um token seguro e único para ativação de um pedido.
 * O token é salvo como hash no banco, não o valor puro.
 * @param userId ID do usuário
 * @param orderId ID do pedido
 * @param expiresInMinutos Tempo de expiração (padrão 60 minutos)
 * @returns O token puro a ser enviado ao cliente (ex: link)
 */
export async function generateActivationToken(
  userId: number,
  orderId: number,
  expiresInMinutos: number = 60
): Promise<string> {
  // Gerar token aleatório
  const token = randomBytes(32).toString('hex');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + expiresInMinutos * 60 * 1000);

  await prisma.activationToken.create({
    data: {
      userId,
      orderId,
      tokenHash,
      expiresAt,
    },
  });

  return token;
}

/**
 * Verifica se um token de ativação é válido.
 * @param token Token puro
 * @returns Dados do token (userId, orderId, etc.) ou null se inválido/expirado
 */
export async function verifyActivationToken(token: string): Promise<any | null> {
  const tokenHash = createHash('sha256').update(token).digest('hex');

  const tokenData = await prisma.activationToken.findUnique({
    where: { tokenHash },
    include: {
      order: {
        include: {
          items: {
            include: {
              product: true,
              stockItem: true,
            },
          },
        },
      },
      user: true,
    },
  });

  if (!tokenData) return null;
  if (tokenData.usedAt) return null;
  if (tokenData.expiresAt < new Date()) return null;

  return tokenData;
}

/**
 * Ativa o produto após validação de senha.
 * A senha informada é comparada com a senha cadastrada do usuário (ou senha de saque).
 * @param token Token puro do link
 * @param password Senha digitada pelo usuário
 * @returns Resultado da ativação
 */
export async function activateProductWithPassword(
  token: string,
  password: string
): Promise<ActivationResult> {
  const tokenData = await verifyActivationToken(token);
  if (!tokenData) {
    return { success: false, message: 'Link inválido ou expirado.' };
  }

  // Buscar usuário e sua senha de segurança (a mesma usada para saque)
  const user = tokenData.user;
  if (!user || !user.passwordHash) {
    return { success: false, message: 'Senha não cadastrada. Use /definirsenha primeiro.' };
  }

  // Verificar senha
  const valid = await compare(password, user.passwordHash);
  if (!valid) {
    logger.warn(`Tentativa de ativação com senha incorreta para token ${token}`);
    return { success: false, message: 'Senha incorreta.' };
  }

  // Marcar token como usado
  await prisma.activationToken.update({
    where: { id: tokenData.id },
    data: { usedAt: new Date() },
  });

  // Buscar dados do produto/entrega
  const firstItem = tokenData.order.items[0];
  if (!firstItem || !firstItem.stockItem) {
    return { success: false, message: 'Dados do produto não encontrados.' };
  }

  // Atualizar pedido para DELIVERED se ainda não estiver
  if (tokenData.order.status !== 'DELIVERED') {
    await prisma.order.update({
      where: { id: tokenData.order.id },
      data: { status: 'DELIVERED', deliveredAt: new Date() },
    });
  }

  return {
    success: true,
    login: firstItem.stockItem.login || '',
    senha: firstItem.stockItem.senha || '',
    orderId: tokenData.order.id,
    productName: firstItem.product.name,
  };
}

/**
 * Marca um token como usado sem exigir senha (para fluxos alternativos).
 */
export async function markTokenAsUsed(tokenHash: string): Promise<void> {
  await prisma.activationToken.update({
    where: { tokenHash },
    data: { usedAt: new Date() },
  });
}

/**
 * Limpa tokens expirados (pode ser chamado por worker).
 */
export async function cleanupExpiredTokens(): Promise<void> {
  const deleted = await prisma.activationToken.deleteMany({
    where: {
      usedAt: null,
      expiresAt: { lt: new Date() },
    },
  });
  if (deleted.count > 0) {
    logger.info(`${deleted.count} tokens de ativação expirados removidos`);
  }
}
