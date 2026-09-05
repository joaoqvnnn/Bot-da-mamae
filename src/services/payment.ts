// src/services/payment.ts
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { getSettings } from '../config/settings';
import { Decimal } from '@prisma/client/runtime/library';
import axios, { AxiosResponse } from 'axios';

// ==============================
// TIPOS E INTERFACES
// ==============================

export interface PixPaymentResponse {
  paymentId: number;
  qrCodeBase64?: string;
  qrCodeText?: string; // será igual a copiaCola
  copiaCola: string;
  expiresAt: Date;
  amount: number;
  bonus: number;
}

// ==============================
// CRIAÇÃO DE PAGAMENTO PIX
// ==============================

export async function createPixPayment(userId: number, amount: number): Promise<PixPaymentResponse> {
  const settings = await getSettings();

  // Validar valor mínimo e máximo
  if (amount < settings.pix.minValue) {
    throw new Error(`Valor mínimo é R$ ${settings.pix.minValue.toFixed(2)}`);
  }
  if (amount > settings.pix.maxValue) {
    throw new Error(`Valor máximo é R$ ${settings.pix.maxValue.toFixed(2)}`);
  }

  // Calcular bônus
  const bonus = calculateBonus(amount, settings);

  // Criar registro no banco (status CREATED)
  const payment = await prisma.payment.create({
    data: {
      userId,
      amount: new Decimal(amount),
      bonus: new Decimal(bonus),
      status: 'CREATED',
      expiresAt: new Date(Date.now() + settings.pix.expiresMinutes * 60 * 1000),
    },
  });

  // Chamar API do Mercado Pago para criar Pix
  try {
    const mpResponse: MercadoPagoPixResponse = await callMercadoPagoCreatePix(payment.id, amount, settings);

    // Atualizar registro com dados do provider
    const updatedPayment = await prisma.payment.update({
      where: { id: payment.id },
      data: {
        providerPaymentId: mpResponse.id.toString(),
        qrCode: mpResponse.qr_code_base64 || null,
        copiaCola: mpResponse.qr_code,
        status: 'PENDING',
        expiresAt: mpResponse.date_of_expiration
          ? new Date(mpResponse.date_of_expiration)
          : new Date(Date.now() + settings.pix.expiresMinutes * 60 * 1000),
      },
    });

    logger.info(`Pix criado para usuário ${userId}: ${updatedPayment.id}, valor ${amount}`);

    return {
      paymentId: updatedPayment.id,
      qrCodeBase64: updatedPayment.qrCode || undefined,
      copiaCola: updatedPayment.copiaCola || '',
      expiresAt: updatedPayment.expiresAt!,
      amount,
      bonus,
    };
  } catch (error) {
    // Marcar como cancelado
    await prisma.payment.update({
      where: { id: payment.id },
      data: { status: 'CANCELLED' },
    });
    logger.error(`Falha ao criar Pix no Mercado Pago para payment ${payment.id}`, error);
    throw new Error('Falha ao gerar Pix. Tente novamente.');
  }
}

// ==============================
// WEBHOOK DO MERCADO PAGO
// ==============================

export async function processWebhook(payload: any): Promise<boolean> {
  const settings = await getSettings();

  // Validar assinatura se configurado
  if (settings.mercadoPago.webhookSecret) {
    // Implementar verificação HMAC conforme documentação
    // Por enquanto, apenas registra
    logger.info('Webhook recebido com assinatura (não verificada)');
  }

  const paymentProviderId = payload.data?.id;
  if (!paymentProviderId) {
    logger.warn('Webhook recebido sem payment id');
    return false;
  }

  // Buscar pagamento no banco
  const payment = await prisma.payment.findUnique({
    where: { providerPaymentId: paymentProviderId.toString() },
  });

  if (!payment) {
    logger.warn(`Pagamento ${paymentProviderId} não encontrado no banco`);
    return false;
  }

  // Idempotência: se já aprovado, ignora
  if (payment.status === 'APPROVED') {
    logger.info(`Pagamento ${payment.id} já processado`);
    return true;
  }

  // Consultar status no Mercado Pago
  try {
    const mpStatus = await getPaymentStatusFromProvider(paymentProviderId, settings);

    await prisma.paymentEvent.create({
      data: {
        paymentId: payment.id,
        type: 'webhook',
        payload,
        status: mapMpStatusToInternal(mpStatus),
      },
    });

    if (mpStatus === 'approved') {
      await approvePayment(payment.id);
      return true;
    } else if (mpStatus === 'rejected') {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'REJECTED' },
      });
      return true;
    } else if (mpStatus === 'cancelled') {
      await prisma.payment.update({
        where: { id: payment.id },
        data: { status: 'CANCELLED' },
      });
      return true;
    } else {
      // Mantém pending
      return true;
    }
  } catch (error) {
    logger.error(`Erro ao processar webhook para pagamento ${payment.id}`, error);
    return false;
  }
}

// ==============================
// APROVAÇÃO DE PAGAMENTO
// ==============================

