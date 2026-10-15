#!/usr/bin/env node
// MapTerm entry point: `npm start` (or `node src/server/index.js`).
import { PORT, BIND, DATA_DIR, prepareDataDir } from './config.js';
import { createServer } from './app.js';

for (const name of prepareDataDir()) console.log(`Moved ${name} to ${DATA_DIR}`);

const server = createServer();
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Port ${PORT} is already in use. Stop the other program or start with PORT=<number>.` : e.message);
  process.exit(1);
});
server.listen(PORT, BIND, () => {
  const host = BIND === '0.0.0.0' || BIND === '::' ? '127.0.0.1' : BIND;
  console.log(`MapTerm running. Open this link (once per browser; it contains your access key):`);
  console.log(`  http://${host}:${PORT}/?token=${server.accessKey}`);
  console.log(`Data folder: ${DATA_DIR}`);
});
