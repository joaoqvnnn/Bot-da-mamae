// src/services/withdrawal.ts
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { getSettings } from '../config/settings';
import { Decimal } from '@prisma/client/runtime/library';
import { compare } from 'bcrypt';
import { isValidPixKey, isValidCPF, isValidCNPJ } from './inputState';
import { sendPayout } from './payoutProvider';
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
  amount: number;
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

  // Validações bancárias
  if (!/^\d{1,3}$/.test(data.bankCode)) {
    return { success: false, message: 'Código do banco inválido.' };
  }
  if (!/^\d{1,4}$/.test(data.agency)) {
    return { success: false, message: 'Agência inválida.' };
  }
  if (!/^\d{3,12}$/.test(data.account)) {
    return { success: false, message: 'Conta inválida.' };
  }
  if (!/^\d{1,2}$/.test(data.digit)) {
    return { success: false, message: 'Dígito inválido.' };
  }
  if (data.type !== 'corrente' && data.type !== 'poupanca') {
    return { success: false, message: 'Tipo de conta inválido.' };
  }
  if (!isValidCPF(data.cpfCnpj) && !isValidCNPJ(data.cpfCnpj)) {
    return { success: false, message: 'CPF/CNPJ inválido.' };
  }

  const availableCommission = await getAvailableCommission(userId);
  if (availableCommission.lessThan(data.amount)) {
    return { success: false, message: 'Saldo de comissões insuficiente.' };
  }

  try {
    const withdrawal = await prisma.$transaction(async (tx) => {
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
// PROCESSAMENTO DO SAQUE (AJUSTADO PARA PENDING_APPROVAL)
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

  // Atualizar para PROCESSING
  await prisma.withdrawal.update({
    where: { id: wd.id },
    data: { status: 'PROCESSING', updatedAt: new Date() },
  });

  const payoutResult = await sendPayout({
    method: wd.method,
    amount: wd.netAmount.toNumber(),
    pixKey: wd.pixKey,
    bankData: wd.bankData,
    externalId: wd.id.toString(),
  });

  if (payoutResult.status === 'APPROVED') {
    // Pagamento automático confirmado
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

      await tx.affiliateCommission.updateMany({
        where: { userId: wd.userId, status: 'RESERVED' },
        data: { status: 'PAID' },
      });
    });

    logger.info(`Saque ${wd.id} pago automaticamente`);
  } else if (payoutResult.status === 'PENDING_APPROVAL') {
    // Volta para REQUESTED (ou poderia usar um status PENDING_APPROVAL)
    await prisma.withdrawal.update({
      where: { id: wd.id },
      data: { status: 'REQUESTED', updatedAt: new Date() },
    });
    logger.info(`Saque ${wd.id} aguardando aprovação manual`);
  } else {
    // Erro real no processamento automático
    await prisma.$transaction(async (tx) => {
      await tx.withdrawal.update({
        where: { id: wd.id },
        data: {
          status: 'REJECTED',
          reason: payoutResult.message || 'Falha no pagamento',
          updatedAt: new Date(),
        },
      });

      // Devolver comissões apenas se for erro real
      await tx.affiliateCommission.updateMany({
        where: { userId: wd.userId, status: 'RESERVED' },
        data: { status: 'AVAILABLE' },
      });
    });
    logger.error(`Saque ${wd.id} rejeitado: ${payoutResult.message}`);
  }
}

// ==============================
// RESERVA DE COMISSÃO POR VALOR (mantida)
// ==============================

async function reserveCommissionByAmount(tx: any, userId: number, amount: number): Promise<void> {
  const target = new Decimal(amount);
  let accumulated = new Decimal(0);

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

  if (accumulated.lessThan(target)) {
    throw new Error('Saldo de comissões insuficiente para reserva');
  }

  await tx.affiliateCommission.updateMany({
    where: { id: { in: idsToReserve }, status: 'AVAILABLE' },
    data: { status: 'RESERVED' },
  });
}

// ==============================
// FUNÇÕES AUXILIARES (mantidas)
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
