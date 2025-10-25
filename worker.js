// worker.js
import 'dotenv/config';
import BullMQ from 'bullmq';
import IORedis from 'ioredis';
import { pool } from './db.js';
import { estimateFromMetadata } from './lib/estimate.js';

const { Worker } = BullMQ;

// Upstash via TLS
const url = process.env.REDIS_URL ?? '';
if (!url.startsWith('rediss://')) {
  throw new Error('REDIS_URL must start with rediss:// (Upstash TLS).');
}

const connection = new IORedis(url, { maxRetriesPerRequest: null });

console.log('[worker] up');

new Worker(
  'vinyl-jobs',
  async (job) => {
    const { name: kind, data } = job;

    if (kind === 'estimate') {
      const recordId = data.recordId;
      console.log(`[worker] estimating record ${recordId}`);

      // Load record
      const { rows } = await pool.query('select * from records where id=$1', [recordId]);
      if (rows.length === 0) throw new Error(`record ${recordId} not found`);
      const record = rows[0];

      const meta = {
        artist: record.artist,
        title: record.title,
        label: record.label,
        catno: record.catno,
        barcode: record.barcode,
      };

      // Run estimator
      const out = await estimateFromMetadata(meta);

      // Persist snapshot
      await pool.query(
        `insert into price_estimates
          (record_id, source, lowest_price, median_price, estimated_price, extras)
         values ($1,$2,$3,$4,$5,$6)`,
        [recordId, out.source, out.lowest_price, out.median_price, out.estimated_price, out.extras]
      );

      return { recordId, done: true, est: out.estimated_price };
    }

    // unknown job kinds are no-ops for now
    return { ok: true };
  },
  { connection, concurrency: 3 }
)
  .on('failed', (job, err) => {
    console.error('[worker] failed', job?.id, err?.message);
  })
  .on('completed', (job, result) => {
    console.log('[worker] done', job?.id, result);
  });
