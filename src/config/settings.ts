// src/config/settings.ts
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';

// Tipos para configurações
export interface BotSettings {
  storeName: string;
  timezone: string;
  currency: string;
  maintenance: {
    isActive: boolean;
    message: string;
    onlineMessage: string;
  };
  bonus: {
    active: boolean;
    percent: number;
    minValue: number;
    maxValue?: number | null;
  };
  affiliate: {
    commissionPercent: number;
    minWithdrawal: number;
    withdrawalFeeFixed: number;
    withdrawalFeePercent: number;
  };
  pix: {
    expiresMinutes: number;
    minValue: number;
    maxValue: number;
  };
  rateLimit: {
    maxMessages: number;
    windowSeconds: number;
    blockMinutes: number;
    escalationSteps: number[];
  };
  channels: {
    telegramChannelId?: string | null;
    telegramChannelLink?: string | null;
  };
  smtp: {
    host: string;
    port: number;
    secure: boolean;
    user: string;
    pass: string;
    from: string;
  };
  whatsapp: {
    apiUrl: string;
    phoneNumberId: string;
    accessToken: string;
    verifyToken: string;
    businessAccountId: string;
  };
  mercadoPago: {
    accessToken: string;
    publicKey: string;
    webhookSecret: string;
  };
  jwtSecret: string;
  adminIds: number[];
  ownerId: number;
}

// Cache em memória
let cachedSettings: BotSettings | null = null;

// Carrega configurações
export async function loadSettings(): Promise<BotSettings> {
  if (cachedSettings) return cachedSettings;

  const dbSettings = await prisma.setting.findMany();
  const settingsMap = new Map(dbSettings.map((s) => [s.key, s.value]));

  const maintenance = await prisma.maintenanceState.findFirst({
    orderBy: { id: 'desc' },
  });

  const settings: BotSettings = {
    storeName: (settingsMap.get('storeName') as string) || 'Larizinha Store',
    timezone: (settingsMap.get('timezone') as string) || process.env.DEFAULT_TIMEZONE || 'America/Sao_Paulo',
    currency: (settingsMap.get('currency') as string) || process.env.DEFAULT_CURRENCY || 'BRL',
    maintenance: {
      isActive: maintenance?.isActive ?? false,
      message: maintenance?.message || '🔧 Bot em manutenção. Tente novamente mais tarde.',
      onlineMessage: maintenance?.onlineMessage || '🟢 Bot online novamente!',
    },
    bonus: {
      active: (settingsMap.get('bonusActive') as boolean) ?? process.env.BONUS_ACTIVE === 'true',
      percent: Number(settingsMap.get('bonusPercent') || process.env.BONUS_PERCENT || 10),
      minValue: Number(settingsMap.get('bonusMinValue') || process.env.BONUS_MIN_VALUE || 10),
      maxValue: settingsMap.get('bonusMaxValue') ? Number(settingsMap.get('bonusMaxValue')) : process.env.BONUS_MAX_VALUE ? Number(process.env.BONUS_MAX_VALUE) : null,
    },
    affiliate: {
      commissionPercent: Number(settingsMap.get('affiliateCommissionPercent') || process.env.AFFILIATE_COMMISSION_PERCENT || 20),
      minWithdrawal: Number(settingsMap.get('affiliateMinWithdrawal') || process.env.AFFILIATE_MIN_WITHDRAWAL || 20),
      withdrawalFeeFixed: Number(settingsMap.get('affiliateWithdrawalFeeFixed') || process.env.AFFILIATE_WITHDRAWAL_FEE_FIXED || 2),
      withdrawalFeePercent: Number(settingsMap.get('affiliateWithdrawalFeePercent') || process.env.AFFILIATE_WITHDRAWAL_FEE_PERCENT || 0),
    },
    pix: {
      expiresMinutes: Number(settingsMap.get('pixExpiresMinutes') || process.env.PIX_DEFAULT_EXPIRES_MINUTES || 10),
      minValue: Number(settingsMap.get('pixMinValue') || process.env.PIX_MIN_VALUE || 1),
      maxValue: Number(settingsMap.get('pixMaxValue') || process.env.PIX_MAX_VALUE || 1000),
    },
    rateLimit: {
      maxMessages: Number(settingsMap.get('rateLimitMaxMessages') || process.env.RATE_LIMIT_MAX_MESSAGES || 10),
      windowSeconds: Number(settingsMap.get('rateLimitWindowSeconds') || process.env.RATE_LIMIT_WINDOW_SECONDS || 5),
      blockMinutes: Number(settingsMap.get('rateLimitBlockMinutes') || process.env.RATE_LIMIT_BLOCK_MINUTES || 10),
      escalationSteps: parseEscalationSteps(settingsMap.get('rateLimitEscalationSteps') as string || process.env.RATE_LIMIT_ESCALATION_STEPS || '10,30,120,1440,0'),
    },
    channels: {
      telegramChannelId: process.env.TELEGRAM_CHANNEL_ID,
      telegramChannelLink: process.env.TELEGRAM_CHANNEL_LINK,
    },
    smtp: {
      host: process.env.SMTP_HOST || '',
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === 'true',
      user: process.env.SMTP_USER || '',
      pass: process.env.SMTP_PASS || '',
      from: process.env.EMAIL_FROM || 'Larizinha Store <no-reply@exemplo.com>',
    },
    whatsapp: {
      apiUrl: process.env.WHATSAPP_API_URL || 'https://graph.facebook.com/v19.0',
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID || '',
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN || '',
      verifyToken: process.env.WHATSAPP_VERIFY_TOKEN || '',
      businessAccountId: process.env.WHATSAPP_BUSINESS_ACCOUNT_ID || '',
    },
    mercadoPago: {
      accessToken: process.env.BOT_MODE === 'test' ? (process.env.MERCADO_PAGO_ACCESS_TOKEN_TEST || '') : (process.env.MERCADO_PAGO_ACCESS_TOKEN || ''),
      publicKey: process.env.MERCADO_PAGO_PUBLIC_KEY || '',
      webhookSecret: process.env.MERCADO_PAGO_WEBHOOK_SECRET || '',
    },
    jwtSecret: process.env.JWT_SECRET || 'default-secret',
    adminIds: (process.env.ADMIN_TELEGRAM_IDS || '').split(',').map(Number).filter(Boolean),
    ownerId: Number(process.env.OWNER_TELEGRAM_ID || 0),
  };

  cachedSettings = settings;
  return settings;
}

