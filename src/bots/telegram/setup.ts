// src/bots/telegram/setup.ts
import { Telegraf, Context, Markup } from 'telegraf';
import { prisma } from '../../database/prisma';
import { getSettings } from '../../config/settings';
import { getMessage, getMessagesByScreen, getButtonsByScreen, formatMessageText, buildInlineKeyboard } from '../../config/messages';
import { isMaintenanceActive, getMaintenanceMessage } from '../../services/maintenance';
import { logger } from '../../utils/logger';

// Armazenamento temporário de contextos para callbacks (pode ser Redis depois)
const callbackContextStore = new Map<string, Record<string, any>>();

/**
 * Configura todos os handlers do bot Telegram.
 * @param bot instância do Telegraf
 */
export async function setupTelegramBot(bot: Telegraf) {
  // ============ MIDDLEWARE GLOBAL ============
  // Verifica manutenção antes de processar qualquer atualização
  bot.use(async (ctx, next) => {
    if (await isMaintenanceActive()) {
      const userId = ctx.from?.id;
      const settings = await getSettings();
      const isAdmin = settings.adminIds.includes(userId) || userId === settings.ownerId;
      if (!isAdmin) {
        const maintenanceMsg = await getMaintenanceMessage();
        await ctx.reply(maintenanceMsg);
        return;
      }
    }
    return next();
  });

  // Middleware para carregar ou criar usuário no banco
  bot.use(async (ctx, next) => {
    if (ctx.from) {
      const telegramId = ctx.from.id;
      let user = await prisma.user.findUnique({ where: { telegramId } });
      if (!user) {
        user = await prisma.user.create({
          data: {
            telegramId,
            username: ctx.from.username || null,
            firstName: ctx.from.first_name || null,
            lastName: ctx.from.last_name || null,
            languageCode: ctx.from.language_code || null,
            isPremium: ctx.from.is_premium || false,
            isSubscribed: false, // será atualizado após verificação de inscrição
          },
        });
        // Criar carteira para o usuário
        await prisma.wallet.create({ data: { userId: user.id, balance: 0 } });
      }
      // Salvar sessão simples (pode-se usar tabela Session, mas por ora é apenas para contexto)
      (ctx as any).user = user;
      (ctx as any).wallet = await prisma.wallet.findUnique({ where: { userId: user.id } });
    }
    return next();
  });

  // ============ COMANDOS ============
  bot.command('start', handleStart);
  bot.command('cancelar', handleCancel);

  // ============ CALLBACK QUERY ============
  bot.on('callback_query', handleCallbackQuery);

  // ============ MENSAGENS DE TEXTO (para captura de entrada) ============
  bot.on('text', handleTextMessage);

  logger.info('Handlers do Telegram configurados');
}

// ============ HANDLER: /start ============
async function handleStart(ctx: Context) {
  const user = (ctx as any).user;
  const wallet = (ctx as any).wallet;

  // Verificar se usuário está inscrito no canal obrigatório
  // (a implementação real deve checar via API do Telegram se é membro do canal)
  // Por enquanto, apenas verificar o campo isSubscribed no banco.
  if (!user.isSubscribed) {
    const subMsg = await getMessage('subscription_required');
    if (subMsg) {
      const text = formatMessageText(subMsg.text, {
        nome_loja: (await getSettings()).storeName,
      });
      const buttons = await buildInlineKeyboard('subscription_required');
      await ctx.reply(text, buttons ? { reply_markup: { inline_keyboard: buttons } } : {});
    } else {
      await ctx.reply('📢 Antes de começar, inscreva-se no canal oficial.');
    }
    return;
  }

  // Se inscrito, mostrar menu principal
  await showMainMenu(ctx);
}

// ============ HANDLER: /cancelar ============
async function handleCancel(ctx: Context) {
  const user = (ctx as any).user;
  // Limpar estado de entrada se houver
  await prisma.inputState.deleteMany({ where: { userId: user.id } });
  await ctx.reply('✅ Ação cancelada.');
  await showMainMenu(ctx);
}

// ============ HANDLER: callback_query ============
async function handleCallbackQuery(ctx: Context) {
  const callbackQuery = (ctx as any).callbackQuery;
  if (!callbackQuery) return;

  const data = callbackQuery.data;
  const userId = ctx.from?.id;

  // Extrair ação (o callback_data agora é apenas a ação)
  // Se precisarmos de contexto, usaremos um mapa temporário, mas por enquanto só ação.
  const action = data;

  // Verificar manutenção (novamente por segurança)
  if (await isMaintenanceActive()) {
    const settings = await getSettings();
    const isAdmin = settings.adminIds.includes(userId) || userId === settings.ownerId;
    if (!isAdmin) {
      await ctx.answerCbQuery('Sistema em manutenção');
      return;
    }
  }

  // Redirecionar para o handler adequado conforme ação
  switch (action) {
    case 'back_to_main':
      await showMainMenu(ctx);
      break;
    case 'catalog':
      await showCatalog(ctx);
      break;
    case 'profile':
      await showProfile(ctx);
      break;
    case 'recharge':
      await showRecharge(ctx);
      break;
    case 'affiliates':
      await showAffiliates(ctx);
      break;
    case 'support':
      await showSupport(ctx);
      break;
    case 'about':
      await showAbout(ctx);
      break;
    case 'search':
      await showSearchPrompt(ctx);
      break;
    case 'gift_card':
      await showGiftCard(ctx);
      break;
    case 'alerts':
      await showAlerts(ctx);
      break;
    // Adicione outros conforme necessário
    default:
      await ctx.answerCbQuery('Ação não reconhecida');
      logger.warn(`Ação de callback desconhecida: ${action}`);
  }
}

