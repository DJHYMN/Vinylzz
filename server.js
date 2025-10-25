// server.js
import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import multer from 'multer';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from './db.js';
import { enqueue } from './queue.js';

const app = express();
const PORT = process.env.PORT || 8080;

// --- paths / dirs ------------------------------------------------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');

// ✅ NEW: allow env override for uploads (use /tmp/uploads on Render Free)
const UPLOAD_DIR = process.env.UPLOAD_DIR
  ? path.resolve(process.env.UPLOAD_DIR)
  : path.join(__dirname, 'uploads');

fs.mkdirSync(UPLOAD_DIR, { recursive: true });
fs.mkdirSync(PUBLIC_DIR, { recursive: true });

// --- middleware --------------------------------------------------------------
app.set('trust proxy', true);
app.use(cors({ origin: true }));            // open during dev; lock down later
app.use(express.json({ limit: '5mb' }));    // payloads

// serve frontend (public/index.html if present)
app.use(express.static(PUBLIC_DIR));

// serve uploaded files with long cache
app.use('/uploads', (req, res, next) => {
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  next();
}, express.static(UPLOAD_DIR));

// --- upload endpoint ---------------------------------------------------------
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const safe = (file.originalname || 'file')
      .replace(/[^a-zA-Z0-9._-]/g, '_')
      .slice(0, 80);
    const ext = path.extname(safe) || path.extname(file.originalname || '') || '';
    cb(null, `${Date.now()}${ext}`);
  }
});
const upload = multer({ storage });

app.post('/api/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no_file' });
  const url = `${req.protocol}://${req.get('host')}/uploads/${req.file.filename}`;
  res.json({ url });
});

// --- health ------------------------------------------------------------------
app.get('/health', (_req, res) => res.json({ ok: true, t: Date.now() }));

// --- create a record ---------------------------------------------------------
app.post('/api/records', async (req, res) => {
  try {
    const { image_url, artist, title, label, catno, barcode } = req.body || {};
    if (!image_url || typeof image_url !== 'string') {
      return res.status(400).json({ error: 'image_url required' });
    }

    const clean = (v) =>
      typeof v === 'string' ? v.trim().slice(0, 300) : (v ?? null);

    const { rows } = await pool.query(
      `insert into records (image_url, artist, title, label, catno, barcode)
       values ($1,$2,$3,$4,$5,$6)
       returning id`,
      [clean(image_url), clean(artist), clean(title), clean(label), clean(catno), clean(barcode)]
    );

    res.json({ id: rows[0].id });
  } catch (e) {
    console.error('POST /api/records', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- enqueue estimate --------------------------------------------------------
app.post('/api/records/:id/estimate', async (req, res) => {
  try {
    const recordId = Number(req.params.id);
    if (!Number.isFinite(recordId) || recordId <= 0) {
      return res.status(400).json({ error: 'bad_record_id' });
    }

    const { rowCount } = await pool.query('select 1 from records where id=$1', [recordId]);
    if (rowCount === 0) return res.status(404).json({ error: 'record_not_found' });

    const job = await enqueue('estimate', { kind: 'estimate', recordId });
    res.json({ enqueued: true, jobId: job.id });
  } catch (e) {
    console.error('POST /api/records/:id/estimate', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- latest estimate snapshot ------------------------------------------------
app.get('/api/records/:id/estimate', async (req, res) => {
  try {
    const recordId = Number(req.params.id);
    if (!Number.isFinite(recordId) || recordId <= 0) {
      return res.status(400).json({ error: 'bad_record_id' });
    }

    const { rows } = await pool.query(
      `select id, source, lowest_price, median_price, estimated_price, extras, created_at
         from price_estimates
        where record_id=$1
        order by id desc
        limit 1`,
      [recordId]
    );

    if (rows.length === 0) return res.status(204).end();
    res.json(rows[0]);
  } catch (e) {
    console.error('GET /api/records/:id/estimate', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- list records (paginated) -----------------------------------------------
app.get('/api/records', async (req, res) => {
  try {
    const afterId = Number(req.query.after || 0);
    const limit = Math.min(Number(req.query.limit || 100), 200);

    const { rows } = await pool.query(
      `select id, image_url, artist, title, label, catno, barcode, created_at
         from records
        where id > $1
        order by id
        limit $2`,
      [afterId, limit]
    );

    const nextCursor = rows.length ? rows[rows.length - 1].id : null;
    res.json({ items: rows, nextCursor });
  } catch (e) {
    console.error('GET /api/records', e);
    res.status(500).json({ error: 'server_error' });
  }
});

// --- TEMP: one-time DB init (protect with token) ----------------------------
app.post('/admin/init', async (req, res) => {
  const token = req.get('x-init-token') || req.query.token;
  if (!process.env.INIT_TOKEN || token !== process.env.INIT_TOKEN) {
    return res.status(403).json({ error: 'forbidden' });
  }
  try {
    await pool.query(`
      create table if not exists records (
        id serial primary key,
        image_url text not null,
        artist text,
        title text,
        label text,
        catno text,
        barcode text,
        created_at timestamptz default now()
      );

      create table if not exists price_estimates (
        id serial primary key,
        record_id int references records(id) on delete cascade,
        source text,
        lowest_price numeric,
        median_price numeric,
        estimated_price numeric,
        extras jsonb,
        created_at timestamptz default now()
      );

      create index if not exists idx_price_estimates_record_id_created
        on price_estimates (record_id, created_at desc);
    `);
    res.json({ ok: true });
  } catch (e) {
    console.error('admin/init failed', e);
    res.status(500).json({ error: 'init_failed', detail: String(e) });
  }
});

// (optional) fallback: show a tiny landing if no index.html present ----------
app.get('/', (req, res, next) => {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  if (fs.existsSync(indexPath)) return next(); // static middleware will serve it
  res.type('html').send(`
    <!doctype html><meta charset="utf-8">
    <title>Vinylzz API</title>
    <style>body{font:14px/1.5 system-ui; padding:24px; color:#111}</style>
    <h1>Vinylzz API is running</h1>
    <ul>
      <li><a href="/health">/health</a></li>
      <li><a href="/api/records">/api/records</a></li>
      <li>Upload: <code>POST /api/upload (form field: file)</code></li>
    </ul>
  `);
});

// --- listen -----------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`web listening on http://localhost:${PORT}`);
});

