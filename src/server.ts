import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './common/logger.js';
import { connectDb, disconnectDb } from './db/connect.js';
import { ensureSettings } from './modules/settings/settings.service.js';

async function main(): Promise<void> {
  await connectDb(env.MONGODB_URI);
  await ensureSettings();

  const server = createApp().listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV }, 'API listening');
  });

  const shutdown = (signal: string): void => {
    logger.info({ signal }, 'Shutting down');
    server.close(() => {
      disconnectDb()
        .then(() => process.exit(0))
        .catch((err: unknown) => {
          logger.error({ err }, 'Error while disconnecting');
          process.exit(1);
        });
    });
    // Force exit if open connections keep the server alive.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  logger.fatal({ err }, 'Failed to start');
  process.exit(1);
});
