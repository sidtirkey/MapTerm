// Builds the HTTP server: static page, vendor libraries, JSON API and the /ssh WebSocket.
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WEB_DIR, NODE_MODULES, readSettings, writeSettings } from './config.js';
import { mountApi } from './api.js';
import { mountMaps, countCredentialUse, forgetCredential } from './maps.js';
import { mountCredentials } from './credentials.js';
import { attachTerminalServer } from './terminal.js';

export function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  // The API can write files on this machine; refuse requests made by pages from other origins.
  app.use('/api', (req, res, next) => {
    const o = req.headers.origin;
    try { if (o && new URL(o).host !== req.headers.host) return res.status(403).end(); } catch { return res.status(403).end(); }
    next();
  });

  app.use(express.static(WEB_DIR));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg')); // browsers ask for this by default
  app.use('/vendor/xterm', express.static(path.join(NODE_MODULES, '@xterm/xterm')));
  app.use('/vendor/fit', express.static(path.join(NODE_MODULES, '@xterm/addon-fit')));
  app.use('/vendor/cy', express.static(path.join(NODE_MODULES, 'cytoscape/dist')));

  mountApi(app);
  mountMaps(app);
  const resolveCreds = mountCredentials(app, readSettings, writeSettings, { countUse: countCredentialUse, onDelete: forgetCredential });

  const server = http.createServer(app);
  attachTerminalServer(server, { resolveCreds });
  return server;
}
