import express from 'express';
import multer from 'multer';
import { GoogleGenAI, Type, Schema } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import JSZip from 'jszip';
import fs from 'fs';
import { v4 as uuidv4 } from 'uuid';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { neon } from '@neondatabase/serverless';
import crypto from 'crypto';
import 'dotenv/config';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const MAX_PDF_SIZE_MB = Number(process.env.MAX_PDF_SIZE_MB || 25);
const MAX_UPLOAD_BYTES = MAX_PDF_SIZE_MB * 1024 * 1024;
const API_RATE_LIMIT_WINDOW_MS = Number(process.env.API_RATE_LIMIT_WINDOW_MS || 60_000);
const API_RATE_LIMIT_MAX = Number(process.env.API_RATE_LIMIT_MAX || 30);
const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 60 * 60 * 1000);
const MAX_CONTEXT_CHARS = Number(process.env.MAX_CONTEXT_CHARS || 180_000);
const PAPER_FETCH_TIMEOUT_MS = Number(process.env.PAPER_FETCH_TIMEOUT_MS || 12_000);
const FULLTEXT_RESOLVER_TIMEOUT_MS = Number(process.env.FULLTEXT_RESOLVER_TIMEOUT_MS || PAPER_FETCH_TIMEOUT_MS);
const FULLTEXT_CACHE_TTL_MS = Number(process.env.FULLTEXT_CACHE_TTL_MS || 15 * 60 * 1000);
const DB_URL = (process.env.DATABASE_URL || '').trim();
const FRONTEND_ORIGIN = (process.env.FRONTEND_ORIGIN || '').trim();
const AUTH_REQUIRED = process.env.AUTH_REQUIRED !== 'false';
const AUTH_TOKEN_TTL_SEC = Number(process.env.AUTH_TOKEN_TTL_SEC || 60 * 60 * 8);
const DEMO_DAILY_RUN_LIMIT = Math.max(0, Number(process.env.DEMO_DAILY_RUN_LIMIT || 3));
const DEMO_DAILY_CHAT_LIMIT = Math.max(0, Number(process.env.DEMO_DAILY_CHAT_LIMIT || 20));
const DEMO_DAILY_WINDOW_MS = Math.max(60_000, Number(process.env.DEMO_DAILY_WINDOW_MS || 24 * 60 * 60 * 1000));
const TRUST_PROXY = String(process.env.TRUST_PROXY || 'false').trim();
const UNPAYWALL_EMAIL = (process.env.UNPAYWALL_EMAIL || '').trim();
const SEMANTIC_SCHOLAR_API_KEY = (process.env.SEMANTIC_SCHOLAR_API_KEY || '').trim();
const DEFAULT_PROD_ORIGIN = 'https://tldrun.vercel.app';
const DEFAULT_DEV_ORIGINS = ['http://localhost:5173', 'http://127.0.0.1:5173', 'http://localhost:4173', 'http://127.0.0.1:4173'];
const configuredOrigins = FRONTEND_ORIGIN
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const allowedOrigins = new Set<string>([
  ...configuredOrigins,
  DEFAULT_PROD_ORIGIN,
  ...(process.env.NODE_ENV === 'production' ? [] : DEFAULT_DEV_ORIGINS),
]);

const GEMINI_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];
const OPENROUTER_MODELS = [
  'google/gemini-3.1-flash-lite-preview',
  'google/gemini-3-flash-preview',
  'google/gemini-2.5-flash-lite',
  'google/gemini-2.5-flash',
  'meta-llama/llama-3.3-70b-instruct',
  'mistralai/mistral-small-3.1-24b-instruct',
];

type JobStatus = 'processing' | 'completed' | 'failed';

interface JobRecord {
  status: JobStatus;
  progress: string;
  result: any | null;
  error: string | null;
  createdAt: number;
  updatedAt: number;
}

interface PipelineSource {
  base64?: string;
  text?: string;
  mimeType?: string;
}

type ContextStatus = 'full_text' | 'abstract_only' | 'upload_required';
type ContextSource = 'openalex' | 'unpaywall' | 'arxiv' | 'semantic_scholar' | 'metadata';

interface FullTextResolution {
  text: string;
  contextStatus: ContextStatus;
  contextSource: ContextSource;
  contextReason: string;
  resolvedUrl: string | null;
  openAlexId?: string | null;
  doi?: string | null;
}

interface PipelineContextMeta {
  sourceKind?: 'upload' | 'imported';
  openAlexId?: string | null;
  doi?: string | null;
  sourceUrl?: string | null;
  title?: string;
  usedFullText?: boolean;
  contextStatus?: ContextStatus;
  contextSource?: ContextSource;
  contextReason?: string;
}

const jobs: Record<string, JobRecord> = {};
const apiBuckets = new Map<string, { count: number; windowStart: number }>();
const fullTextCache = new Map<string, { expiresAt: number; value: FullTextResolution }>();
const demoRunBuckets = new Map<string, { used: number; windowStart: number }>();
const demoChatBuckets = new Map<string, { used: number; windowStart: number }>();

let dbReady = false;
let lastUsedModel = '';

const sql = DB_URL ? neon(DB_URL) : null;

const configuredAuthSecret = (process.env.APP_AUTH_SECRET || '').trim();
const AUTH_SECRET = configuredAuthSecret || (process.env.NODE_ENV === 'production'
  ? (() => {
    throw new Error('APP_AUTH_SECRET is required in production.');
  })()
  : crypto.randomBytes(32).toString('hex'));

if (TRUST_PROXY === 'true') {
  app.set('trust proxy', true);
} else if (TRUST_PROXY && TRUST_PROXY !== 'false') {
  app.set('trust proxy', TRUST_PROXY);
}
app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  const originHeader = req.headers.origin;
  if (!originHeader) {
    if (req.method === 'OPTIONS') {
      res.sendStatus(204);
      return;
    }
    next();
    return;
  }

  if (allowedOrigins.has(originHeader)) {
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Origin', originHeader);
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
    res.setHeader('Access-Control-Max-Age', '86400');
  } else if (req.method === 'OPTIONS') {
    res.status(403).json({ error: 'Origin not allowed by CORS policy.' });
    return;
  }

  if (req.method === 'OPTIONS') {
    res.sendStatus(204);
    return;
  }
  next();
});

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  if (process.env.NODE_ENV === 'production') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob: https:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self' 'unsafe-inline'; connect-src 'self' https:; worker-src 'self' blob:;");
  }
  next();
});

const upload = multer({
  dest: 'uploads/',
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const isPdfType = file.mimetype === 'application/pdf';
    const hasPdfExtension = file.originalname.toLowerCase().endsWith('.pdf');
    if (!isPdfType && !hasPdfExtension) {
      cb(new Error('Only PDF uploads are allowed.'));
      return;
    }
    cb(null, true);
  },
});

function getClientId(req: express.Request): string {
  const ip = String(req.ip || req.socket.remoteAddress || 'unknown').trim();
  return ip || 'unknown';
}

function consumeDemoRunQuotaInMemory(req: express.Request) {
  const clientId = getClientId(req);
  const now = Date.now();
  const existing = demoRunBuckets.get(clientId);
  if (!existing || now - existing.windowStart >= DEMO_DAILY_WINDOW_MS) {
    const next = { used: 1, windowStart: now };
    demoRunBuckets.set(clientId, next);
    return {
      allowed: true,
      used: next.used,
      remaining: Math.max(0, DEMO_DAILY_RUN_LIMIT - next.used),
      resetAt: next.windowStart + DEMO_DAILY_WINDOW_MS,
    };
  }

  if (existing.used >= DEMO_DAILY_RUN_LIMIT) {
    return {
      allowed: false,
      used: existing.used,
      remaining: 0,
      resetAt: existing.windowStart + DEMO_DAILY_WINDOW_MS,
    };
  }

  existing.used += 1;
  demoRunBuckets.set(clientId, existing);
  return {
    allowed: true,
    used: existing.used,
    remaining: Math.max(0, DEMO_DAILY_RUN_LIMIT - existing.used),
    resetAt: existing.windowStart + DEMO_DAILY_WINDOW_MS,
  };
}

function getDemoRunQuotaSnapshotInMemory(req: express.Request) {
  const now = Date.now();
  const clientId = getClientId(req);
  const existing = demoRunBuckets.get(clientId);
  if (!existing || now - existing.windowStart >= DEMO_DAILY_WINDOW_MS) {
    return {
      used: 0,
      remaining: Math.max(0, DEMO_DAILY_RUN_LIMIT),
      resetAt: now + DEMO_DAILY_WINDOW_MS,
    };
  }
  return {
    used: existing.used,
    remaining: Math.max(0, DEMO_DAILY_RUN_LIMIT - existing.used),
    resetAt: existing.windowStart + DEMO_DAILY_WINDOW_MS,
  };
}

function consumeDemoChatQuotaInMemory(req: express.Request) {
  const clientId = getClientId(req);
  const now = Date.now();
  const existing = demoChatBuckets.get(clientId);
  if (!existing || now - existing.windowStart >= DEMO_DAILY_WINDOW_MS) {
    const next = { used: 1, windowStart: now };
    demoChatBuckets.set(clientId, next);
    return {
      allowed: true,
      used: next.used,
      remaining: Math.max(0, DEMO_DAILY_CHAT_LIMIT - next.used),
      resetAt: next.windowStart + DEMO_DAILY_WINDOW_MS,
    };
  }

  if (existing.used >= DEMO_DAILY_CHAT_LIMIT) {
    return {
      allowed: false,
      used: existing.used,
      remaining: 0,
      resetAt: existing.windowStart + DEMO_DAILY_WINDOW_MS,
    };
  }

  existing.used += 1;
  demoChatBuckets.set(clientId, existing);
  return {
    allowed: true,
    used: existing.used,
    remaining: Math.max(0, DEMO_DAILY_CHAT_LIMIT - existing.used),
    resetAt: existing.windowStart + DEMO_DAILY_WINDOW_MS,
  };
}

