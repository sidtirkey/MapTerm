// HTTP API used by the page: folder helpers. Maps (with their log and results folders) and
// credential sets have their own routes in maps.js and credentials.js.
import { pickFolder, openFolder } from './platform.js';

export function mountApi(app) {
  app.post('/api/pick-folder', async (req, res) => res.json(await pickFolder(req.body || {})));
  app.post('/api/open-folder', async (req, res) => res.json(await openFolder(req.body?.path)));
}
