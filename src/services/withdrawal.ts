// src/services/withdrawal.ts
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { getSettings } from '../config/settings';
import { Decimal } from '@prisma/client/runtime/library';
import { compare } from 'bcrypt';
import { isValidPixKey, isValidCPF, isValidCNPJ } from './inputState';
import { sendPayout } from './payoutProvider'; // a ser implementado
import { randomUUID } from 'crypto';

// ==============================
// TIPOS
// ==============================

export interface WithdrawalResult {
  success: boolean;
  message?: string;
  withdrawalId?: number;
  netAmount?: number;
  fee?: number;
  status?: string;
}

export interface BankWithdrawalData {
  amount: number;           // <-- adicionado
  bankCode: string;
  agency: string;
  account: string;
  digit: string;
  type: 'corrente' | 'poupanca';
  cpfCnpj: string;
}

// ==============================
// FUNÇÕES PRINCIPAIS
// ==============================

/**
 * Solicita um saque via Pix para o usuário.
 */
export async function requestPixWithdrawal(
  userId: number,
  amount: number,
  password: string,
  pixKey: string
): Promise<WithdrawalResult> {
  const settings = await getSettings();
  const fee = calculateFee(amount, settings.affiliate);
  const netAmount = amount - fee;

  if (amount < settings.affiliate.minWithdrawal) {
    return {
      success: false,
      message: `Valor mínimo de saque é R$ ${settings.affiliate.minWithdrawal.toFixed(2)}`,
    };
  }

  if (!isValidPixKey(pixKey)) {
    return { success: false, message: 'Chave Pix inválida.' };
  }

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user || !user.passwordHash) {
    return { success: false, message: 'Senha de segurança não cadastrada.' };
  }

  const validPassword = await compare(password, user.passwordHash);
  if (!validPassword) {
    return { success: false, message: 'Senha incorreta.' };
  }

  const availableCommission = await getAvailableCommission(userId);
  if (availableCommission.lessThan(amount)) {
    return { success: false, message: 'Saldo de comissões insuficiente.' };
  }

  try {
    const withdrawal = await prisma.$transaction(async (tx) => {
      // Reservar comissões por valor exato
      await reserveCommissionByAmount(tx, userId, amount);

      const wd = await tx.withdrawal.create({
        data: {
          userId,
          amount: new Decimal(amount),
          fee: new Decimal(fee),
          netAmount: new Decimal(netAmount),
          method: 'PIX',
          pixKey,
          status: 'REQUESTED',
        },
      });

      return wd;
    });

    logger.info(`Saque Pix solicitado: userId ${userId}, valor ${amount}, id ${withdrawal.id}`);
    await enqueueWithdrawalProcessing(withdrawal.id);

    return {
      success: true,
      withdrawalId: withdrawal.id,
      netAmount,
      fee,
      status: 'REQUESTED',
    };
  } catch (error) {
    logger.error(`Erro ao solicitar saque Pix para usuário ${userId}`, error);
    return { success: false, message: 'Falha ao processar saque. Tente novamente.' };
  }
}

/**
 * Processa a transferência bancária (saque por dados bancários).
 */
export async function createBankWithdrawal(
  data: BankWithdrawalData,
  userId?: number
): Promise<WithdrawalResult> {
  if (!userId) {
    return { success: false, message: 'Usuário não autenticado.' };
  }

  const settings = await getSettings();
  const fee = calculateFee(data.amount, settings.affiliate);
  const netAmount = data.amount - fee;

  // Validações bancárias...
  if (!/^\d{1,3}$/.test(data.bankCode)) {
    return { success: false, message: 'Código do banco inválido.' };
  }
  // ... demais validações

  const availableCommission = await getAvailableCommission(userId);
  if (availableCommission.lessThan(data.amount)) {
    return { success: false, message: 'Saldo de comissões insuficiente.' };
  }

  try {
    const withdrawal = await prisma.$transaction(async (tx) => {
      // Reservar comissões por valor exato
      await reserveCommissionByAmount(tx, userId, data.amount);

      const wd = await tx.withdrawal.create({
        data: {
          userId,
          amount: new Decimal(data.amount),
          fee: new Decimal(fee),
          netAmount: new Decimal(netAmount),
          method: 'BANK_TRANSFER',
          bankData: {
            bankCode: data.bankCode,
            agency: data.agency,
            account: data.account,
            digit: data.digit,
            type: data.type,
            cpfCnpj: data.cpfCnpj,
          },
          status: 'REQUESTED',
        },
      });

      return wd;
    });

    logger.info(`Saque bancário solicitado: userId ${userId}, id ${withdrawal.id}`);
    await enqueueWithdrawalProcessing(withdrawal.id);

    return {
      success: true,
      withdrawalId: withdrawal.id,
      netAmount,
      fee,
      status: 'REQUESTED',
    };
  } catch (error) {
    logger.error(`Erro ao criar saque bancário para ${userId}`, error);
    return { success: false, message: 'Falha ao processar saque.' };
  }
}

