// src/services/purchase.ts
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { getSettings } from '../config/settings';
import { Decimal } from '@prisma/client/runtime/library';

// ==============================
// TIPOS
// ==============================

export interface PurchaseResult {
  orderId: number;
  total: number;
  items: {
    productId: number;
    productName: string;
    quantity: number;
    unitPrice: number;
    stockItemIds: number[];
  }[];
}

// ==============================
// FUNÇÃO PRINCIPAL DE COMPRA
// ==============================

/**
 * Realiza a compra de um produto, com verificação de estoque, saldo e transação atômica.
 * @param userId ID do usuário comprador
 * @param productId ID do produto
 * @param quantity Quantidade desejada (default 1)
 * @param idempotencyKey Chave opcional para evitar duplicidade (não implementada no schema, mas pode ser usada em cache)
 * @returns Dados do pedido criado
 */
export async function purchaseProduct(
  userId: number,
  productId: number,
  quantity: number = 1,
  idempotencyKey?: string
): Promise<PurchaseResult> {
  // Validações iniciais
  if (quantity <= 0) throw new Error('Quantidade inválida');

  const settings = await getSettings();

  // Verificar se usuário existe e está ativo
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || user.status !== 'ACTIVE') throw new Error('Usuário inválido ou bloqueado');

  // Verificar produto ativo
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || product.status !== 'ACTIVE') throw new Error('Produto indisponível');

  // Calcular total
  const unitPrice = product.price;
  const total = unitPrice.mul(quantity);

  // Verificar saldo suficiente (fora da transação para melhor UX, mas será revalidado dentro)
  const wallet = await prisma.wallet.findUnique({ where: { userId } });
  if (!wallet) throw new Error('Carteira não encontrada');

  if (wallet.balance.lessThan(total)) {
    const missing = total.sub(wallet.balance);
    throw new Error(`Saldo insuficiente. Faltam R$ ${missing.toFixed(2)}`);
  }

  // Iniciar transação para atomicidade
  try {
    const result = await prisma.$transaction(
      async (tx) => {
        // Revalidar saldo dentro da transação (para evitar concorrência)
        const currentWallet = await tx.wallet.findUnique({ where: { userId } });
        if (!currentWallet || currentWallet.balance.lessThan(total)) {
          throw new Error('Saldo insuficiente');
        }

        // Buscar itens de estoque disponíveis
        const availableItems = await tx.stockItem.findMany({
          where: {
            productId,
            status: 'AVAILABLE',
          },
          orderBy: { id: 'asc' },
          take: quantity,
          select: { id: true },
        });

        if (availableItems.length < quantity) {
          throw new Error('Estoque insuficiente');
        }

        const stockItemIds = availableItems.map((item) => item.id);

        // Reservar itens atomicamente: atualizar de AVAILABLE para RESERVED
        const reservationUpdate = await tx.stockItem.updateMany({
          where: {
            id: { in: stockItemIds },
            status: 'AVAILABLE', // garante que ainda estejam disponíveis
          },
          data: { status: 'RESERVED' },
        });

        if (reservationUpdate.count !== quantity) {
          // Algum item foi pego por outra transação; rollback
          throw new Error('Conflito de estoque, tente novamente');
        }

        // Criar pedido com status RESERVED
        const order = await tx.order.create({
          data: {
            userId,
            status: 'RESERVED',
            totalAmount: total,
            paymentMethod: 'wallet',
          },
        });

        // Criar itens do pedido
        for (const itemId of stockItemIds) {
          await tx.orderItem.create({
            data: {
              orderId: order.id,
              productId,
              quantity: 1, // cada item de estoque representa 1 unidade
              unitPrice,
              stockItemId: itemId,
            },
          });
        }

        // Criar registros de Reservation (expiração curta, pois a compra é imediata)
        const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 minutos
        for (const itemId of stockItemIds) {
          await tx.reservation.create({
            data: {
              stockItemId: itemId,
              userId,
              orderId: order.id,
              status: 'RESERVED',
              expiresAt,
            },
          });
        }

        // Descontar saldo
        const newBalance = currentWallet.balance.sub(total);
        await tx.wallet.update({
          where: { id: currentWallet.id },
          data: { balance: newBalance },
        });

        // Registrar transação de compra
        await tx.walletTransaction.create({
          data: {
            walletId: currentWallet.id,
            type: 'PURCHASE',
            amount: total.negated(), // valor negativo para indicar débito
            balanceAfter: newBalance,
            description: `Compra de ${product.name} x${quantity}`,
            referenceId: order.id.toString(),
          },
        });

        // Atualizar pedido para PAID
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'PAID' },
        });

        // Marcar itens como SOLD
        await tx.stockItem.updateMany({
          where: { id: { in: stockItemIds } },
          data: { status: 'SOLD' },
        });

        // Atualizar Reservation para SOLD
        await tx.reservation.updateMany({
          where: { stockItemId: { in: stockItemIds }, status: 'RESERVED' },
          data: { status: 'SOLD' },
        });

        // Entregar imediatamente (marcar como DELIVERED)
        await tx.order.update({
          where: { id: order.id },
          data: { status: 'DELIVERED', deliveredAt: new Date() },
        });

        return {
          orderId: order.id,
          total: total.toNumber(),
          items: [
            {
              productId,
              productName: product.name,
              quantity,
              unitPrice: unitPrice.toNumber(),
              stockItemIds,
            },
          ],
        };
      },
      {
        isolationLevel: 'Serializable', // garante isolamento forte
        timeout: 10000,
      }
    );

    logger.info(`Compra realizada: usuário ${userId}, produto ${productId}, quantidade ${quantity}, pedido ${result.orderId}`);
    return result;
  } catch (error) {
    logger.error(`Erro na compra: ${error.message}`);
    // Se o erro for de saldo/estoque, repassar mensagem amigável
    if (error.message.includes('insuficiente') || error.message.includes('Conflito')) {
      throw new Error(error.message);
    }
    throw new Error('Falha ao processar compra. Tente novamente.');
  }
}