function getDemoChatQuotaSnapshotInMemory(req: express.Request) {
  const now = Date.now();
  const clientId = getClientId(req);
  const existing = demoChatBuckets.get(clientId);
  if (!existing || now - existing.windowStart >= DEMO_DAILY_WINDOW_MS) {
    return {
      used: 0,
      remaining: Math.max(0, DEMO_DAILY_CHAT_LIMIT),
      resetAt: now + DEMO_DAILY_WINDOW_MS,
    };
  }
  return {
    used: existing.used,
    remaining: Math.max(0, DEMO_DAILY_CHAT_LIMIT - existing.used),
    resetAt: existing.windowStart + DEMO_DAILY_WINDOW_MS,
  };
}

async function consumePersistentQuota(
  quotaType: 'run' | 'chat',
  clientId: string,
  limit: number,
) {
  if (!sql) {
    return quotaType === 'run'
      ? consumeDemoRunQuotaInMemory({ ip: clientId } as any)
      : consumeDemoChatQuotaInMemory({ ip: clientId } as any);
  }

  const now = Date.now();
  await ensureDbReady();
  const rows = await sql`
    INSERT INTO demo_quotas (quota_type, client_id, used, window_start, updated_at)
    VALUES (${quotaType}, ${clientId}, 1, NOW(), NOW())
    ON CONFLICT (quota_type, client_id)
    DO UPDATE SET
      used = CASE
        WHEN EXTRACT(EPOCH FROM (NOW() - demo_quotas.window_start)) * 1000 >= ${DEMO_DAILY_WINDOW_MS}
          THEN 1
        ELSE demo_quotas.used + 1
      END,
      window_start = CASE
        WHEN EXTRACT(EPOCH FROM (NOW() - demo_quotas.window_start)) * 1000 >= ${DEMO_DAILY_WINDOW_MS}
          THEN NOW()
        ELSE demo_quotas.window_start
      END,
      updated_at = NOW()
    RETURNING
      used,
      (EXTRACT(EPOCH FROM window_start) * 1000)::BIGINT AS window_start_ms;
  `;
  const row: any = rows[0] || { used: 1, window_start_ms: now };
  const used = Number(row.used || 0);
  const windowStart = Number(row.window_start_ms || now);
  const allowed = used <= limit;
  return {
    allowed,
    used,
    remaining: Math.max(0, limit - used),
    resetAt: windowStart + DEMO_DAILY_WINDOW_MS,
  };
}

async function getPersistentQuotaSnapshot(
  quotaType: 'run' | 'chat',
  clientId: string,
  limit: number,
) {
  if (!sql) {
    return quotaType === 'run'
      ? getDemoRunQuotaSnapshotInMemory({ ip: clientId } as any)
      : getDemoChatQuotaSnapshotInMemory({ ip: clientId } as any);
  }

  const now = Date.now();
  await ensureDbReady();
  const rows = await sql`
    SELECT
      used,
      (EXTRACT(EPOCH FROM window_start) * 1000)::BIGINT AS window_start_ms
    FROM demo_quotas
    WHERE quota_type = ${quotaType} AND client_id = ${clientId}
    LIMIT 1;
  `;
  if (!rows.length) {
    return {
      used: 0,
      remaining: Math.max(0, limit),
      resetAt: now + DEMO_DAILY_WINDOW_MS,
    };
  }
  const row: any = rows[0];
  const used = Number(row.used || 0);
  const windowStart = Number(row.window_start_ms || now);
  const expired = now - windowStart >= DEMO_DAILY_WINDOW_MS;
  if (expired) {
    return {
      used: 0,
      remaining: Math.max(0, limit),
      resetAt: now + DEMO_DAILY_WINDOW_MS,
    };
  }
  return {
    used,
    remaining: Math.max(0, limit - used),
    resetAt: windowStart + DEMO_DAILY_WINDOW_MS,
  };
}

async function enforceDemoRunQuota(req: express.Request, res: express.Response): Promise<boolean> {
  if (DEMO_DAILY_RUN_LIMIT <= 0) return true;
  const quota = await consumePersistentQuota('run', getClientId(req), DEMO_DAILY_RUN_LIMIT);
  res.setHeader('X-Demo-Run-Limit', String(DEMO_DAILY_RUN_LIMIT));
  res.setHeader('X-Demo-Run-Remaining', String(quota.remaining));
  res.setHeader('X-Demo-Run-Reset-At', String(quota.resetAt));
  if (quota.allowed) return true;
  res.status(429).json({
    error: `Daily demo quota reached (${DEMO_DAILY_RUN_LIMIT} runs per 24h per IP).`,
    code: 'DEMO_QUOTA_EXCEEDED',
    remaining: quota.remaining,
    resetAt: quota.resetAt,
  });
  return false;
}

async function enforceDemoChatQuota(req: express.Request, res: express.Response): Promise<boolean> {
  if (DEMO_DAILY_CHAT_LIMIT <= 0) return true;
  const quota = await consumePersistentQuota('chat', getClientId(req), DEMO_DAILY_CHAT_LIMIT);
  res.setHeader('X-Demo-Chat-Limit', String(DEMO_DAILY_CHAT_LIMIT));
  res.setHeader('X-Demo-Chat-Remaining', String(quota.remaining));
  res.setHeader('X-Demo-Chat-Reset-At', String(quota.resetAt));
  if (quota.allowed) return true;
  res.status(429).json({
    error: `Daily demo chat quota reached (${DEMO_DAILY_CHAT_LIMIT} chat requests per 24h per IP).`,
    code: 'DEMO_CHAT_QUOTA_EXCEEDED',
    remaining: quota.remaining,
    resetAt: quota.resetAt,
  });
  return false;
}

const apiRateLimit = (req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (req.path === '/auth/guest' || req.path.startsWith('/status/')) {
    next();
    return;
  }

  const clientId = getClientId(req);
  const now = Date.now();
  const bucket = apiBuckets.get(clientId);

  if (!bucket || now - bucket.windowStart >= API_RATE_LIMIT_WINDOW_MS) {
    apiBuckets.set(clientId, { count: 1, windowStart: now });
    next();
    return;
  }

  if (bucket.count >= API_RATE_LIMIT_MAX) {
    res.status(429).json({ error: 'Too many requests. Please retry shortly.' });
    return;
  }

  bucket.count += 1;
  apiBuckets.set(clientId, bucket);
  next();
};

app.use('/api', apiRateLimit);

app.post('/api/auth/guest', (_req, res) => {
  const session = issueGuestToken();
  res.json(session);
});

app.use('/api', (req, res, next) => {
  if (!AUTH_REQUIRED) {
    next();
    return;
  }
  if (req.path === '/auth/guest') {
    next();
    return;
  }

  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  if (!token) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  (req as any).auth = payload;
  next();
});

app.get('/api/demo/quota', async (req, res) => {
  try {
    const clientId = getClientId(req);
    const runSnapshot = await getPersistentQuotaSnapshot('run', clientId, DEMO_DAILY_RUN_LIMIT);
    const chatSnapshot = await getPersistentQuotaSnapshot('chat', clientId, DEMO_DAILY_CHAT_LIMIT);
    return res.json({
      limit: DEMO_DAILY_RUN_LIMIT,
      used: runSnapshot.used,
      remaining: runSnapshot.remaining,
      resetAt: runSnapshot.resetAt,
      chatLimit: DEMO_DAILY_CHAT_LIMIT,
      chatUsed: chatSnapshot.used,
      chatRemaining: chatSnapshot.remaining,
      chatResetAt: chatSnapshot.resetAt,
      windowMs: DEMO_DAILY_WINDOW_MS,
    });
  } catch (err: any) {
    console.error('Failed to load demo quota snapshot:', err?.message || err);
    return res.status(500).json({ error: 'Failed to load quota snapshot' });
  }
});

const cleanupFile = (filePath: string) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.error(`Failed to delete file ${filePath}:`, err);
  }
};

