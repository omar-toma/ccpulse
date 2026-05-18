import { createServer } from './server.js';

const server = createServer({
  port: Number(process.env.CCPULSE_PORT) || 7878,
  dbPath: process.env.CCPULSE_DB,
  claudeDir: process.env.CCPULSE_CLAUDE_DIR || undefined,
});
server.start().then(({ port }) => {
  // eslint-disable-next-line no-console
  console.log(`[ccpulse] daemon dev on http://localhost:${port}`);
});

process.on('SIGINT', async () => {
  await server.stop();
  process.exit(0);
});
