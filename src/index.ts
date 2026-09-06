import { assertConfig, config, supabaseUrlNotes } from './config.js';
import { getSetting, initDb, pingDb } from './db.js';
import { createServer } from './http/server.js';
import { setWebhook } from './services/telegram.js';
import { loadPriceList } from './services/priceList.js';
import { activeProvider, isProviderId, restoreProvider } from './services/llm/index.js';
import { log, errorMessage } from './logger.js';

async function main() {
  assertConfig();
  for (const note of supabaseUrlNotes) log.warn(note);
  initDb();

  const server = createServer();
  server.listen(config.port, () => log.info(`сервер слушает :${config.port}`));

  // стартовые проверки — не валят процесс, но сразу видны в журнале и в UI
  await pingDb()
    .then(() => log.info('Supabase доступна'))
    .catch((err) => log.error('Supabase недоступна', errorMessage(err)));

  // восстанавливаем выбранный провайдер LLM из настроек
  await getSetting<string>('llm_provider')
    .then((saved) => {
      const { fellBackFrom } = restoreProvider(saved);
      const provider = activeProvider();
      log.info(`провайдер LLM: ${provider.label} (${provider.model()})`, {
        источник: isProviderId(saved) ? 'app_settings' : 'LLM_PROVIDER/по умолчанию',
        откат_с: fellBackFrom,
      });
    })
    .catch((err) => log.error('не удалось прочитать настройку провайдера LLM', errorMessage(err)));

  await loadPriceList()
    .then((price) => log.info(`прайс: ${price.rows.length} строк`, { error: price.error }))
    .catch((err) => log.error('не удалось загрузить прайс', errorMessage(err)));

  if (config.publicBaseUrl) {
    const url = `${config.publicBaseUrl.replace(/\/+$/, '')}/telegram/webhook`;
    await setWebhook(url)
      .then(() => log.info(`webhook Telegram установлен: ${url}`))
      .catch((err) => log.error('не удалось установить webhook', errorMessage(err)));
  } else {
    log.warn('PUBLIC_BASE_URL не задан — webhook нужно выставить вручную через setWebhook');
  }

  const shutdown = (signal: string) => {
    log.info(`получен ${signal}, останавливаемся`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

process.on('unhandledRejection', (reason) => log.error('unhandledRejection', errorMessage(reason)));
process.on('uncaughtException', (err) => log.error('uncaughtException', errorMessage(err)));

main().catch((err) => {
  log.error('фатальная ошибка старта', errorMessage(err));
  process.exit(1);
});