const cleanKey = (key: string | undefined) => (key || '').trim().replace(/^['\"]|['\"]$/g, '');

function toBase64Url(value: string | Buffer) {
  return Buffer.from(value)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function fromBase64Url(value: string) {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  return Buffer.from(padded, 'base64').toString('utf8');
}

function signPayload(payload: Record<string, any>) {
  const encoded = toBase64Url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', AUTH_SECRET).update(encoded).digest('base64url');
  return `${encoded}.${sig}`;
}

function verifyToken(token: string) {
  const [encoded, sig] = token.split('.');
  if (!encoded || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', AUTH_SECRET).update(encoded).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expectedSig);
  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return null;
  }
  try {
    const payload = JSON.parse(fromBase64Url(encoded));
    if (!payload?.exp || Date.now() >= payload.exp * 1000) return null;
    return payload;
  } catch {
    return null;
  }
}

function issueGuestToken() {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: `guest-${uuidv4()}`,
    role: 'guest',
    iat: now,
    exp: now + AUTH_TOKEN_TTL_SEC,
  };
  return {
    token: signPayload(payload),
    expiresAt: payload.exp * 1000,
  };
}

function getApiKeys() {
  const geminiKey = cleanKey(process.env.GEMINI_API_KEY);
  const otherKey = cleanKey(process.env.OTHER_API_KEY);

  if (geminiKey) {
    return { primaryKey: geminiKey, fallbackKey: otherKey || undefined };
  }
  if (otherKey) {
    return { primaryKey: otherKey, fallbackKey: undefined };
  }
  throw new Error('No server API key configured. Set GEMINI_API_KEY or OTHER_API_KEY in .env.');
}

const isArrayType = (t: any) => t === Type.ARRAY || t === 'ARRAY';
const isNumberType = (t: any) => t === Type.NUMBER || t === 'NUMBER';

function schemaToFieldDescriptions(schema: any): string {
  return Object.entries(schema?.properties || {})
    .map(([key, val]: [string, any]) => {
      const type = isArrayType(val.type) ? 'array of strings' : isNumberType(val.type) ? 'number' : 'string';
      return `  \"${key}\": (${type}) ${val.description || ''}`;
    })
    .join(', ');
}

function cleanCodeFence(text: string) {
  return text
    .replace(/```json\n?/g, '')
    .replace(/```yaml\n?/g, '')
    .replace(/```python\n?/g, '')
    .replace(/```dockerfile\n?/g, '')
    .replace(/```docker\n?/g, '')
    .replace(/^`{3}[\w-]*\n?/g, '')
    .replace(/`{3}$/g, '')
    .trim();
}

function parseJsonSafely(raw: string): any {
  const cleaned = cleanCodeFence(raw || '');
  try {
    return JSON.parse(cleaned || '{}');
  } catch {
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (!match) return {};
    try {
      return JSON.parse(match[0]);
    } catch {
      return {};
    }
  }
}

function invertedIndexToText(index: any, maxWords = 240): string {
  if (!index || typeof index !== 'object') return '';
  const positions: Array<{ pos: number; word: string }> = [];
  for (const [word, indexes] of Object.entries(index)) {
    if (!Array.isArray(indexes)) continue;
    for (const pos of indexes) {
      if (typeof pos !== 'number') continue;
      positions.push({ pos, word });
    }
  }
  if (!positions.length) return '';
  positions.sort((a, b) => a.pos - b.pos);
  const text = positions.slice(0, maxWords).map((x) => x.word).join(' ');
  return text.replace(/\s+([.,;:!?])/g, '$1').trim();
}

function trimTextForContext(text: string, maxChars = MAX_CONTEXT_CHARS): string {
  if (!text) return '';
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars);
}

function resolveOpenAlexWorkId(rawId: string): string {
  if (!rawId) return '';
  return rawId.includes('openalex.org/') ? rawId : `https://openalex.org/${rawId}`;
}

async function fetchOpenAlexWork(openAlexId: string): Promise<any | null> {
  if (!openAlexId) return null;
  const workId = resolveOpenAlexWorkId(openAlexId);
  const response = await fetch(`https://api.openalex.org/works/${encodeURIComponent(workId)}`, {
    signal: AbortSignal.timeout(FULLTEXT_RESOLVER_TIMEOUT_MS),
  });
  if (!response.ok) return null;
  return response.json();
}

function normalizeDoi(raw: string): string {
  const cleaned = String(raw || '').trim();
  if (!cleaned) return '';
  return cleaned
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .trim()
    .toLowerCase();
}

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeText(text: string): string {
  return String(text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function titleSimilarity(a: string, b: string): number {
  const ta = new Set(normalizeText(a).split(' ').filter(Boolean));
  const tb = new Set(normalizeText(b).split(' ').filter(Boolean));
  if (!ta.size || !tb.size) return 0;
  let intersection = 0;
  for (const token of ta) {
    if (tb.has(token)) intersection += 1;
  }
  const union = new Set([...ta, ...tb]).size;
  return union ? intersection / union : 0;
}

function normalizeArxivId(raw: string): string {
  const value = String(raw || '').trim();
  if (!value) return '';
  const fromUrl = value.match(/arxiv\.org\/(?:abs|pdf)\/([^?#\s]+?)(?:\.pdf)?$/i);
  if (fromUrl?.[1]) return fromUrl[1];
  return value.replace(/^arxiv:/i, '').replace(/\.pdf$/i, '').trim();
}

function getCanonicalPaperKey(input: { openAlexId?: string; doi?: string; title?: string }): string {
  const openAlexId = String(input.openAlexId || '').trim().toLowerCase();
  if (openAlexId) return `openalex:${openAlexId}`;
  const doi = normalizeDoi(input.doi || '');
  if (doi) return `doi:${doi}`;
  const title = normalizeText(input.title || '');
  return title ? `title:${title}` : '';
}

function getCachedFullText(cacheKey: string): FullTextResolution | null {
  if (!cacheKey) return null;
  const hit = fullTextCache.get(cacheKey);
  if (!hit) return null;
  if (Date.now() > hit.expiresAt) {
    fullTextCache.delete(cacheKey);
    return null;
  }
  return hit.value;
}

function setCachedFullText(cacheKey: string, value: FullTextResolution) {
  if (!cacheKey) return;
  fullTextCache.set(cacheKey, {
    value,
    expiresAt: Date.now() + FULLTEXT_CACHE_TTL_MS,
  });
}

function isAllowedRemoteUrl(rawUrl: string): boolean {
  try {
    const u = new URL(rawUrl);
    if (!['http:', 'https:'].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return false;
    if (/^(127\.|10\.|192\.168\.)/.test(host)) return false;
    if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return false;
    return true;
  } catch {
    return false;
  }
}

function pickOpenAccessPdfUrl(work: any): string {
  if (!work) return '';
  if (work.best_oa_location?.pdf_url) return String(work.best_oa_location.pdf_url);
  if (work.primary_location?.pdf_url) return String(work.primary_location.pdf_url);
  const locationHit = Array.isArray(work.locations)
    ? work.locations.find((loc: any) => loc?.pdf_url)
    : null;
  if (locationHit?.pdf_url) return String(locationHit.pdf_url);
  return '';
}

function collectOpenAccessPdfCandidates(work: any): string[] {
  const candidates = new Set<string>();
  if (!work) return [];
  const add = (url: any) => {
    if (!url) return;
    const str = String(url).trim();
    if (!str || !isAllowedRemoteUrl(str)) return;
    candidates.add(str);
  };

  add(pickOpenAccessPdfUrl(work));
  add(work.best_oa_location?.pdf_url);
  add(work.primary_location?.pdf_url);
  if (Array.isArray(work.locations)) {
    for (const loc of work.locations) {
      add(loc?.pdf_url);
      add(loc?.landing_page_url);
    }
  }
  if (work.best_oa_location?.landing_page_url) add(work.best_oa_location.landing_page_url);
  if (work.primary_location?.landing_page_url) add(work.primary_location.landing_page_url);

  const withArxivPdf = new Set<string>();
  for (const url of candidates) {
    withArxivPdf.add(url);
    const arxivId = normalizeArxivId(url);
    if (arxivId) withArxivPdf.add(`https://arxiv.org/pdf/${arxivId}.pdf`);
  }
  return Array.from(withArxivPdf);
}

async function fetchOpenAlexWorkByDoi(doi: string): Promise<any | null> {
  const normalizedDoi = normalizeDoi(doi);
  if (!normalizedDoi) return null;
  const variants = [normalizedDoi, `https://doi.org/${normalizedDoi}`];
  for (const candidate of variants) {
    const response = await fetch(
      `https://api.openalex.org/works?filter=doi:${encodeURIComponent(candidate)}&per-page=1`,
      { signal: AbortSignal.timeout(FULLTEXT_RESOLVER_TIMEOUT_MS) },
    );
    if (!response.ok) continue;
    const payload: any = await response.json();
    if (Array.isArray(payload?.results) && payload.results[0]) return payload.results[0];
  }
  return null;
}

async function fetchOpenAlexWorkByTitle(title: string): Promise<any | null> {
  const normalizedTitle = normalizeText(title);
  if (!normalizedTitle || normalizedTitle.length < 8) return null;
  const response = await fetch(
    `https://api.openalex.org/works?search=${encodeURIComponent(title)}&sort=relevance_score:desc&per-page=3`,
    { signal: AbortSignal.timeout(FULLTEXT_RESOLVER_TIMEOUT_MS) },
  );
  if (!response.ok) return null;
  const payload: any = await response.json();
  const results = Array.isArray(payload?.results) ? payload.results : [];
  if (!results.length) return null;
  const ranked = results
    .map((work: any) => ({ work, score: titleSimilarity(title, String(work?.title || '')) }))
    .sort((a: any, b: any) => b.score - a.score);
  return ranked[0]?.score >= 0.6 ? ranked[0].work : null;
}

async function extractTextFromRemotePdf(
  pdfUrl: string,
  timeoutMs = FULLTEXT_RESOLVER_TIMEOUT_MS,
): Promise<{ text: string; reason: string; resolvedUrl: string | null }> {
  if (!pdfUrl || !isAllowedRemoteUrl(pdfUrl)) {
    return { text: '', reason: 'invalid_url', resolvedUrl: null };
  }

  try {
    const response = await fetch(pdfUrl, {
      redirect: 'follow',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      return { text: '', reason: `http_${response.status}`, resolvedUrl: response.url || pdfUrl };
    }

    const resolvedUrl = response.url || pdfUrl;
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length < 8) return { text: '', reason: 'empty_body', resolvedUrl };

    const hasPdfMagicBytes = buffer.subarray(0, 4).toString() === '%PDF';
    const looksLikePdfByType = contentType.includes('pdf') || contentType.includes('application/octet-stream');
    const looksLikePdfByUrl = resolvedUrl.toLowerCase().includes('.pdf');
    if (!hasPdfMagicBytes && !looksLikePdfByType && !looksLikePdfByUrl) {
      return { text: '', reason: 'non_pdf', resolvedUrl };
    }
    if (!hasPdfMagicBytes) {
      return { text: '', reason: 'invalid_pdf', resolvedUrl };
    }

    const text = trimTextForContext(await extractTextFromPdfBuffer(buffer));
    if (!text || text.length < 120) {
      return { text: '', reason: 'parse_failed', resolvedUrl };
    }
    return { text, reason: 'ok', resolvedUrl };
  } catch (err: any) {
    const message = String(err?.name || err?.message || '');
    if (message.toLowerCase().includes('timeout')) {
      return { text: '', reason: 'timeout', resolvedUrl: pdfUrl };
    }
    return { text: '', reason: 'fetch_failed', resolvedUrl: pdfUrl };
  }
}

async function fetchUnpaywallPdfCandidates(doi: string): Promise<string[]> {
  const normalizedDoi = normalizeDoi(doi);
  if (!normalizedDoi || !UNPAYWALL_EMAIL) return [];
  try {
    const response = await fetch(
      `https://api.unpaywall.org/v2/${encodeURIComponent(normalizedDoi)}?email=${encodeURIComponent(UNPAYWALL_EMAIL)}`,
      { signal: AbortSignal.timeout(FULLTEXT_RESOLVER_TIMEOUT_MS) },
    );
    if (!response.ok) return [];
    const payload: any = await response.json();
    const candidates = new Set<string>();
    const add = (url: any) => {
      if (!url) return;
      const str = String(url).trim();
      if (!str || !isAllowedRemoteUrl(str)) return;
      candidates.add(str);
    };
    add(payload?.best_oa_location?.url_for_pdf);
    add(payload?.best_oa_location?.url);
    if (Array.isArray(payload?.oa_locations)) {
      for (const location of payload.oa_locations) {
        add(location?.url_for_pdf);
        add(location?.url);
      }
    }
    return Array.from(candidates);
  } catch {
    return [];
  }
}

async function resolveArxivIdByTitle(title: string): Promise<string> {
  const cleaned = String(title || '').trim();
  if (!cleaned || cleaned.length < 8) return '';
  try {
    const response = await fetch(
      `https://export.arxiv.org/api/query?search_query=all:${encodeURIComponent(cleaned)}&start=0&max_results=5`,
      { signal: AbortSignal.timeout(FULLTEXT_RESOLVER_TIMEOUT_MS) },
    );
    if (!response.ok) return '';
    const xml = await response.text();
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1]);
    let best: { id: string; score: number } = { id: '', score: 0 };
    for (const entry of entries) {
      const idMatch = entry.match(/<id>\s*https?:\/\/arxiv\.org\/abs\/([^<\s]+)\s*<\/id>/i);
      const titleMatch = entry.match(/<title>([\s\S]*?)<\/title>/i);
      if (!idMatch?.[1] || !titleMatch?.[1]) continue;
      const candidateTitle = decodeXmlEntities(titleMatch[1]).replace(/\s+/g, ' ').trim();
      const score = titleSimilarity(cleaned, candidateTitle);
      if (score > best.score) best = { id: idMatch[1].trim(), score };
    }
    return best.score >= 0.62 ? best.id : '';
  } catch {
    return '';
  }
}

async function fetchSemanticScholarPdfCandidates(input: { doi?: string; title?: string }): Promise<string[]> {
  const headers: Record<string, string> = {};
  if (SEMANTIC_SCHOLAR_API_KEY) headers['x-api-key'] = SEMANTIC_SCHOLAR_API_KEY;
  const candidates = new Set<string>();
  const add = (url: any) => {
    if (!url) return;
    const str = String(url).trim();
    if (!str || !isAllowedRemoteUrl(str)) return;
    candidates.add(str);
  };

  const doi = normalizeDoi(input.doi || '');
  if (doi) {
    try {
      const doiRes = await fetch(
        `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(doi)}?fields=title,openAccessPdf`,
        { headers, signal: AbortSignal.timeout(FULLTEXT_RESOLVER_TIMEOUT_MS) },
      );
      if (doiRes.ok) {
        const doiPayload: any = await doiRes.json();
        add(doiPayload?.openAccessPdf?.url);
      }
    } catch {
      // no-op: title fallback below
    }
  }

  const title = String(input.title || '').trim();
  if (!title || candidates.size) return Array.from(candidates);
  try {
    const searchRes = await fetch(
      `https://api.semanticscholar.org/graph/v1/paper/search?query=${encodeURIComponent(title)}&limit=5&fields=title,openAccessPdf`,
      { headers, signal: AbortSignal.timeout(FULLTEXT_RESOLVER_TIMEOUT_MS) },
    );
    if (!searchRes.ok) return Array.from(candidates);
    const payload: any = await searchRes.json();
    const rows = Array.isArray(payload?.data) ? payload.data : [];
    const ranked = rows
      .map((row: any) => ({ row, score: titleSimilarity(title, String(row?.title || '')) }))
      .sort((a: any, b: any) => b.score - a.score);
    if (ranked[0]?.score >= 0.6) add(ranked[0]?.row?.openAccessPdf?.url);
  } catch {
    // ignore provider failures; resolver continues
  }
  return Array.from(candidates);
}

function buildContextNotice(status: ContextStatus, reason: string): string {
  if (status === 'full_text') {
    return 'Using open-access full paper context for interrogation.';
  }
  if (status === 'abstract_only') {
    return `Full paper unavailable (${reason}). Answering from abstract/metadata. Upload the PDF for full-paper interrogation.`;
  }
  return `Full paper unavailable (${reason}). Upload the PDF to interrogate the complete paper.`;
}

async function resolvePaperFullText(
  input: { openAlexId?: string; doi?: string; title?: string; sourceUrl?: string },
  options: { forceRefresh?: boolean } = {},
): Promise<FullTextResolution> {
  const cacheKey = getCanonicalPaperKey(input);
  if (!options.forceRefresh && cacheKey) {
    const cached = getCachedFullText(cacheKey);
    if (cached) return cached;
  }

  let resolvedOpenAlexId = String(input.openAlexId || '').trim() || null;
  let resolvedDoi = normalizeDoi(input.doi || '') || null;
  let resolvedTitle = String(input.title || '').trim();
  let work: any = null;
  let lastReason = 'no_pdf_link';

  if (resolvedOpenAlexId) {
    work = await fetchOpenAlexWork(resolvedOpenAlexId);
  } else if (resolvedDoi) {
    work = await fetchOpenAlexWorkByDoi(resolvedDoi);
  } else if (resolvedTitle) {
    work = await fetchOpenAlexWorkByTitle(resolvedTitle);
  }

  if (work) {
    resolvedOpenAlexId = String(work?.id || resolvedOpenAlexId || '').trim() || resolvedOpenAlexId;
    resolvedDoi = normalizeDoi(work?.doi || work?.ids?.doi || resolvedDoi || '') || resolvedDoi;
    resolvedTitle = String(work?.title || resolvedTitle || '').trim() || resolvedTitle;
  }

  const tryCandidates = async (candidates: string[], source: ContextSource): Promise<FullTextResolution | null> => {
    for (const url of candidates) {
      const extraction = await extractTextFromRemotePdf(url);
      if (extraction.text) {
        return {
          text: extraction.text,
          contextStatus: 'full_text',
          contextSource: source,
          contextReason: 'ok',
          resolvedUrl: extraction.resolvedUrl || url,
          openAlexId: resolvedOpenAlexId || null,
          doi: resolvedDoi || null,
        };
      }
      lastReason = extraction.reason || 'fetch_failed';
    }
    return null;
  };

  const openAlexCandidates = collectOpenAccessPdfCandidates(work);
  if (input.sourceUrl && isAllowedRemoteUrl(input.sourceUrl)) {
    openAlexCandidates.push(String(input.sourceUrl).trim());
  }
  const openAlexResolved = await tryCandidates(Array.from(new Set(openAlexCandidates)), 'openalex');
  if (openAlexResolved) {
    if (cacheKey) setCachedFullText(cacheKey, openAlexResolved);
    return openAlexResolved;
  }

  if (resolvedDoi && UNPAYWALL_EMAIL) {
    const unpaywallCandidates = await fetchUnpaywallPdfCandidates(resolvedDoi);
    const unpaywallResolved = await tryCandidates(unpaywallCandidates, 'unpaywall');
    if (unpaywallResolved) {
      if (cacheKey) setCachedFullText(cacheKey, unpaywallResolved);
      return unpaywallResolved;
    }
  }

  const arxivIdFromOpenAlex = normalizeArxivId(work?.ids?.arxiv || work?.best_oa_location?.landing_page_url || '');
  let arxivId = arxivIdFromOpenAlex;
  if (!arxivId && resolvedTitle) {
    arxivId = await resolveArxivIdByTitle(resolvedTitle);
  }
  if (arxivId) {
    const arxivCandidates = [`https://arxiv.org/pdf/${arxivId}.pdf`];
    const arxivResolved = await tryCandidates(arxivCandidates, 'arxiv');
    if (arxivResolved) {
      if (cacheKey) setCachedFullText(cacheKey, arxivResolved);
      return arxivResolved;
    }
  }

  const semanticCandidates = await fetchSemanticScholarPdfCandidates({ doi: resolvedDoi || undefined, title: resolvedTitle || undefined });
  const semanticResolved = await tryCandidates(semanticCandidates, 'semantic_scholar');
  if (semanticResolved) {
    if (cacheKey) setCachedFullText(cacheKey, semanticResolved);
    return semanticResolved;
  }

  const closedAccess = work?.open_access?.is_oa === false;
  const fallback: FullTextResolution = {
    text: '',
    contextStatus: 'upload_required',
    contextSource: 'metadata',
    contextReason: closedAccess ? 'closed_access' : (lastReason || 'no_pdf_link'),
    resolvedUrl: String(work?.primary_location?.landing_page_url || input.sourceUrl || '').trim() || null,
    openAlexId: resolvedOpenAlexId || null,
    doi: resolvedDoi || null,
  };
  if (cacheKey) setCachedFullText(cacheKey, fallback);
  return fallback;
}

async function extractTextFromPdfBuffer(fileData: Buffer): Promise<string> {
  try {
    const pdfjsLib: any = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(fileData) }).promise;
    let fullText = '';
    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();
      fullText += textContent.items.map((item: any) => item.str).join(' ') + '\n';
    }
    return fullText;
  } catch (err) {
    console.warn('PDF text extraction failed in backend, continuing with base64-only path where supported.');
    return '';
  }
}

async function generateUniversalContent(
  apiKey: string,
  prompt: string,
  pdfData?: { base64?: string; text?: string; mimeType?: string },
  schema?: any,
  temperature = 0.2,
): Promise<string> {
  if (!apiKey || apiKey === 'undefined' || apiKey === 'null') {
    throw new Error('Invalid API key');
  }

  const isGemini = apiKey.startsWith('AIza');
  const isAnthropic = apiKey.startsWith('sk-ant');
  const isGroq = apiKey.startsWith('gsk_');
  const isOpenRouter = apiKey.startsWith('sk-or') || apiKey.includes('openrouter.ai');

  if (isGemini) {
    const ai = new GoogleGenAI({ apiKey });
    const contents: any[] = [];
    if (pdfData?.base64) {
      contents.push({ inlineData: { data: pdfData.base64, mimeType: pdfData.mimeType || 'application/pdf' } });
    } else if (pdfData?.text) {
      contents.push({ text: `Document Text:\n${pdfData.text}` });
    }
    contents.push({ text: prompt });

    const attempts: string[] = [];
    for (const model of GEMINI_MODELS) {
      try {
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            temperature,
            ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {}),
          },
        });
        lastUsedModel = `Gemini: ${model}`;
        return response.text || '';
      } catch (e: any) {
        const reason = e?.message?.includes('429') ? '429 Quota Exceeded' : e?.message?.includes('404') ? '404 Not Found' : (e?.message?.slice(0, 80) || 'Unknown error');
        attempts.push(`X ${model}: ${reason}`);
        if (e?.status === 429 || e?.status === 'RESOURCE_EXHAUSTED' || e?.message?.includes('429')) continue;
        throw e;
      }
    }
    const err = new Error('GEMINI_QUOTA_EXHAUSTED');
    (err as any).attempts = attempts;
    throw err;
  }

  if (isAnthropic) {
    const anthropic = new Anthropic({ apiKey });
    let contentStr = prompt;
    if (pdfData?.text) contentStr = `Document Text:\n${pdfData.text}\n\nTask:\n${prompt}`;
    if (schema) {
      contentStr += `\n\nYou MUST return ONLY valid JSON (no markdown, no code blocks). The JSON object must have exactly these fields:\n{ ${schemaToFieldDescriptions(schema)} }`;
    }

    const msg = await anthropic.messages.create({
      model: 'claude-3-5-sonnet-20241022',
      max_tokens: 8192,
      temperature,
      messages: [{ role: 'user', content: contentStr }],
    });
    lastUsedModel = 'Anthropic: claude-3.5-sonnet';
    return cleanCodeFence((msg.content[0] as any).text || '');
  }

  const baseURL = isGroq ? 'https://api.groq.com/openai/v1' : isOpenRouter ? 'https://openrouter.ai/api/v1' : undefined;
  const models = isOpenRouter ? OPENROUTER_MODELS : [isGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o'];
  const attempts: string[] = [];

  for (const model of models) {
    try {
      const openai = new OpenAI({ apiKey, baseURL });
      let contentStr = prompt;
      if (pdfData?.text) contentStr = `Document Text:\n${pdfData.text}\n\nTask:\n${prompt}`;
      if (schema && (isGroq || isOpenRouter)) {
        contentStr += `\n\nYou MUST return ONLY valid JSON (no markdown, no code blocks). The JSON object must have exactly these fields:\n{ ${schemaToFieldDescriptions(schema)} }`;
      }

      const response = await openai.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: 'You are an expert ML researcher. Follow instructions exactly.' },
          { role: 'user', content: contentStr },
        ],
        temperature,
        ...(schema && !isOpenRouter ? { response_format: { type: 'json_object' as const } } : {}),
      });

      lastUsedModel = isOpenRouter ? `OpenRouter: ${model}` : isGroq ? `Groq: ${model}` : `OpenAI: ${model}`;
      return cleanCodeFence(response.choices[0].message.content || '');
    } catch (e: any) {
      const reason = e?.message?.includes('429') ? '429 Rate Limited' : e?.message?.includes('404') ? '404 Not Found' : (e?.message?.slice(0, 80) || 'Unknown error');
      attempts.push(`X ${model}: ${reason}`);
      if (isOpenRouter && models.indexOf(model) < models.length - 1) continue;
      const err = new Error(`All models exhausted.\n${attempts.join('\n')}`);
      (err as any).attempts = attempts;
      throw err;
    }
  }

  throw new Error('No model available');
}