// ==============================
// LIBERAÇÃO DE RESERVAS EXPIRADAS
// ==============================

/**
 * Libera reservas expiradas, voltando itens para AVAILABLE.
 * Deve ser chamado pelo worker periódico.
 */
export async function releaseExpiredReservations(): Promise<void> {
  const now = new Date();

  // Buscar reservas expiradas
  const expiredReservations = await prisma.reservation.findMany({
    where: {
      status: 'RESERVED',
      expiresAt: { lt: now },
    },
    include: { stockItem: true },
  });

  if (expiredReservations.length === 0) return;

  const stockItemIds = expiredReservations.map((r) => r.stockItemId);

  // Atualizar itens de estoque para AVAILABLE
  await prisma.stockItem.updateMany({
    where: {
      id: { in: stockItemIds },
      status: 'RESERVED',
    },
    data: { status: 'AVAILABLE' },
  });

  // Atualizar reservas para status EXPIRED (usar enum? não temos, pode-se excluir)
  await prisma.reservation.deleteMany({
    where: { id: { in: expiredReservations.map((r) => r.id) } },
  });

  logger.info(`${expiredReservations.length} reservas expiradas liberadas`);
}

// ==============================
// VERIFICAÇÃO DE ESTOQUE DISPONÍVEL
// ==============================

/**
 * Retorna a quantidade de itens disponíveis para venda de um produto.
 */
export async function getAvailableStock(productId: number): Promise<number> {
  const count = await prisma.stockItem.count({
    where: {
      productId,
      status: 'AVAILABLE',
    },
  });
  return count;
}

// ==============================
// FUNÇÃO PARA COMPRA MÚLTIPLA (chamada pelo bot)
// ==============================

/**
 * Função de compra usada pelo bot, que valida quantidade e chama purchaseProduct.
 */
export async function buyProduct(userId: number, productId: number, quantity: number): Promise<PurchaseResult> {
  return purchaseProduct(userId, productId, quantity);
}
