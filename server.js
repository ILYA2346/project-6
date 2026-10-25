'use strict';

const express = require('express');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const PORT = Number(process.env.PORT) || 3000;
const MONGO_URL = process.env.MONGO_URL || 'mongodb://127.0.0.1:27017';
const DB_NAME = process.env.DB_NAME || 'shortener';
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/+$/, '');

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
const RESERVED = new Set(['create', 'refresh', 'alias', 'remove']);
const MAX_ATTEMPTS = 5;

let urls; 

function generateCode(len = 7) {
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % ALPHABET.length];
  return s;
}

/**
 * Валидация и нормализация URL.
 * "ithub.ru" -> "http://ithub.ru/" (valid), "12345" -> null (invalid).
 */
function normalizeUrl(input) {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || /\s/.test(raw)) return null;

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw);
  let u;
  try {
    u = new URL(hasScheme ? raw : 'http://' + raw);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  const host = u.hostname;
  const isDomain = /^([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+([a-z]{2,}|xn--[a-z0-9-]+)$/i.test(host);
  const isIp = hasScheme && /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const isLocalhost = hasScheme && host === 'localhost';
  if (!isDomain && !isIp && !isLocalhost) return null;

  return u.href;
}

const fullShort = (code) => `${BASE_URL}/${code}`;
const isDup = (e, field) => e && e.code === 11000 && e.keyPattern && e.keyPattern[field];


async function insertWithUniqueShort(doc) {
  for (let i = 0; i < MAX_ATTEMPTS; i++) {
    const short = generateCode();
    if (RESERVED.has(short)) continue;
    try {
      await urls.insertOne({ ...doc, short });
      return short;
    } catch (e) {
      if (isDup(e, 'short')) continue; 
      throw e;
    }
  }
  throw new Error('Could not generate a unique short code');
}

async function createOrGet(key) {
  const existing = await urls.findOne({ primaryOf: key });
  if (existing) return { short: existing.short, created: null };

  try {
    const short = await insertWithUniqueShort({
      original: key,
      primaryOf: key,
      createdAt: new Date(),
    });
    return { short, created: true };
  } catch (e) {
    if (isDup(e, 'primaryOf')) {
      const ex = await urls.findOne({ primaryOf: key });
      if (ex) return { short: ex.short, created: null };
    }
    throw e;
  }
}

const rawOriginal = (req) => (typeof req.query.url === 'string' ? req.query.url : null);


const app = express();

// /create?url=...
app.get('/create', async (req, res) => {
  const original = rawOriginal(req);
  try {
    const key = normalizeUrl(original);
    if (!key) return res.json({ original, created: false });

    const { short, created } = await createOrGet(key);
    res.json({ original, short: fullShort(short), created });
  } catch (e) {
    console.error(e);
    res.json({ original, created: false });
  }
});

// /refresh?url=...
app.get('/refresh', async (req, res) => {
  const original = rawOriginal(req);
  try {
    const key = normalizeUrl(original);
    if (!key) return res.json({ original, refresh: false });

    const doc = await urls.findOne({ primaryOf: key });
    if (!doc) return res.json({ original, refresh: null });

    for (let i = 0; i < MAX_ATTEMPTS; i++) {
      const short = generateCode();
      if (RESERVED.has(short)) continue;
      try {
        const r = await urls.updateOne(
          { _id: doc._id },
          { $set: { short, updatedAt: new Date() } }
        );
        if (r.matchedCount === 0) return res.json({ original, refresh: null }); // removed meanwhile
        return res.json({ original, short: fullShort(short), refresh: true });
      } catch (e) {
        if (isDup(e, 'short')) continue;
        throw e;
      }
    }
    res.json({ original, refresh: false });
  } catch (e) {
    console.error(e);
    res.json({ original, refresh: false });
  }
});

// /alias?url=...
app.get('/alias', async (req, res) => {
  const original = rawOriginal(req);
  try {
    const key = normalizeUrl(original);
    if (!key) return res.json({ original, alias: false });

    const doc = await urls.findOne({ primaryOf: key });
    if (!doc) {
      // URL unknown -> behave exactly like /create
      const { short, created } = await createOrGet(key);
      return res.json({ original, short: fullShort(short), created });
    }

    const short = await insertWithUniqueShort({
      original: key,
      createdAt: new Date(),
    });
    res.json({ original, short: fullShort(short), alias: true });
  } catch (e) {
    console.error(e);
    res.json({ original, alias: false });
  }
});

// /remove?url=...
app.get('/remove', async (req, res) => {
  const original = rawOriginal(req);
  try {
    const key = normalizeUrl(original);
    if (!key) return res.json({ original, deleted: false });

    const r = await urls.deleteMany({ original: key });
    res.json({ original, deleted: r.deletedCount > 0 ? true : null });
  } catch (e) {
    console.error(e);
    res.json({ original, deleted: false });
  }
});

// /<short> -> redirect to the original URL
app.get('/:short([0-9A-Za-z]+)', async (req, res) => {
  try {
    const doc = await urls.findOne({ short: req.params.short });
    if (!doc) return res.status(404).json({ error: 'Not found' });
    res.redirect(302, doc.original);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Internal error' });
  }
});


async function main() {
  const client = new MongoClient(MONGO_URL);
  await client.connect();
  urls = client.db(DB_NAME).collection('urls');

  await urls.createIndex({ short: 1 }, { unique: true });
  // `primaryOf` exists only on the primary record -> at most one per original URL
  await urls.createIndex({ primaryOf: 1 }, { unique: true, sparse: true });
  await urls.createIndex({ original: 1 });

  app.listen(PORT, () => console.log(`Listening on ${BASE_URL} (port ${PORT})`));
}

main().catch((e) => {
  console.error('Startup failed:', e);
  process.exit(1);
});