async function generateWithFallbackKey(
  prompt: string,
  pdfData?: { base64?: string; text?: string; mimeType?: string },
  schema?: any,
  temperature = 0.2,
): Promise<string> {
  const { primaryKey, fallbackKey } = getApiKeys();
  const attempts: string[] = [];

  try {
    return await generateUniversalContent(primaryKey, prompt, pdfData, schema, temperature);
  } catch (e: any) {
    if (e?.attempts) attempts.push(...e.attempts);
    if (e?.message === 'GEMINI_QUOTA_EXHAUSTED' && fallbackKey) {
      try {
        return await generateUniversalContent(fallbackKey, prompt, pdfData, schema, temperature);
      } catch (e2: any) {
        if (e2?.attempts) attempts.push(...e2.attempts);
      }
    }

    if (attempts.length) throw new Error(`All provider attempts failed.\n${attempts.join('\n')}`);
    throw e;
  }
}

async function ensureDbReady() {
  if (!sql || dbReady) return;

  await sql`
    CREATE TABLE IF NOT EXISTS generation_runs (
      id BIGSERIAL PRIMARY KEY,
      job_id TEXT UNIQUE NOT NULL,
      status TEXT NOT NULL,
      filename TEXT,
      active_model TEXT,
      error TEXT,
      metadata JSONB,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `;

  await sql`
    CREATE TABLE IF NOT EXISTS demo_quotas (
      quota_type TEXT NOT NULL,
      client_id TEXT NOT NULL,
      used INTEGER NOT NULL DEFAULT 0,
      window_start TIMESTAMPTZ NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (quota_type, client_id)
    );
  `;

  dbReady = true;
}

