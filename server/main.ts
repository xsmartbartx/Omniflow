import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildServer, packageRoot } from '../gateway/server.ts';
import { loadConfig } from './config.ts';
import { createOmniflow } from './platform.ts';

/** Process entry point: `node dist/server/main.js`. */
async function main(): Promise<void> {
  let version = '1.0.0';
  try {
    version = JSON.parse(readFileSync(join(packageRoot(), 'package.json'), 'utf8')).version ?? version;
  } catch {
    /* keep the default */
  }

  const config = loadConfig(process.env, { version });
  const app = createOmniflow(config);
  const started = await app.start();
  const { server } = await buildServer(app);
  await server.listen({ host: config.host, port: config.port });

  app.log.info('listening', { url: config.publicUrl, host: config.host, port: config.port });
  if (started.bootstrap) {
    // Printed once, to the operator's terminal only — never through the structured logger.
    process.stdout.write(
      `\n  First start: initial administrator created.\n  Email:    ${started.bootstrap.email}\n  Password: ${started.bootstrap.password}\n  (You will be asked to change it at first sign-in.)\n\n`,
    );
  }

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    app.log.info('shutting down', { signal });
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await server.close();
      await app.stop();
      process.exit(0);
    } catch (e) {
      app.log.error('shutdown failed', { error: e });
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('unhandledRejection', (e) => app.log.error('unhandled rejection', { error: e }));
}

main().catch((e) => {
  process.stderr.write(`Fatal: ${(e as Error).message}\n`);
  process.exit(1);
});
