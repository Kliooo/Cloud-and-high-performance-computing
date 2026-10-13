'use strict';

// lib/registry.js — server-side pilot registry (who registered, when they last played).
// Stored in pilots.json next to the results, written atomically like those.

const fs = require('node:fs');
const path = require('node:path');

const NAME_MAX = 24;
const HASH_RE = /^[0-9a-f]{16,128}$/i;

function cleanName(value) {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  if (cleaned.length < 1 || cleaned.length > NAME_MAX) return null;
  return cleaned;
}

function cleanHash(value) {
  if (typeof value !== 'string' || !HASH_RE.test(value)) return null;
  return value.toLowerCase();
}

function createRegistry({ file, log } = {}) {
  const pilots = new Map(); // lowercase name -> record
  const filePath = file || path.join(process.cwd(), 'data', 'pilots.json');

  function load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (Array.isArray(parsed)) {
        for (const rec of parsed) {
          if (rec && typeof rec.name === 'string' && typeof rec.hash === 'string') {
            pilots.set(rec.name.toLowerCase(), rec);
          }
        }
      }
    } catch (err) {
      if (err.code !== 'ENOENT' && log) log(`[registry] failed to read the registry: ${err.message}`);
    }
  }

  function save() {
    try {
      const dir = path.dirname(filePath);
      fs.mkdirSync(dir, { recursive: true });
      const tmp = path.join(dir, `.pilots-${process.pid}-${Date.now()}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify([...pilots.values()], null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch (err) {
      if (log) log(`[registry] failed to save the registry: ${err.message}`);
    }
  }

  // Everything except the password hash is exposed.
  function publicPilot(rec) {
    return {
      name: rec.name,
      createdAt: rec.createdAt || null,
      lastSeenAt: rec.lastSeenAt || null,
      logins: rec.logins || 0,
      source: rec.source || 'web',
    };
  }

  function register({ name, hash, source } = {}) {
    const cleanNameValue = cleanName(name);
    const cleanHashValue = cleanHash(hash);
    if (!cleanNameValue) return { status: 400, error: 'name: string of 1..24 characters' };
    if (!cleanHashValue) return { status: 400, error: 'hash: hex string of 16..128 characters' };

    const key = cleanNameValue.toLowerCase();
    const existing = pilots.get(key);
    if (existing) {
      if (existing.hash === cleanHashValue) {
        existing.lastSeenAt = new Date().toISOString();
        save();
        return { ok: true, pilot: publicPilot(existing), existed: true };
      }
      return { status: 409, error: 'name_taken' };
    }

    const rec = {
      name: cleanNameValue,
      hash: cleanHashValue,
      createdAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
      logins: 1,
      source: source || 'web',
    };
    pilots.set(key, rec);
    save();
    return { ok: true, pilot: publicPilot(rec), created: true };
  }

  function login({ name, hash, allowImport } = {}) {
    const cleanNameValue = cleanName(name);
    const cleanHashValue = cleanHash(hash);
    if (!cleanNameValue || !cleanHashValue) return { status: 400, error: 'name and hash are required' };

    const rec = pilots.get(cleanNameValue.toLowerCase());
    if (!rec) {
      // An account from the older local-only build — import it on first login
      if (allowImport) return register({ name: cleanNameValue, hash: cleanHashValue, source: 'imported' });
      return { status: 404, error: 'unknown_pilot' };
    }
    if (rec.hash !== cleanHashValue) return { status: 403, error: 'bad_password' };

    rec.logins = (rec.logins || 0) + 1;
    rec.lastSeenAt = new Date().toISOString();
    save();
    return { ok: true, pilot: publicPilot(rec) };
  }

  function seen(name, hash) {
    const cleanNameValue = cleanName(name);
    if (!cleanNameValue) return { status: 400, error: 'name is required' };
    const rec = pilots.get(cleanNameValue.toLowerCase());
    if (!rec) {
      // A hash from the client means a login to a legacy local account: register it
      // so the pilot shows up in the admin panel.
      const cleanHashValue = cleanHash(hash);
      if (cleanHashValue) return register({ name: cleanNameValue, hash: cleanHashValue, source: 'imported' });
      return { status: 404, error: 'unknown_pilot' };
    }
    rec.lastSeenAt = new Date().toISOString();
    save();
    return { ok: true, pilot: publicPilot(rec) };
  }

  function list() {
    return [...pilots.values()]
      .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
      .map(publicPilot);
  }

  load();
  return { register, login, seen, list, size: () => pilots.size };
}

module.exports = { createRegistry };
