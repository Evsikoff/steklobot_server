import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express, { type Request } from 'express';
import { WebSocketServer, type WebSocket } from 'ws';
import { config } from '../config.js';
import { bus } from '../bus.js';
import * as db from '../db.js';
import * as tg from '../services/telegram.js';
import { handleUpdate, sendAsManager } from '../ingest.js';
import { cancelActive, orchestratorSnapshot } from '../orchestrator/index.js';
import { invalidatePriceCache, loadPriceList, priceListStatus } from '../services/priceList.js';
import { activeProvider, applyProvider, getProvider, isProviderId, providersOverview } from '../services/llm/index.js';
import { log, errorMessage } from '../logger.js';
import { checkPassword, clearSessionCookie, isAuthenticated, issueToken, requireAuth, setSessionCookie } from './auth.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

export function createServer(): http.Server {
  const app = express();
  app.set('trust proxy', true);
  app.use(express.json({ limit: '1mb' }));

  // ------------------------------------------------------------- служебное
  app.get('/healthz', async (_req, res) => {
    try {
      await db.pingDb();
      res.json({ ok: true, uptime: process.uptime() });
    } catch (err) {
      res.status(503).json({ ok: false, error: errorMessage(err) });
    }
  });

  // ------------------------------------------------------ Telegram webhook
  app.post('/telegram/webhook', (req, res) => {
    if (req.header('x-telegram-bot-api-secret-token') !== config.telegram.webhookSecret) {
      res.status(401).json({ error: 'bad secret token' });
      return;
    }
    // Telegram ждёт быстрый 200 — обработку ведём асинхронно
    res.json({ ok: true });
    void handleUpdate(req.body).catch((err) => log.error('ошибка обработки апдейта', errorMessage(err)));
  });

  // ------------------------------------------------------------------ auth
  app.post('/api/login', (req, res) => {
    if (!checkPassword(req.body?.password)) {
      res.status(401).json({ error: 'Неверный пароль' });
      return;
    }
    const token = issueToken();
    setSessionCookie(res, token);
    res.json({ ok: true, token });
  });

  app.post('/api/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  app.get('/api/session', (req, res) => {
    res.json({ authenticated: isAuthenticated(req) });
  });

  // ------------------------------------------------------------------- API
  const api = express.Router();
  api.use(requireAuth);

  api.get('/bootstrap', async (_req, res, next) => {
    try {
      const [threads, escalations, runs, externalEvents] = await Promise.all([
        db.listThreads(),
        db.listEscalations(),
        db.listRuns(60),
        db.listExternalEvents(200),
      ]);
      const runEvents = await db.listRunEvents(runs.map((r) => r.id));
      res.json({
        threads,
        escalations,
        runs,
        runEvents,
        externalEvents,
        orchestrator: orchestratorSnapshot(),
        priceList: priceListStatus(),
        settings: {
          debounceMs: config.orchestrator.debounceMs,
          maxJsonRetries: config.llm.maxJsonRetries,
          historyLimit: config.orchestrator.historyLimit,
        },
        llmProviders: providersOverview(),
      });
    } catch (err) {
      next(err);
    }
  });

  api.get('/threads/:id/messages', async (req, res, next) => {
    try {
      res.json({ messages: await db.listMessages(req.params.id) });
    } catch (err) {
      next(err);
    }
  });

  api.get('/threads/:id/runs', async (req, res, next) => {
    try {
      const runs = await db.listRuns(40, req.params.id);
      res.json({ runs, runEvents: await db.listRunEvents(runs.map((r) => r.id)) });
    } catch (err) {
      next(err);
    }
  });

  api.post('/threads/:id/mode', async (req, res, next) => {
    try {
      const mode = req.body?.mode;
      if (mode !== 'ai' && mode !== 'human') {
        res.status(400).json({ error: 'mode должен быть ai или human' });
        return;
      }
      if (mode === 'human') cancelActive(req.params.id, 'переключено из веб-интерфейса');
      const thread = await db.setThreadMode(req.params.id, mode);
      await db.insertMessage({
        thread_id: thread.id,
        role: 'system',
        text: mode === 'ai' ? 'Режим переключён на AI' : 'Режим переключён на ручной',
        meta: { by: 'web' },
      });
      if (thread.topic_id != null) {
        await tg
          .sendMessage(
            config.telegram.managerChatId,
            mode === 'ai' ? 'Бот снова отвечает автоматически (из панели).' : 'Автоответы выключены (из панели).',
            { messageThreadId: thread.topic_id, ctx: { threadId: thread.id } },
          )
          .catch(() => undefined);
      }
      res.json({ thread });
    } catch (err) {
      next(err);
    }
  });

  api.post('/threads/:id/reply', async (req, res, next) => {
    try {
      const text = String(req.body?.text ?? '').trim();
      if (!text) {
        res.status(400).json({ error: 'Пустое сообщение' });
        return;
      }
      const thread = await db.getThread(req.params.id);
      if (!thread) {
        res.status(404).json({ error: 'Диалог не найден' });
        return;
      }
      cancelActive(thread.id, 'ответил менеджер из панели');
      await db.setThreadMode(thread.id, 'human');
      await sendAsManager(thread, text, String(req.body?.author ?? 'менеджер'));
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  api.post('/escalations/:id/status', async (req, res, next) => {
    try {
      const status = req.body?.status;
      if (!['new', 'in_progress', 'done'].includes(status)) {
        res.status(400).json({ error: 'Недопустимый статус' });
        return;
      }
      res.json({ escalation: await db.updateEscalation(req.params.id, status, String(req.body?.by ?? 'панель')) });
    } catch (err) {
      next(err);
    }
  });

  api.get('/runs', async (req, res, next) => {
    try {
      const runs = await db.listRuns(Number(req.query.limit ?? 60));
      res.json({ runs, runEvents: await db.listRunEvents(runs.map((r) => r.id)) });
    } catch (err) {
      next(err);
    }
  });

  api.get('/external-events', async (req, res, next) => {
    try {
      res.json({
        events: await db.listExternalEvents(Number(req.query.limit ?? 200), req.query.onlyErrors === '1'),
        buffered: bus.externalRing,
      });
    } catch (err) {
      next(err);
    }
  });

  api.get('/integrations', async (_req, res) => {
    const checks: Record<string, { ok: boolean; detail: string }> = {};

    await db
      .pingDb()
      .then(() => (checks.supabase = { ok: true, detail: 'Соединение установлено' }))
      .catch((err) => (checks.supabase = { ok: false, detail: errorMessage(err) }));

    await tg
      .getMe()
      .then((me) => (checks.telegram = { ok: true, detail: `@${me.username}` }))
      .catch((err) => (checks.telegram = { ok: false, detail: errorMessage(err) }));

    const price = await loadPriceList();
    checks.price_list = price.available
      ? { ok: true, detail: `${price.rows.length} строк${price.fromCache ? ' (кэш)' : ''}` }
      : { ok: false, detail: price.error ?? 'Прайс недоступен' };

    for (const p of providersOverview()) {
      checks[`llm_${p.id}`] = {
        ok: p.configured,
        detail:
          (p.active ? 'активен · ' : 'не активен · ') +
          (p.configured ? `модель ${p.model}` : `не заданы ${p.missing.join(', ')}`),
      };
    }

    res.json({ checks, priceList: priceListStatus() });
  });

  api.get('/llm-provider', (_req, res) => {
    res.json({ providers: providersOverview() });
  });

  api.post('/llm-provider', async (req, res, next) => {
    try {
      const id = req.body?.provider;
      if (!isProviderId(id)) {
        res.status(400).json({ error: 'Неизвестный провайдер' });
        return;
      }
      // не даём переключиться на провайдера без секретов — иначе бот молча
      // сломается на первом же сообщении клиента
      const ready = getProvider(id).readiness();
      if (!ready.ok) {
        res.status(400).json({
          error: `${getProvider(id).label} не настроен: не заданы ${ready.missing.join(', ')}. Добавьте переменные в secret group и перезапустите сервис.`,
        });
        return;
      }
      applyProvider(id);
      await db.setSetting('llm_provider', id);
      const provider = activeProvider();
      log.info(`провайдер LLM переключён на ${provider.label} (${provider.model()})`);
      res.json({ providers: providersOverview() });
    } catch (err) {
      next(err);
    }
  });

  api.post('/price-list/refresh', async (_req, res) => {
    invalidatePriceCache();
    const price = await loadPriceList();
    res.json({ available: price.available, rows: price.rows.length, error: price.error });
  });

  app.use('/api', api);

  // ошибки API отдаём человекочитаемо
  app.use((err: unknown, _req: Request, res: express.Response, _next: express.NextFunction) => {
    log.error('ошибка HTTP', errorMessage(err));
    res.status(500).json({ error: errorMessage(err) });
  });

  // ---------------------------------------------------------------- статика
  app.use(express.static(publicDir, { index: 'index.html' }));
  app.get('*', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

  const server = http.createServer(app);
  attachWebSocket(server);
  return server;
}

function attachWebSocket(server: http.Server): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    if (!request.url?.startsWith('/ws')) {
      socket.destroy();
      return;
    }
    if (!isAuthenticated(request as unknown as Request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
  });

  wss.on('connection', (ws: WebSocket) => {
    const unsubscribe = bus.subscribe((event) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event));
    });
    ws.on('close', unsubscribe);
    ws.on('error', unsubscribe);
    ws.send(JSON.stringify({ type: 'hello', orchestrator: orchestratorSnapshot() }));
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (client.readyState === client.OPEN) client.ping();
    }
  }, 30_000);
  server.on('close', () => clearInterval(heartbeat));
}