// ==============================
// RESERVA DE COMISSÃO POR VALOR
// ==============================

/**
 * Reserva comissões AVAILABLE de um usuário até atingir o valor especificado.
 * Atualiza apenas os registros necessários, ordenados por createdAt.
 */
async function reserveCommissionByAmount(tx: any, userId: number, amount: number): Promise<void> {
  const target = new Decimal(amount);
  let accumulated = new Decimal(0);

  // Busca comissões disponíveis ordenadas pela criação
  const commissions = await tx.affiliateCommission.findMany({
    where: { userId, status: 'AVAILABLE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, amount: true },
  });

  const idsToReserve: number[] = [];

  for (const comm of commissions) {
    if (accumulated.greaterThanOrEqualTo(target)) break;
    idsToReserve.push(comm.id);
    accumulated = accumulated.plus(comm.amount);
  }

  // Se a soma das selecionadas for menor que o valor, não há saldo suficiente
  if (accumulated.lessThan(target)) {
    throw new Error('Saldo de comissões insuficiente para reserva');
  }

  // Atualiza apenas os IDs selecionados para RESERVED
  await tx.affiliateCommission.updateMany({
    where: { id: { in: idsToReserve }, status: 'AVAILABLE' },
    data: { status: 'RESERVED' },
  });
}

// ==============================
// PROCESSAMENTO DO SAQUE (PAGAMENTO)
// ==============================

export async function processWithdrawal(withdrawalId: number): Promise<void> {
  const wd = await prisma.withdrawal.findUnique({
    where: { id: withdrawalId },
    include: { user: true },
  });

  if (!wd || wd.status !== 'REQUESTED') {
    logger.warn(`Saque ${withdrawalId} não está em estado REQUESTED`);
    return;
  }

  await prisma.withdrawal.update({
    where: { id: wd.id },
    data: { status: 'PROCESSING', updatedAt: new Date() },
  });

  try {
    const payoutResult = await sendPayout({
      method: wd.method,
      amount: wd.netAmount.toNumber(),
      pixKey: wd.pixKey,
      bankData: wd.bankData,
      externalId: wd.id.toString(),
    });

    await prisma.$transaction(async (tx) => {
      await tx.withdrawal.update({
        where: { id: wd.id },
        data: {
          status: 'PAID',
          providerId: payoutResult.providerId,
          processedAt: new Date(),
          updatedAt: new Date(),
        },
      });

      // Marcar comissões RESERVED do usuário como PAID
      await tx.affiliateCommission.updateMany({
        where: { userId: wd.userId, status: 'RESERVED' },
        data: { status: 'PAID' },
      });
    });

    logger.info(`Saque ${wd.id} pago com sucesso`);
  } catch (error) {
    logger.error(`Falha no pagamento do saque ${wd.id}`, error);
    await prisma.$transaction(async (tx) => {
      await tx.withdrawal.update({
        where: { id: wd.id },
        data: { status: 'REJECTED', reason: error.message, updatedAt: new Date() },
      });

      // Devolver comissões RESERVED para AVAILABLE
      await tx.affiliateCommission.updateMany({
        where: { userId: wd.userId, status: 'RESERVED' },
        data: { status: 'AVAILABLE' },
      });
    });
  }
}

// ==============================
// FUNÇÕES AUXILIARES
// ==============================

function calculateFee(amount: number, config: any): number {
  let fee = 0;
  if (config.withdrawalFeeFixed) {
    fee += config.withdrawalFeeFixed;
  }
  if (config.withdrawalFeePercent) {
    fee += (amount * config.withdrawalFeePercent) / 100;
  }
  return Math.round(fee * 100) / 100;
}

async function getAvailableCommission(userId: number): Promise<Decimal> {
  const result = await prisma.affiliateCommission.aggregate({
    where: { userId, status: 'AVAILABLE' },
    _sum: { amount: true },
  });
  return result._sum.amount || new Decimal(0);
}

async function enqueueWithdrawalProcessing(withdrawalId: number): Promise<void> {
  const { reconciliationQueue } = await import('../queues');
  await reconciliationQueue.add(
    { type: 'process_withdrawal', withdrawalId },
    { jobId: `withdrawal-${withdrawalId}`, removeOnComplete: true }
  );
  logger.info(`Saque ${withdrawalId} enfileirado para processamento`);
}