export function invalidateSettingsCache() {
  cachedSettings = null;
}

export async function updateSetting(key: string, value: unknown) {
  await prisma.setting.upsert({
    where: { key },
    update: { value: value as any },
    create: { key, value: value as any },
  });
  invalidateSettingsCache();
  logger.info(`Configuração atualizada: ${key}`);
}

export async function updateMaintenance(isActive: boolean, message?: string, onlineMessage?: string) {
  const current = await prisma.maintenanceState.findFirst({ orderBy: { id: 'desc' } });
  if (current) {
    await prisma.maintenanceState.update({
      where: { id: current.id },
      data: {
        isActive,
        message: message || current.message,
        onlineMessage: onlineMessage || current.onlineMessage,
        updatedAt: new Date(),
      },
    });
  } else {
    await prisma.maintenanceState.create({
      data: {
        isActive,
        message: message || '🔧 Bot em manutenção. Tente novamente mais tarde.',
        onlineMessage: onlineMessage || '🟢 Bot online novamente!',
      },
    });
  }
  invalidateSettingsCache();
  logger.info(`Manutenção ${isActive ? 'ativada' : 'desativada'}`);
}

function parseEscalationSteps(input: string): number[] {
  return input
    .split(',')
    .map((s) => Number(s.trim()))
    .filter((n) => !isNaN(n) && n >= 0);
}

export async function getSettings(): Promise<BotSettings> {
  return loadSettings();
}