async function persistRun(jobId: string, patch: Partial<JobRecord> & { filename?: string; activeModel?: string; metadata?: any }) {
  if (!sql) return;

  try {
    await ensureDbReady();
    await sql`
      INSERT INTO generation_runs (job_id, status, filename, active_model, error, metadata, updated_at)
      VALUES (
        ${jobId},
        ${patch.status || 'processing'},
        ${patch.filename || null},
        ${patch.activeModel || null},
        ${patch.error || null},
        ${JSON.stringify(patch.metadata || {})}::jsonb,
        NOW()
      )
      ON CONFLICT (job_id)
      DO UPDATE SET
        status = EXCLUDED.status,
        filename = COALESCE(EXCLUDED.filename, generation_runs.filename),
        active_model = COALESCE(EXCLUDED.active_model, generation_runs.active_model),
        error = EXCLUDED.error,
        metadata = EXCLUDED.metadata,
        updated_at = NOW();
    `;
  } catch (err) {
    console.warn('Neon persistence failed:', (err as any)?.message || err);
  }
}

function updateJob(jobId: string, patch: Partial<JobRecord>) {
  if (!jobs[jobId]) return;
  jobs[jobId] = {
    ...jobs[jobId],
    ...patch,
    updatedAt: Date.now(),
  };
}

function slugifyName(value: string): string {
  return String(value || 'tldrun-project')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'tldrun-project';
}

function ensureConfigHasSmokeDefaults(configYaml: string): string {
  const cleaned = cleanCodeFence(configYaml || '');
  const hasSmoke = /(^|\n)\s*smoke(\s*:|_mode\s*:)/i.test(cleaned);
  if (hasSmoke) return cleaned;
  return `${cleaned}\n\nruntime:\n  smoke: true\n  seed: 42\n  max_steps: 3\n`;
}

function injectSmokeSupport(trainScript: string): string {
  const cleaned = cleanCodeFence(trainScript || '');
  if (/--smoke/.test(cleaned) || /\bsmoke\b/i.test(cleaned)) return cleaned;
  const lines = cleaned.split('\n');
  const insertionIndex = lines.findIndex((line) => !line.startsWith('#!') && !line.startsWith('# -*-') && !line.startsWith('from __future__'));
  const snippet = [
    'import sys',
    '',
    '# Deterministic smoke mode for reproducibility checks from generated ZIP scripts.',
    'if "--smoke" in sys.argv:',
    '    print("SMOKE_OK: train.py --smoke completed (baseline smoke path).")',
    '    sys.exit(0)',
    '',
  ];
  const index = insertionIndex <= 0 ? 0 : insertionIndex;
  lines.splice(index, 0, ...snippet);
  return lines.join('\n');
}

function buildFallbackTrainPy(pipeline: any): string {
  const concept = String(pipeline?.core_concept || 'paper implementation').trim();
  return `import argparse
import random
import time


def run_smoke():
    random.seed(42)
    print("SMOKE_OK: deterministic smoke run")
    print("Concept:", ${JSON.stringify(concept)})
    for step in range(1, 4):
      print(f"step={step} loss={1.0/step:.4f}")
      time.sleep(0.05)


def run_train():
    # TODO: Replace this scaffold with paper-specific training logic.
    print("INFO: baseline training scaffold is active.")
    run_smoke()


def main():
    parser = argparse.ArgumentParser(description="TL;DRun generated scaffold")
    parser.add_argument("--smoke", action="store_true", help="Run deterministic smoke test")
    args = parser.parse_args()
    if args.smoke:
      run_smoke()
      return
    run_train()


if __name__ == "__main__":
    main()
`;
}

function ensureRequirements(requirementsText: string): string {
  const base = cleanCodeFence(requirementsText || '');
  const rows = new Set(base.split('\n').map((x) => x.trim()).filter(Boolean));
  if (![...rows].some((row) => row.toLowerCase().startsWith('torch'))) rows.add('torch');
  if (![...rows].some((row) => row.toLowerCase().startsWith('pyyaml'))) rows.add('pyyaml');
  return Array.from(rows).join('\n') + '\n';
}

