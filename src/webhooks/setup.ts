// src/webhooks/setup.ts
import { Express, Request, Response } from 'express';
import { prisma } from '../database/prisma';
import { logger } from '../utils/logger';
import { getSettings } from '../config/settings';
import { processWebhook as processMercadoPagoWebhook } from '../services/payment';
import { processWhatsAppWebhook } from '../services/whatsappWebhook'; // a ser implementado
import { verifyActivationToken, activateProductWithPassword } from '../services/activation';
import { createBankWithdrawal } from '../services/withdrawal';

/**
 * Configura todos os webhooks e endpoints web do sistema.
 * @param app instância do Express
 */
export function setupWebhooks(app: Express): void {
  // ==============================
  // WEBHOOK DO MERCADO PAGO
  // ==============================

  app.post(
    process.env.WEBHOOK_MERCADO_PAGO_PATH || '/webhooks/mercadopago',
    async (req: Request, res: Response) => {
      try {
        logger.info('Webhook Mercado Pago recebido', { body: req.body });
        const success = await processMercadoPagoWebhook(req.body);
        if (success) {
          res.status(200).send('OK');
        } else {
          // Responde 200 para evitar retries, mas registra erro
          res.status(200).send('IGNORED');
        }
      } catch (error) {
        logger.error('Erro no webhook do Mercado Pago', error);
        res.status(500).send('ERROR');
      }
    }
  );

  // ==============================
  // WEBHOOK DO WHATSAPP BUSINESS API
  // ==============================

  // GET para verificação do webhook (desafio)
  app.get(
    process.env.WEBHOOK_WHATSAPP_PATH || '/webhooks/whatsapp',
    async (req: Request, res: Response) => {
      const mode = req.query['hub.mode'];
      const token = req.query['hub.verify_token'];
      const challenge = req.query['hub.challenge'];

      const settings = await getSettings();
      const verifyToken = settings.whatsapp.verifyToken;

      if (mode === 'subscribe' && token === verifyToken) {
        logger.info('Webhook WhatsApp verificado com sucesso');
        res.status(200).send(challenge);
      } else {
        logger.warn('Tentativa de verificação do webhook WhatsApp falhou');
        res.sendStatus(403);
      }
    }
  );

  // POST para receber eventos do WhatsApp
  app.post(
    process.env.WEBHOOK_WHATSAPP_PATH || '/webhooks/whatsapp',
    async (req: Request, res: Response) => {
      try {
        logger.info('Webhook WhatsApp recebido', { body: req.body });
        await processWhatsAppWebhook(req.body);
        res.status(200).send('OK');
      } catch (error) {
        logger.error('Erro no webhook do WhatsApp', error);
        res.status(500).send('ERROR');
      }
    }
  );

  // ==============================
  // PÁGINAS WEB (ATIVAÇÃO, SAQUE BANCÁRIO, HISTÓRICO, TERMOS)
  // ==============================

  // Rota para ativação de produto via link seguro
  app.get('/ativar/:token', async (req: Request, res: Response) => {
    try {
      const token = req.params.token;
      const tokenData = await verifyActivationToken(token);
      if (!tokenData) {
        return res.status(400).send('Link inválido ou expirado.');
      }

      // Renderizar página HTML com formulário de senha
      res.send(`
        <!DOCTYPE html>
        <html>
        <head><title>Ativar Produto</title></head>
        <body>
          <h1>🔐 Ativar produto</h1>
          <form action="/ativar/${token}" method="POST">
            <label for="senha">Digite sua senha:</label>
            <input type="password" id="senha" name="senha" required>
            <button type="submit">Enviar</button>
          </form>
        </body>
        </html>
      `);
    } catch (error) {
      logger.error('Erro na rota de ativação', error);
      res.status(500).send('Erro interno.');
    }
  });

  app.post('/ativar/:token', async (req: Request, res: Response) => {
    try {
      const token = req.params.token;
      const senha = req.body.senha;

      const result = await activateProductWithPassword(token, senha);
      if (result.success) {
        // Exibe os dados do produto
        res.send(`
          <!DOCTYPE html>
          <html>
          <head><title>Produto Ativado</title></head>
          <body>
            <h1>✅ Produto confirmado!</h1>
            <p><strong>Login:</strong> ${result.login}</p>
            <p><strong>Senha:</strong> ${result.senha}</p>
          </body>
          </html>
        `);
      } else {
        res.status(401).send('Senha incorreta. Tente novamente.');
      }
    } catch (error) {
      logger.error('Erro na ativação POST', error);
      res.status(500).send('Erro interno.');
    }
  });

  // Rota para saque bancário (página para inserir dados bancários)
  app.get('/saque-bancario', async (req: Request, res: Response) => {
    // Página simples com formulário; poderia ser mais elaborada
    res.send(`
      <!DOCTYPE html>
      <html>
      <head><title>Saque Bancário</title></head>
      <body>
        <h1>🏦 Saque bancário</h1>
        <form action="/saque-bancario" method="POST">
          <label for="banco">Banco:</label>
          <input type="text" id="banco" name="banco" required><br>
          <label for="agencia">Agência:</label>
          <input type="text" id="agencia" name="agencia" required><br>
          <label for="conta">Conta:</label>
          <input type="text" id="conta" name="conta" required><br>
          <label for="digito">Dígito:</label>
          <input type="text" id="digito" name="digito" required><br>
          <label for="tipo">Tipo:</label>
          <select id="tipo" name="tipo">
            <option value="corrente">Corrente</option>
            <option value="poupanca">Poupança</option>
          </select><br>
          <label for="cpf_cnpj">CPF/CNPJ:</label>
          <input type="text" id="cpf_cnpj" name="cpf_cnpj" required><br>
          <button type="submit">Continuar</button>
        </form>
      </body>
      </html>
    `);
  });

  app.post('/saque-bancario', async (req: Request, res: Response) => {
    try {
      const { banco, agencia, conta, digito, tipo, cpf_cnpj } = req.body;
      const result = await createBankWithdrawal({
        bankCode: banco,
        agency: agencia,
        account: conta,
        digit: digito,
        type: tipo,
        cpfCnpj: cpf_cnpj,
      });
      res.status(200).json({ success: true, withdrawalId: result.id });
    } catch (error) {
      logger.error('Erro no saque bancário', error);
      res.status(500).send('Erro ao processar saque.');
    }
  });

  // Rota para histórico de saques (página simples)
  app.get('/historico-saques', async (req: Request, res: Response) => {
    // Buscar histórico do usuário autenticado (implementação futura)
    res.send('<h1>Histórico de Saques</h1><p>Em breve.</p>');
  });

  // Rota para termos e condições
  app.get('/termos', async (req: Request, res: Response) => {
    const settings = await getSettings();
    const termos = settings.terms || 'Termos não configurados.';
    res.send(`<pre>${termos}</pre>`);
  });

  logger.info('Rotas de webhook e páginas web configuradas');
}