export async function approvePayment(paymentId: number): Promise<void> {
  const result = await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({
      where: { id: paymentId },
    });

    if (!payment) throw new Error('Pagamento não encontrado');
    if (payment.status === 'APPROVED') return null; // já aprovado
    if (payment.status !== 'PENDING' && payment.status !== 'CREATED') {
      throw new Error(`Estado inválido: ${payment.status}`);
    }

    await tx.payment.update({
      where: { id: paymentId },
      data: {
        status: 'APPROVED',
        paidAt: new Date(),
      },
    });

    const wallet = await tx.wallet.findUnique({
      where: { userId: payment.userId },
    });

    if (!wallet) throw new Error('Carteira não encontrada');

    // Converter para Decimal
    const amountDec = payment.amount;
    const bonusDec = payment.bonus;
    const newBalance = wallet.balance.plus(amountDec).plus(bonusDec);

    await tx.wallet.update({
      where: { id: wallet.id },
      data: { balance: newBalance },
    });

    // Transação de recarga
    await tx.walletTransaction.create({
      data: {
        walletId: wallet.id,
        type: 'RECHARGE',
        amount: amountDec,
        balanceAfter: newBalance,
        description: 'Recarga via Pix',
        paymentId: payment.id,
        referenceId: payment.providerPaymentId,
      },
    });

    // Transação de bônus (se houver)
    if (bonusDec.greaterThan(0)) {
      await tx.walletTransaction.create({
        data: {
          walletId: wallet.id,
          type: 'BONUS',
          amount: bonusDec,
          balanceAfter: newBalance,
          description: 'Bônus de recarga',
          paymentId: payment.id,
        },
      });
    }

    return {
      userId: payment.userId,
      amount: amountDec.toNumber(),
      bonus: bonusDec.toNumber(),
    };
  });

  if (result) {
    logger.info(
      `Pagamento ${paymentId} aprovado, crédito de ${result.amount + result.bonus} para usuário ${result.userId}`
    );
    // Aqui pode enfileirar notificação
  }
}

// ==============================
// RECONCILIAÇÃO
// ==============================

export async function reconcilePendingPayments(): Promise<void> {
  const settings = await getSettings();

  const pendingPayments = await prisma.payment.findMany({
    where: {
      status: 'PENDING',
      OR: [{ expiresAt: { gte: new Date() } }, { expiresAt: null }],
    },
    take: 100,
  });

  for (const payment of pendingPayments) {
    if (!payment.providerPaymentId) continue;

    try {
      const mpStatus = await getPaymentStatusFromProvider(Number(payment.providerPaymentId), settings);

      if (mpStatus === 'approved') {
        await approvePayment(payment.id);
      } else if (mpStatus === 'rejected') {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'REJECTED' },
        });
      } else if (mpStatus === 'cancelled') {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'CANCELLED' },
        });
      } else if (mpStatus === 'pending' && payment.expiresAt && payment.expiresAt < new Date()) {
        await prisma.payment.update({
          where: { id: payment.id },
          data: { status: 'EXPIRED' },
        });
      }
    } catch (error) {
      logger.error(`Erro ao reconciliar pagamento ${payment.id}`, error);
    }
  }
}

export async function expireOldPayments(): Promise<void> {
  const now = new Date();
  const expired = await prisma.payment.updateMany({
    where: {
      status: 'PENDING',
      expiresAt: { lt: now },
    },
    data: { status: 'EXPIRED' },
  });

  if (expired.count > 0) {
    logger.info(`${expired.count} pagamentos expirados`);
  }
}

// ==============================
// FUNÇÕES AUXILIARES
// ==============================

function calculateBonus(amount: number, settings: any): number {
  if (!settings.bonus.active) return 0;
  if (amount < settings.bonus.minValue) return 0;
  if (settings.bonus.maxValue && amount > settings.bonus.maxValue) {
    amount = settings.bonus.maxValue;
  }
  return Math.round((amount * settings.bonus.percent) / 100 * 100) / 100;
}

// Tipos para resposta do Mercado Pago
interface MercadoPagoPixResponse {
  id: number;
  status: string;
  qr_code: string;
  qr_code_base64: string;
  date_of_expiration?: string;
}

async function callMercadoPagoCreatePix(
  internalId: number,
  amount: number,
  settings: any
): Promise<MercadoPagoPixResponse> {
  const response: AxiosResponse<MercadoPagoPixResponse> = await axios.post(
    'https://api.mercadopago.com/v1/payments',
    {
      transaction_amount: amount,
      description: `Recarga Larizinha Store #${internalId}`,
      payment_method_id: 'pix',
      payer: {
        email: 'cliente@exemplo.com', // idealmente e-mail do usuário
      },
      notification_url: `${process.env.PUBLIC_BASE_URL}${process.env.WEBHOOK_MERCADO_PAGO_PATH || '/webhooks/mercadopago'}`,
    },
    {
      headers: {
        Authorization: `Bearer ${settings.mercadoPago.accessToken}`,
        'Content-Type': 'application/json',
      },
      timeout: 15000,
    }
  );

  if (response.data && response.data.id) {
    return response.data;
  } else {
    throw new Error('Resposta inválida do Mercado Pago');
  }
}

async function getPaymentStatusFromProvider(providerPaymentId: number, settings: any): Promise<string> {
  const response: AxiosResponse<any> = await axios.get(
    `https://api.mercadopago.com/v1/payments/${providerPaymentId}`,
    {
      headers: {
        Authorization: `Bearer ${settings.mercadoPago.accessToken}`,
      },
      timeout: 10000,
    }
  );

  return response.data?.status || 'unknown';
}

function mapMpStatusToInternal(mpStatus: string): string {
  switch (mpStatus) {
    case 'approved':
      return 'APPROVED';
    case 'rejected':
      return 'REJECTED';
    case 'pending':
      return 'PENDING';
    case 'cancelled':
      return 'CANCELLED';
    default:
      return 'CREATED';
  }
}

export async function generatePixForUser(userId: number, amount: number): Promise<PixPaymentResponse> {
  return createPixPayment(userId, amount);
}
