// Credential sets: a name, a username, password or SSH key sign-in, and an optional enable
// password. The non-secret parts live in settings.json; secrets live in the vault.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import ssh2 from 'ssh2';
import vault from './vault.js';
import { expandHome } from './files.js';

const { parseKey } = ssh2.utils;

function readKey(keyPath, passphrase) {
  const file = path.resolve(expandHome(String(keyPath || '').trim()));
  let data;
  try { data = fs.readFileSync(file); } catch (e) { throw new Error(`Can't read the key file ${file} (${e.code || e.message})`); }
  const k = parseKey(data, passphrase || undefined);
  if (k instanceof Error) throw new Error(/passphrase|encrypted/i.test(k.message) ? 'The key passphrase is missing or wrong' : `Not a usable private key: ${k.message}`);
  return { file, data };
}

export function mountCredentials(app, readSettings, writeSettings) {
  const list = () => readSettings().credentials || [];
  const publicView = (c) => ({ id: c.id, name: c.name, username: c.username, auth: c.auth, keyPath: c.keyPath, hasEnable: !!c.hasEnable });

  app.get('/api/credentials', (req, res) => res.json({ store: vault.label, persistent: vault.persistent, sets: list().map(publicView) }));

  // Create or update. Blank secret fields on an update keep the saved values.
  app.post('/api/credentials', async (req, res) => {
    const b = req.body || {};
    const sets = list();
    const old = b.id ? sets.find((c) => c.id === b.id) : null;
    if (b.id && !old) return res.json({ ok: false, error: 'That credential set no longer exists.' });
    const name = String(b.name || '').trim(), username = String(b.username || '').trim();
    const auth = b.auth === 'key' ? 'key' : 'password';
    if (!name) return res.json({ ok: false, error: 'Give the credential set a name.' });
    if (sets.some((c) => c !== old && c.name.toLowerCase() === name.toLowerCase())) return res.json({ ok: false, error: `There is already a set called "${name}".` });
    if (!username) return res.json({ ok: false, error: 'Enter a username.' });

    const prev = (old && (await vault.get(old.id, old.name))) || {};
    const keep = (field) => (b[field] ? String(b[field]) : prev[field] || '');
    const secrets = { password: auth === 'password' ? keep('password') : '', passphrase: auth === 'key' ? keep('passphrase') : '', enable: b.clearEnable ? '' : keep('enable') };
    let keyPath = '';
    if (auth === 'password' && !secrets.password) return res.json({ ok: false, error: 'Enter a password.' });
    if (auth === 'key') {
      try { keyPath = readKey(b.keyPath || old?.keyPath, secrets.passphrase).file; } catch (e) { return res.json({ ok: false, error: e.message }); }
    }

    const entry = { id: old?.id || 'c' + crypto.randomBytes(6).toString('hex'), name, username, auth, keyPath, hasEnable: !!secrets.enable };
    try { await vault.set(entry.id, secrets, name); } catch (e) { return res.json({ ok: false, error: e.message }); }
    writeSettings({ credentials: old ? sets.map((c) => (c === old ? entry : c)) : [...sets, entry] });
    res.json({ ok: true, set: publicView(entry) });
  });

  app.delete('/api/credentials/:id', async (req, res) => {
    const sets = list();
    if (!sets.some((c) => c.id === req.params.id)) return res.json({ ok: false, error: 'Not found.' });
    await vault.del(req.params.id);
    writeSettings({ credentials: sets.filter((c) => c.id !== req.params.id) });
    res.json({ ok: true });
  });

  // Turns what a client sent ({ credId } or typed-in { username, password, enable }) into
  // ssh2 connect options plus the enable password.
  return async function resolveCreds(m) {
    if (m.credId) {
      const c = list().find((x) => x.id === m.credId);
      if (!c) throw new Error('Its credential set was deleted; choose another one for this device');
      const s = await vault.get(c.id, c.name);
      if (!s) throw new Error(`The secrets for "${c.name}" aren't saved ${vault.persistent ? 'any more' : 'since MapTerm restarted'}; edit the set and enter them again`);
      const auth = { username: c.username, enable: s.enable || '' };
      if (c.auth === 'key') Object.assign(auth, { privateKey: readKey(c.keyPath, s.passphrase).data, passphrase: s.passphrase || undefined });
      else auth.password = s.password;
      return auth;
    }
    if (!m.username || !m.password) throw new Error('No username or password');
    return { username: String(m.username), password: String(m.password), enable: String(m.enable || '') };
  };
}