function ensureDockerfile(dockerfileText: string): string {
  const cleaned = cleanCodeFence(dockerfileText || '');
  if (cleaned && /FROM\s+/i.test(cleaned)) return cleaned;
  return `FROM python:3.10-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY . .
CMD ["python", "train.py", "--smoke"]
`;
}

function buildHowToImplementFile(pipeline: any): string {
  return [
    'TL;DRun HOW_TO_IMPLEMENT',
    '',
    '1) Bootstrap environment:',
    '   - bash scripts/bootstrap_venv.sh',
    '',
    '2) Run smoke verification (must pass first):',
    '   - bash scripts/smoke_test.sh',
    '',
    '3) Inspect config and TODO markers:',
    '   - config.yaml',
    '   - train.py',
    '',
    '4) Implement paper-specific logic in small steps:',
    `   - Datasets: ${String(pipeline?.datasets || 'TODO')}`,
    `   - Preprocessing: ${String(pipeline?.preprocessing || 'TODO')}`,
    `   - Architecture: ${String(pipeline?.model_architecture || 'TODO')}`,
    `   - Training procedure: ${String(pipeline?.training_procedure || 'TODO')}`,
    '',
    '5) Re-run smoke after each significant change.',
    '',
    '6) Execute full run:',
    '   - bash scripts/run_train.sh',
    '',
    '7) Docker path (optional):',
    '   - bash scripts/docker_build.sh',
    '   - bash scripts/docker_run.sh smoke',
    '   - bash scripts/docker_run.sh train',
    '',
    'Expected: smoke output contains SMOKE_OK and SMOKE_TEST_PASS.',
  ].join('\n');
}

function enforceRepositoryQuality(files: Record<string, string>, pipeline: any) {
  files['config.yaml'] = ensureConfigHasSmokeDefaults(files['config.yaml'] || '');
  files['train.py'] = injectSmokeSupport(files['train.py'] || buildFallbackTrainPy(pipeline));
  files['requirements.txt'] = ensureRequirements(files['requirements.txt'] || '');
  files['Dockerfile'] = ensureDockerfile(files['Dockerfile'] || '');
  if (!files['README.md']) {
    files['README.md'] = '# Generated Repository\n\nUse RUNBOOK.md and HOW_TO_IMPLEMENT.txt to execute and iterate.\n';
  }
  files['HOW_TO_IMPLEMENT.txt'] = buildHowToImplementFile(pipeline);
}

function buildReproArtifacts(projectLabel: string): Record<string, string> {
  const imageTag = `tldrun-${slugifyName(projectLabel)}:latest`;
  const bootstrapVenv = `#!/usr/bin/env bash
set -euo pipefail
PYTHON_BIN="\${PYTHON_BIN:-python3}"

if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
  echo "ERROR: Python 3.10+ is required."
  exit 1
fi

"$PYTHON_BIN" -m venv .venv
source .venv/bin/activate
python -m pip install --upgrade pip wheel
pip install -r requirements.txt
echo "VENV_READY: dependencies installed."
`;

  const runTrain = `#!/usr/bin/env bash
set -euo pipefail
if [[ -d ".venv" ]]; then
  source .venv/bin/activate
fi
python train.py "$@"
`;

  const smokeTest = `#!/usr/bin/env bash
set -euo pipefail
if [[ -d ".venv" ]]; then
  source .venv/bin/activate
fi
python train.py --smoke "$@"
echo "SMOKE_TEST_PASS: baseline smoke mode completed."
`;

  const dockerBuild = `#!/usr/bin/env bash
set -euo pipefail
docker build -t ${imageTag} .
echo "DOCKER_IMAGE_READY: ${imageTag}"
`;

  const dockerRun = `#!/usr/bin/env bash
set -euo pipefail
MODE="\${1:-smoke}"
shift || true

if [[ "$MODE" == "smoke" ]]; then
  docker run --rm -it ${imageTag} python train.py --smoke "$@"
elif [[ "$MODE" == "train" ]]; then
  docker run --rm -it ${imageTag} python train.py "$@"
else
  docker run --rm -it ${imageTag} "$MODE" "$@"
fi
`;

  const makefile = `setup:
\tbash scripts/bootstrap_venv.sh

smoke:
\tbash scripts/smoke_test.sh

train:
\tbash scripts/run_train.sh

docker-build:
\tbash scripts/docker_build.sh

docker-run:
\tbash scripts/docker_run.sh smoke
`;

  const runbook = `# RUNBOOK

This bundle includes deterministic reproduction scripts.

## Quickstart (venv)
\`\`\`bash
chmod +x scripts/*.sh
./scripts/bootstrap_venv.sh
./scripts/smoke_test.sh
./scripts/run_train.sh
\`\`\`

Expected smoke output contains:
- \`SMOKE_OK\`
- \`SMOKE_TEST_PASS\`

## Quickstart (Docker)
\`\`\`bash
chmod +x scripts/*.sh
./scripts/docker_build.sh
./scripts/docker_run.sh smoke
./scripts/docker_run.sh train
\`\`\`

## Notes
- Smoke mode is designed to run without external datasets.
- Use \`./scripts/run_train.sh --help\` for extra train args.
`;

  return {
    'scripts/bootstrap_venv.sh': bootstrapVenv,
    'scripts/run_train.sh': runTrain,
    'scripts/smoke_test.sh': smokeTest,
    'scripts/docker_build.sh': dockerBuild,
    'scripts/docker_run.sh': dockerRun,
    'Makefile': makefile,
    'RUNBOOK.md': runbook,
  };
}

async function runPipelineForJob(jobId: string, source: PipelineSource, sourceLabel: string, contextMeta: PipelineContextMeta = {}) {
  const updateProgress = (msg: string) => {
    updateJob(jobId, { progress: msg });
    console.log(`[Job ${jobId}] ${msg}`);
  };

  const wrapper = {
    base64: source.base64,
    text: trimTextForContext(source.text || ''),
    mimeType: source.mimeType || 'application/pdf',
  };

  updateProgress('Step 1/5: Analyzing ML pipeline...');
  const pipelineSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      datasets: { type: Type.STRING, description: 'Datasets used' },
      preprocessing: { type: Type.STRING, description: 'Data preprocessing steps' },
      model_architecture: { type: Type.STRING, description: 'Model architecture details' },
      training_procedure: { type: Type.STRING, description: 'Training procedure (optimizer, loss, epochs, etc.)' },
      hyperparameters: { type: Type.STRING, description: 'Key hyperparameters' },
      evaluation_protocol: { type: Type.STRING, description: 'Evaluation metrics and protocol' },
      assumptions: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Assumptions made' },
      reproducibility_score: { type: Type.NUMBER, description: 'Score from 0 to 100 on reproducibility.' },
      missing_secrets: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'Crucial missing details.' },
      hardware_reality: { type: Type.STRING, description: 'Compute, dollar cost estimate, and carbon footprint.' },
      anti_hype_summary: { type: Type.STRING, description: 'Honest summary of achievement.' },
      core_concept: { type: Type.STRING, description: 'A 2-4 word phrase representing the paper core concept.' },
      prerequisite_papers: { type: Type.ARRAY, items: { type: Type.STRING }, description: '2-3 foundational papers required before this one.' },
      architecture_mermaid: { type: Type.STRING, description: 'Valid mermaid flowchart TD syntax.' },
    },
    required: ['datasets', 'preprocessing', 'model_architecture', 'training_procedure', 'hyperparameters', 'evaluation_protocol', 'assumptions', 'reproducibility_score', 'missing_secrets', 'hardware_reality', 'anti_hype_summary', 'core_concept', 'prerequisite_papers', 'architecture_mermaid'],
  };

  const extractorPrompt = 'You are an expert ML researcher and a brutal peer reviewer. Extract the training pipeline. Do not hallucinate numbers. Also provide anti-hype summary, hardware/cost/carbon reality, missing secrets, prerequisite papers, mermaid architecture, and reproducibility score 0-100.';
  const pipelineText = await generateWithFallbackKey(extractorPrompt, wrapper, pipelineSchema, 0.2);
  const pipeline = parseJsonSafely(pipelineText);

  const files: Record<string, string> = {};

  updateProgress('Step 2/5: Generating config.yaml...');
  const configPrompt = `Generate a config.yaml for this ML pipeline with runnable defaults. Requirements: include a deterministic smoke-mode config that runs without external datasets (synthetic/random tiny data, 1-3 steps), and include placeholders like "TODO: specify" only when unavoidable. Pipeline details: ${JSON.stringify(pipeline)}`;
  const configYaml = await generateWithFallbackKey(configPrompt, undefined, undefined, 0.2);
  files['config.yaml'] = ensureConfigHasSmokeDefaults(configYaml);

  updateProgress('Step 3/5: Generating PyTorch code skeleton...');
  const codePrompt = `Generate a clean, modular PyTorch training script (train.py) based on this config and pipeline. Requirements: include argparse, support "--smoke" mode (no external datasets, tiny synthetic batch, exits successfully), include data loading, model init, and training loop, and add '# TODO:' where needed. Config:\n${files['config.yaml']}\nPipeline:\n${JSON.stringify(pipeline)}`;
  const codeRes = await generateWithFallbackKey(codePrompt, undefined, undefined, 0.2);
  files['train.py'] = injectSmokeSupport(codeRes);

  updateProgress('Step 4/5: Generating Dockerfile and requirements...');
  const envPrompt = `Generate a Dockerfile (CPU runnable by default) and requirements.txt for this PyTorch project. Return them separated by \"---REQUIREMENTS---\". Code:\n${files['train.py']}`;
  const envRes = await generateWithFallbackKey(envPrompt, undefined, undefined, 0.2);
  const envParts = envRes.split('---REQUIREMENTS---');
  files['Dockerfile'] = cleanCodeFence(envParts[0] || '');
  files['requirements.txt'] = cleanCodeFence(envParts[1] || '');

  const notebookJson = {
    cells: [
      { cell_type: 'markdown', metadata: {}, source: ['# TL;DRun Training Pipeline\\n', 'Auto-generated runnable environment.\\n'] },
      { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: ['# Install dependencies\\n', `!pip install ${files['requirements.txt'].split('\\n').filter(Boolean).join(' ')}`] },
      { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [files['train.py']] },
    ],
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    nbformat: 4,
    nbformat_minor: 4,
  };
  files['train.ipynb'] = JSON.stringify(notebookJson, null, 2);

  updateProgress('Step 5/5: Generating README.md...');
  const readmePrompt = `Generate a README.md for this repository. Explain build/run with both Python venv and Docker. Mention smoke testing via "python train.py --smoke". Include anti-hype summary and reproducibility score. Pipeline:\n${JSON.stringify(pipeline)}`;
  const generatedReadme = cleanCodeFence(await generateWithFallbackKey(readmePrompt, undefined, undefined, 0.2));
  files['README.md'] = `${generatedReadme}\n\n## Reproduction Shortcuts\n- Runbook: \`RUNBOOK.md\`\n- Scripts: \`scripts/bootstrap_venv.sh\`, \`scripts/smoke_test.sh\`, \`scripts/run_train.sh\`, \`scripts/docker_build.sh\`, \`scripts/docker_run.sh\`\n`;
  files['prompt.txt'] = `## SYSTEM PROMPT AUTOGENERATED BY TL;DRun\\n\\n${codePrompt}`;
  Object.assign(files, buildReproArtifacts(sourceLabel));
  enforceRepositoryQuality(files, pipeline);

  updateProgress('Step 6: Finding related papers...');
  let similarPapers: Array<{ title: string; abstract: string; url: string; year: number }> = [];
  try {
    if (pipeline?.core_concept) {
      const conceptStr = encodeURIComponent(String(pipeline.core_concept));
      const oaRes = await fetch(`https://api.openalex.org/works?search=${conceptStr}&sort=cited_by_count:desc&per-page=3`);
      if (oaRes.ok) {
        const oaData: any = await oaRes.json();
        similarPapers = (oaData.results || []).map((r: any) => ({
          title: r.title,
          abstract: r.abstract_inverted_index ? Object.keys(r.abstract_inverted_index).slice(0, 30).join(' ') + '...' : 'No abstract available.',
          url: r.primary_location?.landing_page_url || r.id,
          year: r.publication_year,
        }));
      }
    }
  } catch (err) {
    console.warn('OpenAlex related-work lookup failed:', (err as any)?.message || err);
  }

  updateProgress('Packaging repository...');

  updateJob(jobId, {
    status: 'completed',
    progress: 'Done',
    error: null,
    result: {
      pipeline,
      files,
      pdfText: wrapper.text,
      similarPapers,
      activeModel: lastUsedModel,
      paperContext: contextMeta,
    },
  });

  await persistRun(jobId, {
    status: 'completed',
    filename: sourceLabel,
    activeModel: lastUsedModel,
    metadata: { pipelineKeys: Object.keys(pipeline || {}), fileCount: Object.keys(files).length, source: sourceLabel },
  });
}

