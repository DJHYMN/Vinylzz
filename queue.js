// queue.js
import BullMQ from 'bullmq';
import IORedis from 'ioredis';
import 'dotenv/config';

const { Queue } = BullMQ;

// Upstash over TLS (must be rediss://)
const url = process.env.REDIS_URL ?? '';
if (!url.startsWith('rediss://')) {
  throw new Error('REDIS_URL must start with rediss:// (Upstash TLS).');
}

const connection = new IORedis(url, { maxRetriesPerRequest: null });

export const JOB_QUEUE = 'vinyl-jobs';
export const q = new Queue(JOB_QUEUE, { connection });

// Enqueue helper with sane defaults
export async function enqueue(name, data) {
  return q.add(name, data, {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: { age: 3600, count: 5000 },
    removeOnFail: { age: 86400, count: 1000 },
  });
}