// ============ HANDLER: mensagens de texto ============
async function handleTextMessage(ctx: Context) {
  const user = (ctx as any).user;
  const text = (ctx as any).message?.text;

  if (!text) return;

  // Verificar se existe estado de entrada ativo
  const inputState = await prisma.inputState.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: 'desc' },
  });

  if (inputState) {
    // Processar de acordo com o tipo de estado
    // (a implementação completa será em um serviço separado)
    await processInputState(ctx, inputState, text);
  } else {
    // Sem estado de entrada, talvez comando não reconhecido
    // Podemos ignorar ou mandar menu principal
    await showMainMenu(ctx);
  }
}

// ============ FUNÇÕES DE NAVEGAÇÃO (exemplos) ============
async function showMainMenu(ctx: Context) {
  const user = (ctx as any).user;
  const wallet = (ctx as any).wallet;

  const startMsg = await getMessage('start');
  if (!startMsg) {
    await ctx.reply('Menu principal indisponível.');
    return;
  }

  const settings = await getSettings();
  const text = formatMessageText(startMsg.text, {
    nome_loja: settings.storeName,
    telegram_id: user.telegramId.toString(),
    saldo: wallet ? wallet.balance.toFixed(2) : '0.00',
  });

  const buttons = await buildInlineKeyboard('main_menu');
  const replyMarkup = buttons ? { inline_keyboard: buttons } : undefined;

  // Se houver uma mensagem anterior do bot, editar; caso contrário, enviar nova
  if ((ctx as any).callbackQuery) {
    await ctx.editMessageText(text, replyMarkup ? { reply_markup: replyMarkup } : {});
  } else {
    await ctx.reply(text, replyMarkup ? { reply_markup: replyMarkup } : {});
  }
}

async function showCatalog(ctx: Context) {
  const catalogMsg = await getMessage('catalog');
  if (!catalogMsg) {
    await ctx.reply('Catálogo indisponível.');
    return;
  }

  const settings = await getSettings();
  const text = formatMessageText(catalogMsg.text, {
    nome_loja: settings.storeName,
  });

  const buttons = await buildInlineKeyboard('catalog');
  const replyMarkup = buttons ? { inline_keyboard: buttons } : undefined;

  await ctx.editMessageText(text, replyMarkup ? { reply_markup: replyMarkup } : {});
}

async function showProfile(ctx: Context) {
  // Implementar perfil (por enquanto, esboço)
  const user = (ctx as any).user;
  const wallet = (ctx as any).wallet;

  const text = `👤 MEU PERFIL\n🆔 ID: ${user.telegramId}\n💰 Saldo: R$ ${wallet.balance.toFixed(2)}`;
  const buttons = await buildInlineKeyboard('profile');
  await ctx.editMessageText(text, buttons ? { reply_markup: { inline_keyboard: buttons } } : {});
}

async function showRecharge(ctx: Context) {
  // Implementar recarga (Pix) em arquivo separado
  await ctx.editMessageText('💰 Recarregar Saldo\nDigite /pix [valor] ou use os botões.');
}

async function showAffiliates(ctx: Context) {
  // Implementar afiliados
  await ctx.editMessageText('🤝 Programa de Afiliados');
}

async function showSupport(ctx: Context) {
  // Implementar atendimento
  await ctx.editMessageText('🎧 Atendimento');
}

async function showAbout(ctx: Context) {
  // Implementar sobre
  await ctx.editMessageText('ℹ️ Sobre o Bot');
}

async function showSearchPrompt(ctx: Context) {
  await ctx.editMessageText('🔎 Digite o serviço que deseja pesquisar:');
  // Criar estado de entrada para pesquisa
  const user = (ctx as any).user;
  await prisma.inputState.create({
    data: {
      userId: user.id,
      type: 'WAITING_FOR_SEARCH',
    },
  });
}

async function showGiftCard(ctx: Context) {
  await ctx.editMessageText('🎁 Digite o código do Gift Card:');
  const user = (ctx as any).user;
  await prisma.inputState.create({
    data: {
      userId: user.id,
      type: 'WAITING_FOR_GIFT_CARD',
    },
  });
}

async function showAlerts(ctx: Context) {
  // Implementar alertas
  await ctx.editMessageText('🔔 Alertas de estoque');
}

// ============ PROCESSAMENTO DE ENTRADA (esboço) ============
async function processInputState(ctx: Context, inputState: any, text: string) {
  // Dependendo do tipo, processar
  switch (inputState.type) {
    case 'WAITING_FOR_SEARCH':
      // Implementar busca
      await ctx.reply(`🔎 Resultados para "${text}"`);
      break;
    case 'WAITING_FOR_GIFT_CARD':
      // Implementar resgate de gift card
      await ctx.reply('Processando gift card...');
      break;
    // Outros tipos...
    default:
      await ctx.reply('Entrada não reconhecida.');
  }
  // Limpar estado
  await prisma.inputState.delete({ where: { id: inputState.id } });
}

// ============ FUNÇÃO PARA ARMAZENAR CONTEXTO TEMPORÁRIO (para callbacks com dados) ============
export function storeCallbackContext(key: string, data: Record<string, any>) {
  callbackContextStore.set(key, data);
  // Definir timeout para limpar automaticamente (ex: 10 minutos)
  setTimeout(() => callbackContextStore.delete(key), 10 * 60 * 1000);
}

export function getCallbackContext(key: string) {
  return callbackContextStore.get(key);
}