async function processPaper(jobId: string, filePath: string, fileName: string, mimeType: string) {
  const fileData = fs.readFileSync(filePath);
  const base64Data = fileData.toString('base64');
  const pdfText = await extractTextFromPdfBuffer(fileData);
  await runPipelineForJob(
    jobId,
    { base64: base64Data, text: pdfText, mimeType },
    fileName,
    {
      sourceKind: 'upload',
      title: fileName,
      usedFullText: true,
      contextStatus: 'full_text',
      contextSource: 'metadata',
      contextReason: 'uploaded_pdf',
    },
  );
}

async function processPaperFromText(jobId: string, sourceText: string, sourceLabel: string, contextMeta: PipelineContextMeta = {}) {
  await runPipelineForJob(jobId, { text: sourceText, mimeType: 'text/plain' }, sourceLabel, contextMeta);
}

async function processPaperWithFailureHandling(jobId: string, filePath: string, fileName: string, mimeType: string) {
  try {
    await processPaper(jobId, filePath, fileName, mimeType);
  } catch (err: any) {
    const message = err?.message || 'Pipeline generation failed';
    console.error(`[Job ${jobId}] failed:`, message);
    updateJob(jobId, { status: 'failed', progress: '', error: message });
    await persistRun(jobId, {
      status: 'failed',
      filename: fileName,
      error: message,
      activeModel: lastUsedModel,
      metadata: { failedAt: new Date().toISOString() },
    });
  } finally {
    cleanupFile(filePath);
  }
}

async function processPaperFromTextWithFailureHandling(
  jobId: string,
  sourceText: string,
  sourceLabel: string,
  contextMeta: PipelineContextMeta = {},
) {
  try {
    await processPaperFromText(jobId, sourceText, sourceLabel, contextMeta);
  } catch (err: any) {
    const message = err?.message || 'Pipeline generation failed';
    console.error(`[Job ${jobId}] failed:`, message);
    updateJob(jobId, { status: 'failed', progress: '', error: message });
    await persistRun(jobId, {
      status: 'failed',
      filename: sourceLabel,
      error: message,
      activeModel: lastUsedModel,
      metadata: { failedAt: new Date().toISOString(), source: sourceLabel },
    });
  }
}

async function resolveChatPaperContext(
  paperContext: any,
  existingText: string,
  options: { preferFullPaper?: boolean; forceContextRefresh?: boolean } = {},
): Promise<{ text: string; usedFullPaper: boolean; contextStatus: ContextStatus; contextNotice: string }> {
  const trimmedExisting = trimTextForContext(existingText || '');
  const preferFullPaper = Boolean(options.preferFullPaper);
  const forceContextRefresh = Boolean(options.forceContextRefresh);

  const openAlexId = String(paperContext?.openAlexId || '').trim();
  const doi = normalizeDoi(String(paperContext?.doi || ''));
  const title = String(paperContext?.title || '').trim();
  const sourceUrl = String(paperContext?.sourceUrl || '').trim();
  const hintedStatus = String(paperContext?.contextStatus || '') as ContextStatus | '';
  const hintedReason = String(paperContext?.contextReason || '').trim();
  const hintedSource = String(paperContext?.contextSource || '').trim();
  const sourceKind = String(paperContext?.sourceKind || '').trim();

  let resolvedText = trimmedExisting;
  let usedFullPaper = false;
  let status: ContextStatus = hintedStatus || (trimmedExisting ? 'abstract_only' : 'upload_required');
  let reason = hintedReason || (status === 'full_text' ? (hintedSource || 'context_available') : (trimmedExisting ? 'metadata_only' : 'no_context'));

  const shouldResolve = forceContextRefresh
    || sourceKind === 'imported'
    || (preferFullPaper && trimmedExisting.length < 120_000);
  if (shouldResolve) {
    const resolved = await resolvePaperFullText(
      { openAlexId, doi, title, sourceUrl },
      { forceRefresh: forceContextRefresh },
    );
    if (resolved.text && resolved.text.length > trimmedExisting.length) {
      resolvedText = trimTextForContext(resolved.text);
      usedFullPaper = true;
      status = 'full_text';
      reason = resolved.contextSource;
    } else if (trimmedExisting) {
      status = 'abstract_only';
      reason = resolved.contextReason || 'metadata_only';
    } else {
      status = 'upload_required';
      reason = resolved.contextReason || 'no_pdf_link';
    }
  }

  return {
    text: resolvedText,
    usedFullPaper,
    contextStatus: status,
    contextNotice: buildContextNotice(status, reason),
  };
}

app.post('/api/generate', upload.single('paper'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No PDF file uploaded' });
  }
  if (!(await enforceDemoRunQuota(req, res))) {
    return;
  }

  const jobId = uuidv4();
  jobs[jobId] = {
    status: 'processing',
    progress: 'Parsing PDF...',
    result: null,
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  void persistRun(jobId, {
    status: 'processing',
    filename: req.file.originalname,
    metadata: { createdAt: new Date().toISOString() },
  });

  res.json({ jobId });
  void processPaperWithFailureHandling(jobId, req.file.path, req.file.originalname, req.file.mimetype);
});

app.get('/api/status/:jobId', (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  return res.json(job);
});

app.get('/api/download/:jobId', async (req, res) => {
  const job = jobs[req.params.jobId];
  if (!job || job.status !== 'completed' || !job.result) {
    return res.status(404).json({ error: 'Job not found or not completed' });
  }

  try {
    const zip = new JSZip();
    const files = job.result.files;

    for (const [filename, content] of Object.entries(files)) {
      const isShellScript = filename.endsWith('.sh');
      zip.file(filename, content as string, isShellScript ? { unixPermissions: '755' } : undefined);
    }

    const zipBuffer = await zip.generateAsync({ type: 'nodebuffer' });
    res.set('Content-Type', 'application/zip');
    res.set('Content-Disposition', `attachment; filename="tldrun-${req.params.jobId}.zip"`);
    res.send(zipBuffer);
  } catch (err) {
    console.error('Error generating zip:', err);
    res.status(500).json({ error: 'Failed to generate zip file' });
  }
});

