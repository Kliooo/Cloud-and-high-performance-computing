'use strict';

// lib/admin.js — admin API: server, online players, rooms and pilots.
// Key-gated: ADMIN_KEY from the environment, or one generated on start
// (the server prints it so the owner can open the panel).

const crypto = require('node:crypto');

function createAdmin({ key, registry, multiplayer, resultsInfo, storageFile, version, log } = {}) {
  const adminKey = key || crypto.randomBytes(6).toString('hex');

  function safeEqual(a, b) {
    const ba = Buffer.from(String(a == null ? '' : a));
    const bb = Buffer.from(String(b == null ? '' : b));
    if (ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  }

  function extractKey(req, url) {
    const header = req.headers['x-admin-key'];
    if (header) return Array.isArray(header) ? header[0] : header;
    return url && url.searchParams ? url.searchParams.get('key') || '' : '';
  }

  function summary() {
    const mp =
      multiplayer && typeof multiplayer.adminInfo === 'function'
        ? multiplayer.adminInfo()
        : { online: [], rooms: [] };
    const results =
      typeof resultsInfo === 'function' ? resultsInfo() : { total: 0, byMode: {}, tracks: {} };
    return {
      t: Date.now(),
      server: {
        version: version || 'unknown',
        uptimeSec: Math.round(process.uptime()),
        storage: storageFile || null,
        node: process.version,
      },
      online: mp.online || [],
      rooms: mp.rooms || [],
      pilots: registry && typeof registry.list === 'function' ? registry.list() : [],
      results,
    };
  }

  async function handleApi(req, res, pathname, url, sendJson) {
    if (pathname !== '/api/admin/summary' || req.method !== 'GET') return false;
    if (!safeEqual(extractKey(req, url), adminKey)) {
      sendJson(res, 401, { ok: false, error: 'admin_key_required' });
      return true;
    }
    sendJson(res, 200, summary());
    return true;
  }

  return { handleApi, summary, key: adminKey };
}

module.exports = { createAdmin };
