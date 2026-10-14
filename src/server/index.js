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
  console.log(`MapTerm running at http://${BIND}:${PORT}`);
  console.log(`Data folder: ${DATA_DIR}`);
});