app.post('/api/chat', async (req, res) => {
  try {
    if (!(await enforceDemoChatQuota(req, res))) {
      return;
    }
    const message = String(req.body?.message || '').trim();
    const history = Array.isArray(req.body?.history) ? req.body.history : [];
    const pdfText = String(req.body?.pdfText || '');
    const paperContext = req.body?.paperContext || null;
    const preferFullPaper = Boolean(req.body?.preferFullPaper);
    const forceContextRefresh = Boolean(req.body?.forceContextRefresh);

    if (!message) {
      return res.status(400).json({ error: 'message is required' });
    }

    const resolvedContext = await resolveChatPaperContext(paperContext, pdfText, {
      preferFullPaper,
      forceContextRefresh,
    });
    const paperContextText = resolvedContext.text;
    const usedFullPaper = resolvedContext.usedFullPaper;

    let conversation = 'You are an expert AI assistant answering questions about an ML paper. Be concise and brutally honest.\\n\\n';
    for (const item of history.slice(-16)) {
      if (!item || typeof item.text !== 'string' || typeof item.role !== 'string') continue;
      conversation += `${item.role === 'user' ? 'User' : 'Assistant'}: ${item.text}\\n\\n`;
    }
    if (paperContextText) {
      conversation += `Paper Context:\\n${paperContextText}\\n\\n`;
    }
    conversation += `User: ${message}`;

    const reply = await generateWithFallbackKey(conversation, { text: paperContextText || undefined }, undefined, 0.4);
    return res.json({
      reply,
      activeModel: lastUsedModel,
      usedFullPaper,
      contextStatus: resolvedContext.contextStatus,
      contextNotice: resolvedContext.contextNotice,
    });
  } catch (err: any) {
    console.error('Chat failed:', err?.message || err);
    return res.status(500).json({ error: 'Chat request failed' });
  }
});

app.get('/api/papers/search', async (req, res) => {
  try {
    const q = String(req.query.q || '').trim();
    const page = Math.max(1, Number(req.query.page || 1));
    const perPage = Math.min(20, Math.max(1, Number(req.query.perPage || 12)));
    const minYear = Math.max(1900, Math.min(2100, Number(req.query.minYear || 2023)));

    if (q.length < 2) {
      return res.status(400).json({ error: 'Query must be at least 2 characters.' });
    }

    const searchParams = new URLSearchParams({
      search: q,
      sort: 'relevance_score:desc',
      'per-page': String(perPage),
      page: String(page),
      filter: `from_publication_date:${minYear}-01-01`,
    });
    const response = await fetch(`https://api.openalex.org/works?${searchParams.toString()}`);
    if (!response.ok) {
      return res.status(502).json({ error: 'Paper search provider failed.' });
    }

    const data: any = await response.json();
    const papers = (data.results || [])
      .filter((paper: any) => Number(paper?.publication_year || 0) >= minYear)
      .map((paper: any) => ({
        id: paper.id,
        openAlexId: paper.id,
        title: paper.title,
        year: paper.publication_year,
        authors: (paper.authorships || []).map((a: any) => a.author?.display_name).filter(Boolean),
        abstract: paper.abstract_inverted_index ? invertedIndexToText(paper.abstract_inverted_index, 120) : 'No abstract available.',
        url: paper.primary_location?.landing_page_url || paper.id,
        tags: (paper.concepts || []).slice(0, 5).map((c: any) => c.display_name),
      }));

    return res.json({ query: q, page, perPage, minYear, total: data.meta?.count || papers.length, papers });
  } catch (err: any) {
    console.error('Paper search failed:', err?.message || err);
    return res.status(500).json({ error: 'Paper search failed' });
  }
});

app.post('/api/papers/import', async (req, res) => {
  try {
    const openAlexId = String(req.body?.openAlexId || '').trim();
    const fallbackTitle = String(req.body?.title || '').trim();
    const fallbackAbstract = String(req.body?.abstract || '').trim();
    const fallbackYear = Number(req.body?.year || 0);

    if (!openAlexId && !fallbackAbstract) {
      return res.status(400).json({ error: 'openAlexId or abstract is required.' });
    }
    if (!(await enforceDemoRunQuota(req, res))) {
      return;
    }

    let paper: any = null;
    if (openAlexId) {
      paper = await fetchOpenAlexWork(openAlexId);
      if (!paper && !fallbackAbstract) {
        return res.status(502).json({ error: 'Unable to fetch paper details from OpenAlex.' });
      }
    }

    const title = String(paper?.title || fallbackTitle || 'Imported Paper');
    const authors = (paper?.authorships || [])
      .map((a: any) => a.author?.display_name)
      .filter(Boolean)
      .slice(0, 10)
      .join(', ');
    const year = Number(paper?.publication_year || fallbackYear || 0);
    const concepts = (paper?.concepts || []).slice(0, 8).map((c: any) => c.display_name).filter(Boolean).join(', ');
    const landingUrl = String(paper?.primary_location?.landing_page_url || paper?.id || openAlexId || '').trim();
    const resolvedOpenAlexId = String(openAlexId || paper?.id || '').trim() || null;
    const resolvedDoi = normalizeDoi(String(paper?.doi || paper?.ids?.doi || req.body?.doi || '')) || null;
    const abstractText = invertedIndexToText(paper?.abstract_inverted_index, 900) || fallbackAbstract;
    const resolvedContext = await resolvePaperFullText({
      openAlexId: resolvedOpenAlexId || undefined,
      doi: resolvedDoi || undefined,
      title,
      sourceUrl: landingUrl || undefined,
    });
    const usingFullText = Boolean(resolvedContext.text && resolvedContext.text.length > abstractText.length);
    const contextStatus: ContextStatus = usingFullText ? 'full_text' : (abstractText ? 'abstract_only' : 'upload_required');
    const contextReason = usingFullText ? 'ok' : (resolvedContext.contextReason || 'no_pdf_link');
    const contextSource: ContextSource = usingFullText ? resolvedContext.contextSource : 'metadata';
    const paperBodyText = trimTextForContext(usingFullText ? resolvedContext.text : abstractText);

    if (!paperBodyText || paperBodyText.length < 80) {
      return res.status(400).json({ error: 'Paper abstract is unavailable or too short to import.' });
    }

    const sourceText = [
      `Title: ${title}`,
      year ? `Year: ${year}` : '',
      authors ? `Authors: ${authors}` : '',
      concepts ? `Concepts: ${concepts}` : '',
      (resolvedContext.resolvedUrl || landingUrl) ? `Source URL: ${resolvedContext.resolvedUrl || landingUrl}` : '',
      '',
      usingFullText ? 'Full Paper Text:' : 'Abstract:',
      paperBodyText,
    ].filter(Boolean).join('\n');

    const jobId = uuidv4();
    const sourceLabel = `${title}.txt`;
    jobs[jobId] = {
      status: 'processing',
      progress: 'Step 1/5: Analyzing imported paper...',
      result: null,
      error: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    void persistRun(jobId, {
      status: 'processing',
      filename: sourceLabel,
      metadata: {
        createdAt: new Date().toISOString(),
        source: 'openalex',
        openAlexId: resolvedOpenAlexId,
        doi: resolvedDoi,
        fullTextUsed: usingFullText,
        contextStatus,
        contextSource,
        contextReason,
      },
    });

    res.json({
      jobId,
      title,
      openAlexId: resolvedOpenAlexId,
      fullTextUsed: usingFullText,
      sourceUrl: resolvedContext.resolvedUrl || landingUrl || null,
      contextStatus,
      contextSource,
      contextReason,
    });
    void processPaperFromTextWithFailureHandling(jobId, sourceText, sourceLabel, {
      sourceKind: 'imported',
      openAlexId: resolvedOpenAlexId,
      doi: resolvedDoi,
      sourceUrl: resolvedContext.resolvedUrl || landingUrl || null,
      title,
      usedFullText: usingFullText,
      contextStatus,
      contextSource,
      contextReason,
    });
  } catch (err: any) {
    console.error('Paper import failed:', err?.message || err);
    return res.status(500).json({ error: 'Paper import failed' });
  }
});

const cleanupExpiredJobs = () => {
  const now = Date.now();
  for (const [jobId, job] of Object.entries(jobs)) {
    if (!job?.createdAt) continue;
    if (now - job.createdAt > JOB_TTL_MS) {
      delete jobs[jobId];
    }
  }
};

const cleanupExpiredDemoBuckets = () => {
  const now = Date.now();
  for (const [clientId, bucket] of demoRunBuckets.entries()) {
    if (!bucket?.windowStart) continue;
    if (now - bucket.windowStart > DEMO_DAILY_WINDOW_MS * 2) {
      demoRunBuckets.delete(clientId);
    }
  }
  for (const [clientId, bucket] of demoChatBuckets.entries()) {
    if (!bucket?.windowStart) continue;
    if (now - bucket.windowStart > DEMO_DAILY_WINDOW_MS * 2) {
      demoChatBuckets.delete(clientId);
    }
  }
};

setInterval(cleanupExpiredJobs, 10 * 60 * 1000).unref();
setInterval(cleanupExpiredDemoBuckets, 60 * 60 * 1000).unref();

app.use((err: any, _req: express.Request, res: express.Response, next: express.NextFunction) => {
  if (!err) {
    next();
    return;
  }
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      res.status(413).json({ error: `PDF exceeds ${MAX_PDF_SIZE_MB}MB size limit.` });
      return;
    }
    res.status(400).json({ error: err.message });
    return;
  }
  if (err.message?.includes('Only PDF uploads are allowed')) {
    res.status(400).json({ error: err.message });
    return;
  }
  next(err);
});

app.use((err: any, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error('Unhandled server error:', err?.message || err);
  res.status(500).json({ error: 'Internal server error' });
});

async function startServer() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static('dist'));
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on http://localhost:${PORT}`);
    if (sql) console.log('Neon persistence enabled');
    if (sql) console.log('Persistent demo quotas enabled (backed by Neon).');
    if (DEMO_DAILY_RUN_LIMIT > 0) {
      console.log(`Demo quota enabled: ${DEMO_DAILY_RUN_LIMIT} runs per ${Math.round(DEMO_DAILY_WINDOW_MS / (60 * 60 * 1000))}h per IP`);
    }
    if (DEMO_DAILY_CHAT_LIMIT > 0) {
      console.log(`Demo chat quota enabled: ${DEMO_DAILY_CHAT_LIMIT} chats per ${Math.round(DEMO_DAILY_WINDOW_MS / (60 * 60 * 1000))}h per IP`);
    }
  });
}

startServer();
