// Builds the HTTP server: static page, vendor libraries, JSON API and the /ssh WebSocket.
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import { WEB_DIR, NODE_MODULES, readSettings, writeSettings } from './config.js';
import { mountApi } from './api.js';
import { mountMaps, countCredentialUse, forgetCredential } from './maps.js';
import { mountCredentials } from './credentials.js';
import { attachTerminalServer, mountTerminalApi } from './terminal.js';
import { accessKey, hasAccess, grantAccess, keyMatches } from './access.js';

// The returned server's accessKey is the key in MapTerm's access link (see access.js).
export function createServer() {
  const key = accessKey();
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));
  // The access link (/?token=<key>): hand the browser its key, then drop it from the address.
  app.get('/', (req, res, next) => {
    if (req.query.token === undefined) return next();
    if (keyMatches(req.query.token, key)) grantAccess(req, res, key);
    res.redirect(303, '/');
  });
  // The API can write files and open device sessions: refuse pages from other origins, and
  // anything (another program, another user) that doesn't hold the access key.
  app.use('/api', (req, res, next) => {
    const o = req.headers.origin;
    try { if (o && new URL(o).host !== req.headers.host) return res.status(403).end(); } catch { return res.status(403).end(); }
    if (!hasAccess(req, key)) return res.status(401).json({ ok: false, signin: true, error: 'Open MapTerm from its access link.' });
    next();
  });

  app.use(express.static(WEB_DIR));
  app.get('/favicon.ico', (req, res) => res.redirect(301, '/favicon.svg')); // browsers ask for this by default
  app.use('/vendor/xterm', express.static(path.join(NODE_MODULES, '@xterm/xterm')));
  app.use('/vendor/fit', express.static(path.join(NODE_MODULES, '@xterm/addon-fit')));
  app.use('/vendor/cy', express.static(path.join(NODE_MODULES, 'cytoscape/dist')));

  mountApi(app);
  mountMaps(app);
  mountTerminalApi(app);
  const resolveCreds = mountCredentials(app, readSettings, writeSettings, { countUse: countCredentialUse, onDelete: forgetCredential });

  const server = http.createServer(app);
  attachTerminalServer(server, { resolveCreds, accessKey: key });
  server.accessKey = key;
  return server;
}
