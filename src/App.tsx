import React, { useState, useEffect, useRef } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Upload, FileText, CheckCircle, Loader2, Download, ChevronRight, Code, Settings, FileJson, Package, Sparkles, Flame, Cpu, SearchX, Activity, MessageSquare, Send, ArrowLeft, ExternalLink, Network, BookOpen, DownloadCloud, Clock, Trash2, Home, Maximize2, X, RefreshCw, Copy, AlertTriangle } from 'lucide-react';
import { ThemeToggle } from './components/ThemeToggle';
import { AnimatedBackground } from './components/AnimatedBackground';
import { cn } from './lib/utils';
import { GoogleGenAI, Type } from '@google/genai';
import JSZip from 'jszip';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { get, set } from 'idb-keyval';
// @ts-ignore
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import mermaid from 'mermaid';

mermaid.initialize({ startOnLoad: true, theme: 'dark' });

const MermaidChart = ({ chart }: { chart: string }) => {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (ref.current && chart) {
      // Clean up markdown block wrappers if the LLM included them
      let cleanChart = chart.replace(/```mermaid\n?/g, '').replace(/```\n?/g, '').trim();
      // Sanitize common LLM syntax mistakes that break Mermaid
      cleanChart = cleanChart
        .replace(/\|>/g, '|')    // Fix |> to | (invalid edge terminator)
        .replace(/\$\$/g, 'USD ')
        .replace(/\$/g, '')
        .replace(/["']/g, '')     // Aggressively remove all quotes
        .replace(/[()]/g, '');    // Remove parentheses to prevent shape collision/syntax errors

      // Generate unique ID to prevent React reconciliation/Mermaid cache collisions
      const id = `mermaid-${Math.random().toString(36).substring(2, 9)}`;

      mermaid.render(id, cleanChart).then(res => {
        if (ref.current) {
          ref.current.innerHTML = res.svg;
          // Force the SVG to scale responsively and not overflow the flex container
          const svgElem = ref.current.querySelector('svg');
          if (svgElem) {
            svgElem.style.maxWidth = '100%';
            svgElem.style.height = 'auto';
          }
        }
      }).catch(err => {
        console.error("Mermaid error:", err);
        // Show the raw diagram source so the user can still read it
        if (ref.current) ref.current.innerHTML = `<div class="text-sm font-mono p-4 bg-muted/30 rounded-2xl border border-border"><p class="text-red-400 mb-3">⚠️ Diagram syntax error (showing raw source):</p><pre class="text-muted-foreground whitespace-pre-wrap text-xs">${cleanChart}</pre></div>`;
      });
    }
  }, [chart]);
  return <div ref={ref} className="w-full overflow-x-auto flex items-center justify-center p-6 bg-background/50 rounded-2xl border border-border mt-2 shadow-md min-h-[200px]" />;
};

type JobStatus = 'idle' | 'processing' | 'completed' | 'failed';
type ContextStatus = 'full_text' | 'abstract_only' | 'upload_required';

const PIXEL_CAT = [
  "        ",
  " X    X ",
  " XXXXXX ",
  " XXXXXX ",
  " XXXXXX ",
  " X XX X ",
  " X    X ",
  "        "
];

const PIXEL_DOG = [
  "        ",
  "   XX   ",
  "  XXXX  ",
  " XXXXXX ",
  " XXXXXX ",
  " X XX X ",
  " XX  XX ",
  "        "
];

const PIXEL_RABBIT = [
  " XX  XX ",
  " XX  XX ",
  " XXXXXX ",
  " XX  XX ",
  " XXXXXX ",
  " XXXXXX ",
  "  X  X  ",
  "        "
];

const PIXEL_BIRD = [
  "        ",
  "   XX   ",
  " XXXXX  ",
  "XXXXXXX ",
  " XXXXX  ",
  "  XXXX  ",
  "   XX   ",
  "        "
];

const PIXEL_SNAIL = [
  "        ",
  "    XX  ",
  "   XXXX ",
  " x XXXX ",
  " XXXXXX ",
  "XXXXXXX ",
  "        ",
  "        "
];

const PixelAnimal = ({ grid, className, style }: { grid: string[], className?: string, style?: any }) => (
  <svg viewBox="0 0 8 8" className={cn("shrink-0", className)} style={{ imageRendering: 'pixelated', ...style }} fill="currentColor">
    {grid.map((row, y) =>
      row.split('').map((cell, x) =>
        cell !== ' ' ? <rect key={`${x}-${y}`} x={x} y={y} width="1.05" height="1.05" fill={cell === 'x' ? 'currentColor' : 'currentColor'} opacity={cell === 'x' ? 0.6 : 1} /> : null
      )
    )}
  </svg>
);

interface Job {
  status: JobStatus;
  progress: string;
  error?: string;
  result?: {
    pipeline: any;
    files: Record<string, string>;
    pdfBase64?: string;
    pdfText?: string;
    similarPapers?: Array<{ title: string, abstract: string, url: string, year: number }>;
    paperContext?: {
      sourceKind?: 'upload' | 'imported';
      openAlexId?: string | null;
      doi?: string | null;
      sourceUrl?: string | null;
      title?: string;
      usedFullText?: boolean;
      contextStatus?: ContextStatus;
      contextSource?: 'openalex' | 'unpaywall' | 'arxiv' | 'semantic_scholar' | 'metadata';
      contextReason?: string;
    };
  };
}

interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

interface HistoryItem {
  id: string;
  filename: string;
  date: number;
  summary: string;
  jobData: Job;
  chatHistory?: ChatMessage[];
}

interface AuthSession {
  token: string;
  expiresAt: number;
}

interface DemoQuota {
  limit: number;
  used: number;
  remaining: number;
  resetAt: number;
  chatLimit?: number;
  chatUsed?: number;
  chatRemaining?: number;
  chatResetAt?: number;
  windowMs?: number;
}

interface SearchPaper {
  id: string;
  openAlexId?: string;
  title: string;
  year?: number;
  authors?: string[];
  abstract: string;
  url?: string;
  tags?: string[];
}

const PRELOADED_PAPERS: SearchPaper[] = [
  {
    id: 'seed-mamba',
    title: 'Mamba: Linear-Time Sequence Modeling with Selective State Spaces',
    year: 2023,
    authors: ['Gu', 'Dao'],
    abstract: 'Mamba introduces selective state space models for efficient sequence modeling with strong quality-speed tradeoffs, especially for long contexts.',
    tags: ['NLP', 'State Space Models', 'Long Context', 'Efficiency'],
    url: 'https://arxiv.org/abs/2312.00752',
  },
  {
    id: 'seed-dinov2',
    title: 'DINOv2: Learning Robust Visual Features without Supervision',
    year: 2023,
    authors: ['Oquab et al.'],
    abstract: 'DINOv2 scales self-supervised vision training to produce strong universal features that transfer across dense and classification tasks.',
    tags: ['CV', 'Self-Supervised', 'Vision', 'Representation Learning'],
    url: 'https://arxiv.org/abs/2304.07193',
  },
  {
    id: 'seed-sam2',
    title: 'SAM 2: Segment Anything in Images and Videos',
    year: 2024,
    authors: ['Ravi et al.'],
    abstract: 'SAM 2 extends promptable segmentation to both images and videos with a unified architecture and strong zero-shot behavior.',
    tags: ['CV', 'Segmentation', 'Video', 'Foundation Model'],
    url: 'https://arxiv.org/abs/2408.00714',
  },
  {
    id: 'seed-mixtral',
    title: 'Mixtral of Experts',
    year: 2024,
    authors: ['Jiang et al.'],
    abstract: 'Mixtral demonstrates sparse MoE language modeling with strong open performance and improved compute efficiency at inference.',
    tags: ['NLP', 'MoE', 'LLM', 'Efficiency'],
    url: 'https://arxiv.org/abs/2401.04088',
  },
  {
    id: 'seed-gemini15',
    title: 'Gemini 1.5: Unlocking Multimodal Understanding across Millions of Tokens of Context',
    year: 2024,
    authors: ['Team Google DeepMind'],
    abstract: 'Gemini 1.5 focuses on long-context multimodal reasoning and stable performance at million-token context lengths.',
    tags: ['Multimodal', 'Long Context', 'LLM', 'Reasoning'],
    url: 'https://arxiv.org/abs/2403.05530',
  },
  {
    id: 'seed-phi3',
    title: 'Phi-3 Technical Report: A Highly Capable Language Model Locally on Your Phone',
    year: 2024,
    authors: ['Abdin et al.'],
    abstract: 'Phi-3 details compact language models with strong reasoning quality at small parameter counts and practical on-device deployment.',
    tags: ['NLP', 'Small Models', 'Reasoning', 'On-device'],
    url: 'https://arxiv.org/abs/2404.14219',
  },
  {
    id: 'seed-qwen2',
    title: 'Qwen2 Technical Report',
    year: 2024,
    authors: ['Qwen Team'],
    abstract: 'Qwen2 presents a family of multilingual language models and reports improvements across instruction following and reasoning benchmarks.',
    tags: ['NLP', 'Multilingual', 'Instruction Tuning', 'LLM'],
    url: 'https://arxiv.org/abs/2407.10671',
  },
  {
    id: 'seed-kan',
    title: 'KAN: Kolmogorov-Arnold Networks',
    year: 2024,
    authors: ['Liu et al.'],
    abstract: 'KAN replaces linear weights with learnable univariate functions to improve interpretability and flexibility in neural architectures.',
    tags: ['Theory', 'Architecture', 'Interpretability', 'Neural Networks'],
    url: 'https://arxiv.org/abs/2404.19756',
  },
  {
    id: 'seed-deepseek-r1',
    title: 'DeepSeek-R1: Incentivizing Reasoning Capability in LLMs via Reinforcement Learning',
    year: 2025,
    authors: ['DeepSeek-AI'],
    abstract: 'DeepSeek-R1 reports a reinforcement-learning-first approach to strengthen reasoning behavior and chain-of-thought quality in large models.',
    tags: ['Reasoning', 'RL', 'LLM', 'Post-training'],
    url: 'https://arxiv.org/abs/2501.12948',
  },
];

const DEFAULT_PAPER_MIN_YEAR = 2023;
const PAPER_YEAR_OPTIONS = [2023, 2024, 2025, 2026];

const BrandLogo = () => (
  <div className="relative w-[22px] h-[22px] flex items-center justify-center">
    {/* Page base */}
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="absolute inset-0 text-primary-foreground">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <path d="M14 2v6h6" />
    </svg>
    {/* Animated code brackets inside */}
    <motion.svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" className="absolute inset-0 text-emerald-300 drop-shadow-[0_0_2px_rgba(110,231,183,0.5)]">
      <motion.path
        d="M10 13l-2 2 2 2"
        animate={{ x: [0, -1.5, 0], opacity: [0.3, 1, 0.3] }}
        transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
      />
      <motion.path
        d="M14 13l2 2-2 2"
        animate={{ x: [0, 1.5, 0], opacity: [0.3, 1, 0.3] }}
        transition={{ duration: 1.5, repeat: Infinity, ease: "easeInOut" }}
      />
    </motion.svg>
  </div>
);

const FALLBACK_MODELS = ['gemini-2.5-flash', 'gemini-2.0-flash'];
const OPENROUTER_FREE_MODELS = [
  'google/gemini-3.1-flash-lite-preview',
  'google/gemini-3-flash-preview',
  'google/gemini-2.5-flash-lite',
  'google/gemini-2.5-flash',
  'meta-llama/llama-3.3-70b-instruct',
];
// Security hardening: force backend-only provider calls. No frontend env key path.
const USE_SERVER_PIPELINE = true;
const ALLOW_INSECURE_CLIENT_KEYS = false;
const ENV_GEMINI_KEY = '';
const ENV_OTHER_KEY = '';

// Track which model+provider was last successfully used
let _lastUsedModel = '';

function sanitizeApiKey(key: string | undefined): string {
  return (key || '').trim().replace(/^["']|["']$/g, '');
}

function buildClientContextNotice(status: ContextStatus, reason: string): string {
  if (status === 'full_text') {
    return 'Using open-access full paper context for interrogation.';
  }
  if (status === 'abstract_only') {
    return `Full paper unavailable (${reason}). Answering from abstract/metadata. Upload the PDF for full-paper interrogation.`;
  }
  return `Full paper unavailable (${reason}). Upload the PDF to interrogate the complete paper.`;
}

function filePriority(filename: string): number {
  const order = [
    'README.md',
    'HOW_TO_IMPLEMENT.txt',
    'RUNBOOK.md',
    'config.yaml',
    'requirements.txt',
    'Dockerfile',
    'train.py',
    'train.ipynb',
    'prompt.txt',
  ];
  const idx = order.indexOf(filename);
  return idx === -1 ? 999 : idx;
}

function pickInitialFile(files: Record<string, string> | undefined): string {
  if (!files) return 'README.md';
  const keys = Object.keys(files);
  if (!keys.length) return 'README.md';
  return keys.sort((a, b) => filePriority(a) - filePriority(b) || a.localeCompare(b))[0];
}

function formatQuotaResetCountdown(ts: number, nowTs: number): string {
  if (!ts || Number.isNaN(ts)) return 'n/a';
  const remainingMs = ts - nowTs;
  if (remainingMs <= 0) return '<1m';
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatContextStatus(status: ContextStatus | ''): string {
  if (status === 'full_text') return 'Full paper';
  if (status === 'abstract_only') return 'Abstract only';
  if (status === 'upload_required') return 'Upload required';
  return 'Unknown';
}

function clampScore(value: number, min = 0, max = 100): number {
  return Math.max(min, Math.min(max, value));
}

function fieldLooksMissing(value: any): boolean {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return true;
  return text === 'n/a' || text.includes('todo') || text.includes('specify') || text.includes('tbd');
}

function computeImplementationReadiness(
  pipeline: any,
  contextStatus: ContextStatus | '',
): { score: number; level: 'high' | 'medium' | 'low'; blockers: string[]; actions: string[] } {
  const reproducibility = Number(pipeline?.reproducibility_score || 55);
  let score = Number.isFinite(reproducibility) ? reproducibility : 55;
  const blockers: string[] = [];
  const actions: string[] = [];

  if (contextStatus === 'upload_required') {
    score -= 28;
    blockers.push('No full-paper context is available yet.');
    actions.push('Upload the paper PDF to unlock full-paper interrogation and implementation details.');
  } else if (contextStatus === 'abstract_only') {
    score -= 12;
    blockers.push('Working from abstract/metadata only.');
    actions.push('Use full PDF context for architecture and training specifics before full implementation.');
  } else if (contextStatus === 'full_text') {
    score += 5;
  }

  const missingSecrets = Array.isArray(pipeline?.missing_secrets)
    ? pipeline.missing_secrets.filter((x: any) => String(x || '').trim())
    : [];
  if (missingSecrets.length) {
    score -= Math.min(30, missingSecrets.length * 6);
    blockers.push(`Critical unknowns: ${missingSecrets.slice(0, 2).join(' | ')}`);
    actions.push('Convert missing secrets into explicit experiment assumptions and test each in isolation.');
  }

  const assumptions = Array.isArray(pipeline?.assumptions)
    ? pipeline.assumptions.filter((x: any) => String(x || '').trim())
    : [];
  if (assumptions.length > 2) {
    score -= Math.min(10, assumptions.length * 2);
    actions.push('Shrink assumptions by replacing guessed values with measurable defaults in config.yaml.');
  }

  if (fieldLooksMissing(pipeline?.datasets)) {
    score -= 10;
    blockers.push('Dataset details are incomplete.');
    actions.push('Define dataset source, splits, and preprocessing contract before training.');
  }
  if (fieldLooksMissing(pipeline?.training_procedure)) {
    score -= 10;
    blockers.push('Training procedure is underspecified.');
    actions.push('Lock optimizer, schedule, epoch/step budget, and stopping criteria.');
  }
  if (fieldLooksMissing(pipeline?.hyperparameters)) {
    score -= 8;
    blockers.push('Core hyperparameters are missing.');
    actions.push('Set baseline LR/batch/weight decay values and track them in config.yaml.');
  }

  score = clampScore(Math.round(score));
  const level = score >= 80 ? 'high' : score >= 55 ? 'medium' : 'low';

  const dedupedActions = Array.from(new Set(actions)).slice(0, 3);
  if (!dedupedActions.length) {
    dedupedActions.push('Run smoke mode, then implement the paper incrementally module-by-module.');
  }

  return {
    score,
    level,
    blockers: blockers.slice(0, 4),
    actions: dedupedActions,
  };
}

async function extractTextFromPDF(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const pdfjsLib = await import('pdfjs-dist');
  pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    fullText += textContent.items.map((item: any) => item.str).join(' ') + '\n';
  }
  return fullText;
}

async function generateUniversalContent(
  apiKey: string,
  prompt: string,
  pdfData?: { base64?: string, text?: string, mimeType?: string },
  schema?: any,
  temperature = 0.2
): Promise<string> {
  // Validate key
  if (!apiKey || apiKey === "undefined" || apiKey === "null") {
    throw new Error("Invalid API Key: add a valid key in API settings (or enable local env key mode).");
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
    }
    contents.push({ text: prompt });

    const attempts: string[] = [];
    for (const model of FALLBACK_MODELS) {
      try {
        console.log(`Trying Gemini model: ${model}`);
        const response = await ai.models.generateContent({
          model,
          contents,
          config: {
            temperature,
            ...(schema ? { responseMimeType: 'application/json', responseSchema: schema } : {})
          }
        });
        _lastUsedModel = `Gemini: ${model}`;
        return response.text || '';
      } catch (e: any) {
        const reason = e?.message?.includes('429') ? '429 Quota Exceeded' : e?.message?.includes('404') ? '404 Not Found' : (e?.message?.substring(0, 80) || 'Unknown error');
        attempts.push(`\u274c ${model}: ${reason}`);
        if (e?.status === 429 || e?.status === 'RESOURCE_EXHAUSTED' || e?.message?.includes('429')) continue;
        throw e;
      }
    }
    const err = new Error('GEMINI_QUOTA_EXHAUSTED');
    (err as any).attempts = attempts;
    throw err;

  } else if (isAnthropic) {
    const anthropic = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    let contentStr = prompt;
    if (pdfData?.text) contentStr = `Document Text:\n${pdfData.text}\n\nTask:\n${prompt}`;
    if (schema) {
      const fieldDescriptions = Object.entries(schema.properties || {}).map(([key, val]: [string, any]) => {
        const type = val.type === 'ARRAY' ? 'array of strings' : val.type === 'NUMBER' ? 'number' : 'string';
        return `  "${key}": (${type}) ${val.description || ''}`;
      }).join(', ');
      contentStr += '\n\nYou MUST return ONLY valid JSON (no markdown, no code blocks). The JSON object must have exactly these fields:\n{ ' + fieldDescriptions + ' }';
    }

    const msg = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20241022",
      max_tokens: 8192,
      temperature,
      messages: [{ role: "user", content: contentStr }]
    });
    let text = (msg.content[0] as any).text || '';
    if (schema) text = text.replace(/```json\n?|\n?```/g, '').trim();
    _lastUsedModel = 'Anthropic: claude-3.5-sonnet';
    return text;

  } else {
    // OpenAI, Groq, OpenRouter
    const baseURL = isGroq ? 'https://api.groq.com/openai/v1' : isOpenRouter ? 'https://openrouter.ai/api/v1' : undefined;
    const models = isOpenRouter ? OPENROUTER_FREE_MODELS : [isGroq ? 'llama-3.3-70b-versatile' : 'gpt-4o'];
    const attempts: string[] = [];
    for (const model of models) {
      try {
        console.log(`Trying ${isOpenRouter ? 'OpenRouter' : isGroq ? 'Groq' : 'OpenAI'} model: ${model}`);
        const openai = new OpenAI({
          apiKey,
          baseURL,
          dangerouslyAllowBrowser: true,
          defaultHeaders: isOpenRouter ? { "HTTP-Referer": window.location.href, "X-Title": "TLDRun" } : undefined
        });

        let contentStr = prompt;
        if (pdfData?.text) contentStr = `Document Text:\n${pdfData.text}\n\nTask:\n${prompt}`;

        if (schema && (isGroq || isOpenRouter)) {
          const fieldDescriptions = Object.entries(schema.properties || {}).map(([key, val]: [string, any]) => {
            const type = val.type === 'ARRAY' ? 'array of strings' : val.type === 'NUMBER' ? 'number' : 'string';
            return `  "${key}": (${type}) ${val.description || ''}`;
          }).join(', ');
          contentStr += '\n\nYou MUST return ONLY valid JSON (no markdown, no code blocks, no explanation). The JSON object must have exactly these fields:\n{ ' + fieldDescriptions + ' }';
        }

        const response = await openai.chat.completions.create({
          model,
          messages: [
            { role: 'system', content: 'You are an expert ML researcher. Follow instructions exactly.' },
            { role: 'user', content: contentStr }
          ],
          temperature,
          ...(schema && isGroq ? { response_format: { type: 'json_object' as const } } : {}),
          ...(schema && !isGroq && !isOpenRouter ? { response_format: { type: 'json_object' as const } } : {})
        });

        let text = response.choices[0].message.content || '';
        if (schema) text = text.replace(/```json\n?|\n?```/g, '').replace(/^`{3}[\w]*\n/, '').replace(/\n`{3}$/, '').trim();
        _lastUsedModel = isOpenRouter ? `OpenRouter: ${model.split('/').pop()}` : isGroq ? `Groq: ${model}` : `OpenAI: ${model}`;
        return text;
      } catch (e: any) {
        const reason = e?.message?.includes('429') ? '429 Rate Limited' : e?.message?.includes('404') ? '404 Model Not Found' : (e?.message?.substring(0, 80) || 'Unknown error');
        attempts.push(`\u274c ${model}: ${reason}`);
        if (isOpenRouter && models.indexOf(model) < models.length - 1) {
          console.warn(`Model ${model} failed, trying next...`);
          continue;
        }
        const err = new Error(`All models exhausted.\n\n${attempts.join('\n')}`);
        (err as any).attempts = attempts;
        throw err;
      }
    }
    const err = new Error(`All models exhausted.\n\n${attempts.join('\n')}`);
    (err as any).attempts = attempts;
    throw err;
  }
}

/**
 * Smart wrapper: tries the primary key first, and if Gemini quota is exhausted,
 * seamlessly falls back to the secondary key if one exists.
 */
async function generateWithFallbackKey(
  primaryKey: string,
  fallbackKey: string | undefined,
  prompt: string,
  pdfData?: { base64?: string, text?: string, mimeType?: string },
  schema?: any,
  temperature = 0.2
): Promise<string> {
  const allAttempts: string[] = [];
  try {
    return await generateUniversalContent(primaryKey, prompt, pdfData, schema, temperature);
  } catch (e: any) {
    if (e?.attempts) allAttempts.push(...e.attempts);
    if (e?.message === 'GEMINI_QUOTA_EXHAUSTED' && fallbackKey) {
      console.warn('⚠️ Gemini quota hit, seamlessly falling back to secondary API key...');
      try {
        return await generateUniversalContent(fallbackKey, prompt, pdfData, schema, temperature);
      } catch (e2: any) {
        if (e2?.attempts) allAttempts.push(...e2.attempts);
        const finalErr = new Error(`All API keys and models exhausted:\n\n${allAttempts.join('\n')}`);
        (finalErr as any).attempts = allAttempts;
        throw finalErr;
      }
    }
    if (allAttempts.length > 0) {
      const finalErr = new Error(`All models exhausted:\n\n${allAttempts.join('\n')}`);
      (finalErr as any).attempts = allAttempts;
      throw finalErr;
    }
    throw e;
  }
}

export default function App() {
  const [homeTab, setHomeTab] = useState<'upload' | 'papers'>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<Job>({ status: 'idle', progress: '' });
  const [activeTab, setActiveTab] = useState<string>('reality');
  const [activeFile, setActiveFile] = useState<string>('train.py');
  const [resultPane, setResultPane] = useState<'summary' | 'code'>('summary');
  const [hasOpenedCodePane, setHasOpenedCodePane] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [activeModel, setActiveModel] = useState('');
  const [isDiagramModalOpen, setIsDiagramModalOpen] = useState(false);

  const goHome = () => {
    setHomeTab('upload');
    setJob({ status: 'idle', progress: '' });
    setFile(null);
    setResultPane('summary');
    setHasOpenedCodePane(false);
    setChatHistory([]);
    setChatContextStatus('');
    setChatContextNotice('');
    setActiveHistoryId(null);
  };

  // History state
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [activeHistoryId, setActiveHistoryId] = useState<string | null>(null);

  // Chat state
  const [chatHistory, setChatHistory] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [isRefreshingContext, setIsRefreshingContext] = useState(false);
  const [chatContextStatus, setChatContextStatus] = useState<ContextStatus | ''>('');
  const [chatContextNotice, setChatContextNotice] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);
  const [primaryApiKey, setPrimaryApiKey] = useState<string>(() => USE_SERVER_PIPELINE ? '' : (localStorage.getItem('tldrun_primary_api_key') || ''));
  const [fallbackApiKey, setFallbackApiKey] = useState<string>(() => USE_SERVER_PIPELINE ? '' : (localStorage.getItem('tldrun_fallback_api_key') || ''));
  const [showApiConfig, setShowApiConfig] = useState(false);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const authSessionRef = useRef<AuthSession | null>(null);
  const [paperQuery, setPaperQuery] = useState('');
  const [paperSearchResults, setPaperSearchResults] = useState<SearchPaper[]>([]);
  const [isPaperSearchLoading, setIsPaperSearchLoading] = useState(false);
  const [paperSearchError, setPaperSearchError] = useState('');
  const [paperSearchAttempted, setPaperSearchAttempted] = useState(false);
  const [paperTagFilter, setPaperTagFilter] = useState('All');
  const [paperMinYear, setPaperMinYear] = useState<number>(DEFAULT_PAPER_MIN_YEAR);
  const [importingPaperId, setImportingPaperId] = useState<string | null>(null);
  const [quickstartCopied, setQuickstartCopied] = useState<'venv' | 'docker' | null>(null);
  const [demoQuota, setDemoQuota] = useState<DemoQuota | null>(null);
  const [nowTick, setNowTick] = useState(() => Date.now());

  // Load history on mount
  useEffect(() => {
    get('tldrun_history').then(saved => {
      if (saved) setHistory(saved);
    }).catch(e => console.error('Failed to load history', e));
  }, []);

  // Sync to indexedDB whenever history changes
  useEffect(() => {
    if (history.length > 0) {
      set('tldrun_history', history).catch(e => console.error('Failed to save to idb', e));
    }
  }, [history]);

  useEffect(() => {
    if (USE_SERVER_PIPELINE) {
      localStorage.removeItem('tldrun_primary_api_key');
      localStorage.removeItem('tldrun_fallback_api_key');
      return;
    }
    localStorage.setItem('tldrun_primary_api_key', primaryApiKey);
  }, [primaryApiKey]);

  useEffect(() => {
    if (USE_SERVER_PIPELINE) return;
    localStorage.setItem('tldrun_fallback_api_key', fallbackApiKey);
  }, [fallbackApiKey]);

  // Sync active chat history to the current active item
  useEffect(() => {
    if (activeHistoryId && job.status === 'completed') {
      setHistory(prev => prev.map(h => {
        if (h.id === activeHistoryId) {
          return { ...h, jobData: job, chatHistory };
        }
        return h;
      }));
    }
  }, [chatHistory, job, activeHistoryId]);

  // Pull to refresh state
  const [pullY, setPullY] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);

  useEffect(() => {
    let startY = 0;
    const handleTouchStart = (e: TouchEvent) => {
      if (window.scrollY === 0) startY = e.touches[0].clientY;
    };
    const handleTouchMove = (e: TouchEvent) => {
      if (startY && window.scrollY === 0) {
        const y = e.touches[0].clientY;
        if (y > startY) {
          const pull = Math.min((y - startY) * 0.4, 150);
          setPullY(pull);
          if (pull > 100) e.preventDefault();
        }
      }
    };
    const handleTouchEnd = () => {
      if (pullY > 100) {
        setIsRefreshing(true);
        setTimeout(() => window.location.reload(), 800);
      } else {
        setPullY(0);
      }
      startY = 0;
    };

    document.addEventListener('touchstart', handleTouchStart, { passive: true });
    document.addEventListener('touchmove', handleTouchMove, { passive: false });
    document.addEventListener('touchend', handleTouchEnd);
    return () => {
      document.removeEventListener('touchstart', handleTouchStart);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleTouchEnd);
    };
  }, [pullY]);

  useEffect(() => {
    if (activeTab === 'interrogate') {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatHistory, activeTab]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setFile(e.dataTransfer.files[0]);
    }
  };

  const getConfiguredKeys = () => {
    const runtimePrimary = sanitizeApiKey(primaryApiKey);
    const runtimeFallback = sanitizeApiKey(fallbackApiKey);
    if (runtimePrimary) {
      return { primaryKey: runtimePrimary, fallbackKey: runtimeFallback || undefined };
    }

    const envGemini = sanitizeApiKey(ENV_GEMINI_KEY);
    const envOther = sanitizeApiKey(ENV_OTHER_KEY);
    if (envGemini) {
      return { primaryKey: envGemini, fallbackKey: envOther || undefined };
    }
    if (envOther) {
      return { primaryKey: envOther, fallbackKey: undefined };
    }
    return null;
  };

  useEffect(() => {
    authSessionRef.current = authSession;
  }, [authSession]);

  const ensureAuthToken = React.useCallback(async (forceRefresh = false): Promise<string | null> => {
    if (!USE_SERVER_PIPELINE) return null;

    const session = authSessionRef.current;
    const now = Date.now();
    if (!forceRefresh && session && session.expiresAt - 30_000 > now) {
      return session.token;
    }

    const response = await fetch('/api/auth/guest', { method: 'POST' });
    if (!response.ok) {
      throw new Error(`Authentication bootstrap failed (${response.status})`);
    }
    const payload = await response.json();
    const token = String(payload?.token || '');
    const expiresAt = Number(payload?.expiresAt || now + (60 * 60 * 1000));
    if (!token) {
      throw new Error('Authentication bootstrap returned an empty token');
    }

    const nextSession: AuthSession = { token, expiresAt };
    authSessionRef.current = nextSession;
    setAuthSession(nextSession);
    return token;
  }, []);

  const captureQuotaHeaders = React.useCallback((headers: Headers) => {
    const runLimit = Number(headers.get('X-Demo-Run-Limit') || '');
    const runRemaining = Number(headers.get('X-Demo-Run-Remaining') || '');
    const runResetAt = Number(headers.get('X-Demo-Run-Reset-At') || '');
    const chatLimit = Number(headers.get('X-Demo-Chat-Limit') || '');
    const chatRemaining = Number(headers.get('X-Demo-Chat-Remaining') || '');
    const chatResetAt = Number(headers.get('X-Demo-Chat-Reset-At') || '');
    setDemoQuota((prev) => {
      const next: DemoQuota = {
        limit: prev?.limit || 0,
        used: prev?.used || 0,
        remaining: prev?.remaining || 0,
        resetAt: prev?.resetAt || 0,
        chatLimit: prev?.chatLimit,
        chatUsed: prev?.chatUsed,
        chatRemaining: prev?.chatRemaining,
        chatResetAt: prev?.chatResetAt,
        windowMs: prev?.windowMs,
      };
      let changed = false;

      if (!Number.isNaN(runLimit) && !Number.isNaN(runRemaining) && !Number.isNaN(runResetAt) && runLimit > 0) {
        next.limit = runLimit;
        next.remaining = runRemaining;
        next.used = Math.max(0, runLimit - runRemaining);
        next.resetAt = runResetAt;
        changed = true;
      }

      if (!Number.isNaN(chatLimit) && !Number.isNaN(chatRemaining) && !Number.isNaN(chatResetAt) && chatLimit > 0) {
        next.chatLimit = chatLimit;
        next.chatRemaining = chatRemaining;
        next.chatUsed = Math.max(0, chatLimit - chatRemaining);
        next.chatResetAt = chatResetAt;
        changed = true;
      }

      return changed ? next : prev;
    });
  }, []);

  const apiFetch = React.useCallback(async (input: string, init: RequestInit = {}, retry = true): Promise<Response> => {
    const headers = new Headers(init.headers || {});
    if (USE_SERVER_PIPELINE) {
      const token = await ensureAuthToken(false);
      if (token) headers.set('Authorization', `Bearer ${token}`);
    }

    const response = await fetch(input, { ...init, headers });
    captureQuotaHeaders(response.headers);
    if (USE_SERVER_PIPELINE && response.status === 401 && retry) {
      await ensureAuthToken(true);
      return apiFetch(input, init, false);
    }
    return response;
  }, [ensureAuthToken, captureQuotaHeaders]);

  useEffect(() => {
    if (!USE_SERVER_PIPELINE) return;
    void ensureAuthToken(false).catch((err) => {
      console.error('Initial auth bootstrap failed:', err);
    });
  }, [ensureAuthToken]);

  useEffect(() => {
    if (!USE_SERVER_PIPELINE) return;
    const run = async () => {
      try {
        const response = await apiFetch('/api/demo/quota');
        if (!response.ok) return;
        const payload = await response.json();
        if (typeof payload?.limit === 'number') {
          setDemoQuota({
            limit: Number(payload.limit),
            used: Number(payload.used || 0),
            remaining: Number(payload.remaining || 0),
            resetAt: Number(payload.resetAt || 0),
            chatLimit: Number(payload.chatLimit || 0),
            chatUsed: Number(payload.chatUsed || 0),
            chatRemaining: Number(payload.chatRemaining || 0),
            chatResetAt: Number(payload.chatResetAt || 0),
            windowMs: Number(payload.windowMs || 0),
          });
        }
      } catch (err) {
        console.warn('Failed to fetch demo quota snapshot:', err);
      }
    };
    void run();
  }, [apiFetch]);

  useEffect(() => {
    const timer = window.setInterval(() => setNowTick(Date.now()), 60_000);
    return () => window.clearInterval(timer);
  }, []);

  const finalizeCompletedJob = (completedJob: Job, sourceFile: File) => {
    setJob(completedJob);
    setFile(sourceFile);
    setActiveTab('readiness');
    setResultPane('summary');
    setHasOpenedCodePane(false);
    setActiveFile(pickInitialFile(completedJob.result?.files));
    const paperContext = completedJob.result?.paperContext as any;
    const status = (paperContext?.contextStatus || '') as ContextStatus | '';
    const reason = String(paperContext?.contextReason || 'metadata_only');
    if (status) {
      setChatContextStatus(status);
      setChatContextNotice(buildClientContextNotice(status, reason));
    } else {
      setChatContextStatus('');
      setChatContextNotice('');
    }

    const initialChat: ChatMessage[] = [
      { role: 'model', text: "I've analyzed the paper. What would you like to know about the methodology, architecture, or hidden details?" }
    ];
    setChatHistory(initialChat);

    const newId = Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
    setActiveHistoryId(newId);

    const newHistoryItem: HistoryItem = {
      id: newId,
      filename: sourceFile.name,
      date: Date.now(),
      summary: (completedJob.result?.pipeline as any)?.anti_hype_summary || 'No summary available.',
      jobData: completedJob,
      chatHistory: initialChat
    };

    setHistory(prev => [newHistoryItem, ...prev].slice(0, 10));
  };

  const pollServerJobUntilDone = async (jobId: string, sourceName: string) => {
    const maxPolls = 600;
    let pollDelayMs = 1500;
    for (let i = 0; i < maxPolls; i++) {
      await new Promise(resolve => setTimeout(resolve, pollDelayMs));

      const statusRes = await apiFetch(`/api/status/${jobId}`);
      if (statusRes.status === 429) {
        pollDelayMs = Math.min(6000, pollDelayMs + 500);
        setJob(prev => ({ ...prev, progress: 'Waiting for rate-limit window...' }));
        continue;
      }
      if (!statusRes.ok) {
        throw new Error(`Status check failed (${statusRes.status}).`);
      }

      const statusPayload: Job = await statusRes.json();
      pollDelayMs = 1500;
      setJob(statusPayload);

      if (statusPayload.status === 'completed' && statusPayload.result) {
        if ((statusPayload.result as any).activeModel) {
          setActiveModel((statusPayload.result as any).activeModel);
        }
        finalizeCompletedJob(statusPayload, new File([], sourceName));
        return;
      }
      if (statusPayload.status === 'failed') {
        throw new Error(statusPayload.error || 'Backend pipeline failed.');
      }
    }

    throw new Error('Timed out waiting for backend pipeline completion.');
  };

  const processPaperViaServer = async (sourceFile: File) => {
    setJob({ status: 'processing', progress: 'Uploading PDF to backend...' });

    const formData = new FormData();
    formData.append('paper', sourceFile);

    const startRes = await apiFetch('/api/generate', {
      method: 'POST',
      body: formData,
    });
    if (!startRes.ok) {
      const errText = await startRes.text();
      throw new Error(`Backend upload failed (${startRes.status}): ${errText}`);
    }

    const { jobId } = await startRes.json();
    if (!jobId) throw new Error('Backend did not return a jobId.');
    await pollServerJobUntilDone(jobId, sourceFile.name);
  };

  const handlePaperSearch = async (e?: React.FormEvent) => {
    e?.preventDefault();
    const query = paperQuery.trim();
    if (query.length < 2) {
      setPaperSearchError('');
      setPaperSearchAttempted(false);
      setPaperSearchResults([]);
      return;
    }

    setIsPaperSearchLoading(true);
    setPaperSearchError('');
    setPaperSearchAttempted(true);
    try {
      const response = await apiFetch(`/api/papers/search?q=${encodeURIComponent(query)}&perPage=8&minYear=${paperMinYear}`);
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Search failed (${response.status}): ${errText}`);
      }
      const payload = await response.json();
      const papers = Array.isArray(payload?.papers) ? payload.papers : [];
      setPaperSearchResults(papers);
      setPaperTagFilter('All');
    } catch (err: any) {
      setPaperSearchResults([]);
      setPaperSearchError(err?.message || 'Paper search failed.');
    } finally {
      setIsPaperSearchLoading(false);
    }
  };

  const handleImportPaper = async (paper: SearchPaper) => {
    const rowId = paper.openAlexId || paper.id;
    if (!rowId) return;
    const paperId = (paper.openAlexId || '').trim();

    setImportingPaperId(rowId);
    setResultPane('summary');
    setHasOpenedCodePane(false);
    setChatContextStatus('');
    setChatContextNotice('');
    setJob({ status: 'processing', progress: 'Queueing paper import...' });
    try {
      const response = await apiFetch('/api/papers/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          openAlexId: paperId || undefined,
          title: paper.title,
          abstract: paper.abstract,
          year: paper.year,
        }),
      });
      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Import failed (${response.status}): ${errText}`);
      }

      const payload = await response.json();
      const jobId = String(payload?.jobId || '');
      const sourceName = `${String(payload?.title || paper.title || 'Imported Paper')}.txt`;
      if (!jobId) {
        throw new Error('Import did not return a jobId.');
      }
      await pollServerJobUntilDone(jobId, sourceName);
    } catch (err: any) {
      console.error(err);
      setJob({ status: 'failed', progress: '', error: err?.message || 'Paper import failed.' });
    } finally {
      setImportingPaperId(null);
    }
  };

  const processPaper = async (file: File) => {
    setResultPane('summary');
    setHasOpenedCodePane(false);
    setChatContextStatus('');
    setChatContextNotice('');
    setJob({ status: 'processing', progress: 'Step 1/5: Extracting pipeline from PDF...' });

    try {
      if (USE_SERVER_PIPELINE) {
        await processPaperViaServer(file);
        return;
      }

      const keyConfig = getConfiguredKeys();
      if (!keyConfig) {
        throw new Error('No API key configured. Add a primary key in the API Key settings panel.');
      }
      const { primaryKey, fallbackKey } = keyConfig;

      // Helper: call LLM with automatic Gemini→Other fallback
      const callLLM = (prompt: string, pdfData?: any, schema?: any, temp = 0.2) =>
        generateWithFallbackKey(primaryKey, fallbackKey, prompt, pdfData, schema, temp);

      // 1. Read file as base64 (for Gemini)
      const base64Data = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });

      // 2. Extract raw text from PDF (for OpenAI/Groq/Anthropic/OpenRouter)
      setJob(prev => ({ ...prev, progress: 'Step 1/5: Extracting PDF text...' }));
      const pdfText = await extractTextFromPDF(file);
      const pdfDataWrapper = { base64: base64Data, text: pdfText, mimeType: 'application/pdf' };

      // Step 1: Extract Pipeline
      setJob(prev => ({ ...prev, progress: 'Step 1/5: Analyzing ML pipeline...' }));
      const schema = {
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
          hardware_reality: { type: Type.STRING, description: 'Brutally honest estimate of compute, explicitly including an estimated AWS/GCP dollar cost (use single $ sign), and an estimated carbon footprint.' },
          anti_hype_summary: { type: Type.STRING, description: 'Honest summary of achievement.' },
          core_concept: { type: Type.STRING, description: 'A 2-4 word phrase representing the core ML concept of this paper (e.g. "Mixture of Experts", "Diffusion Models").' },
          prerequisite_papers: { type: Type.ARRAY, items: { type: Type.STRING }, description: 'List the top 2-3 absolutely essential foundational papers a reader MUST read before understanding this one.' },
          architecture_mermaid: { type: Type.STRING, description: 'A valid mermaid.js flowchart TD syntax. CRITICAL: Use only letters, numbers, and spaces for node labels. DO NOT use quotes, parentheses, brackets, or special characters inside node labels.' }
        },
        required: ['datasets', 'preprocessing', 'model_architecture', 'training_procedure', 'hyperparameters', 'evaluation_protocol', 'assumptions', 'reproducibility_score', 'missing_secrets', 'hardware_reality', 'anti_hype_summary', 'core_concept', 'prerequisite_papers', 'architecture_mermaid']
      };

      const promptExtractor = 'You are an expert ML researcher and a brutal peer reviewer. Extract the training pipeline. Do not hallucinate numbers. Also, provide a brutally honest anti-hype summary, estimate the real hardware cost (including Carbon), list the missing secrets they hid, list prerequisite foundational papers, generate a mermaid diagram, and give a reproducibility score (0-100).';
      const pipelineText = await callLLM(promptExtractor, pdfDataWrapper, schema, 0.2);
      setActiveModel(_lastUsedModel);

      // Robust JSON extraction: handles markdown wrappers, extra text, etc.
      let pipeline: any = {};
      try {
        // Try direct parse first
        pipeline = JSON.parse(pipelineText || '{}');
      } catch (e) {
        console.warn("Direct JSON parse failed, trying to extract JSON from response...");
        // Try to find JSON object in the response (model may have wrapped it in markdown or added text)
        const jsonMatch = pipelineText.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          try {
            pipeline = JSON.parse(jsonMatch[0]);
            console.log("Successfully extracted JSON from response");
          } catch (e2) {
            console.error("JSON extraction also failed. Raw response:", pipelineText?.substring(0, 500));
            pipeline = { datasets: "Parse error - model returned non-JSON response" };
          }
        } else {
          console.error("No JSON found in response. Raw response:", pipelineText?.substring(0, 500));
          pipeline = { datasets: "Parse error - no JSON in response" };
        }
      }
      console.log("Parsed pipeline keys:", Object.keys(pipeline));
      const files: Record<string, string> = {};

      // Step 2: Generate Config
      setJob(prev => ({ ...prev, progress: 'Step 2/5: Generating config.yaml...' }));
      const configPrompt = `Generate a config.yaml file for this ML pipeline. Use placeholders like "TODO: specify" for missing values. Pipeline details: ${JSON.stringify(pipeline)}`;
      const configYaml = await callLLM(configPrompt, undefined, undefined, 0.2);
      files['config.yaml'] = configYaml.replace(/```yaml\n?|\n?```/g, '').trim();

      // Step 3: Generate Code Skeleton
      setJob(prev => ({ ...prev, progress: 'Step 3/5: Generating PyTorch code skeleton...' }));
      const codePrompt = `Generate a clean, modular PyTorch training script (train.py) based on this config and pipeline. Include data loading, model init, and the training loop. Add '# TODO:' where missing. Config:\n${files['config.yaml']}\nPipeline:\n${JSON.stringify(pipeline)}`;
      const codeRes = await callLLM(codePrompt, undefined, undefined, 0.2);
      files['train.py'] = codeRes.replace(/```python\n?|\n?```/g, '').trim();

      // Step 4: Generate Environment
      setJob(prev => ({ ...prev, progress: 'Step 4/5: Generating Dockerfile and requirements...' }));
      const envPrompt = `Generate a Dockerfile (CPU runnable by default) and a requirements.txt for this PyTorch project. Return them separated absolutely by "---REQUIREMENTS---". Code:\n${files['train.py']}`;
      const envRes = await callLLM(envPrompt, undefined, undefined, 0.2);
      const envParts = envRes.split('---REQUIREMENTS---');
      files['Dockerfile'] = envParts[0]?.replace(/```dockerfile\n?|\n?```/g, '').replace(/```docker\n?|\n?```/g, '').trim() || '';
      files['requirements.txt'] = envParts[1]?.replace(/```text\n?|\n?```/g, '').replace(/```\n?|\n?```/g, '').trim() || '';

      // Step 4b: Construct Jupyter Notebook purely locally
      const notebookJson = {
        cells: [
          { cell_type: 'markdown', metadata: {}, source: [`# TL;DRun Training Pipeline\n`, `Auto-generated runnable environment.\n`] },
          { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [`# Install dependencies\n`, `!pip install ${(files['requirements.txt'].split('\\n').filter(Boolean).join(' '))}`] },
          { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: [files['train.py']] }
        ],
        metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { codemirror_mode: { name: "ipython", version: 3 }, file_extension: ".py", mimetype: "text/x-python", name: "python", nbconvert_exporter: "python", pygments_lexer: "ipython3", version: "3.10.12" } },
        nbformat: 4, nbformat_minor: 4
      };
      files['train.ipynb'] = JSON.stringify(notebookJson, null, 2);

      // Step 5: Generate README
      setJob(prev => ({ ...prev, progress: 'Step 5/5: Generating README.md...' }));
      const readmePrompt = `Generate a README.md for this repository. Explain how to build the docker image and run the code. Include the anti-hype summary and reproducibility score. Pipeline:\n${JSON.stringify(pipeline)}`;
      const readmeRes = await callLLM(readmePrompt, undefined, undefined, 0.2);
      files['README.md'] = readmeRes.replace(/```markdown\n?|\n?```/g, '').trim();

      // Step 5b: Include System Prompt used to generate repo
      files['prompt.txt'] = `## SYSTEM PROMPT AUTOMATICALLY GENERATED BY TL;DRUN\n\nThis prompt was constructed using the data extracted from the uploaded PDF, and passed to the LLM backend to generate the repository code (train.py, model.py, data.py, etc.)\n\n${codePrompt}`;

      // Step 6: Fetch Similar Papers from OpenAlex API
      setJob(prev => ({ ...prev, progress: 'Step 6: Finding similar research (Free)...' }));
      let similarPapers = [];
      try {
        if (pipeline && (pipeline as any).core_concept) {
          const conceptStr = encodeURIComponent((pipeline as any).core_concept);
          const oaRes = await fetch(`https://api.openalex.org/works?search=${conceptStr}&sort=cited_by_count:desc&per-page=3`);
          if (oaRes.ok) {
            const oaData = await oaRes.json();
            similarPapers = oaData.results.map((r: any) => ({
              title: r.title,
              abstract: r.abstract_inverted_index ? Object.keys(r.abstract_inverted_index).slice(0, 30).join(' ') + '...' : 'No abstract available.',
              url: r.primary_location?.landing_page_url || r.id,
              year: r.publication_year
            }));
          }
        }
      } catch (e) { console.warn("OpenAlex error", e); }

      const completedJob: Job = {
        status: 'completed',
        progress: 'Done',
        result: { pipeline, files, pdfBase64: base64Data, pdfText, similarPapers }
      };

      finalizeCompletedJob(completedJob, file);

    } catch (err: any) {
      console.error(err);
      setJob({ status: 'failed', progress: '', error: err.message || 'An error occurred during generation' });
    }
  };

  const handleUpload = () => {
    if (!file) return;
    processPaper(file);
  };

  const shouldRequestFullPaperContext = (text: string) => {
    if (!text) return false;
    return /(full paper|whole paper|entire paper|read the paper|from the paper|appendix|section\s+\d+)/i.test(text);
  };

  const copyQuickstart = async (mode: 'venv' | 'docker') => {
    const quickstart = mode === 'venv'
      ? [
        'unzip tldrun-repo.zip -d tldrun-repo',
        'cd tldrun-repo',
        'chmod +x scripts/*.sh',
        './scripts/bootstrap_venv.sh',
        './scripts/smoke_test.sh',
        './scripts/run_train.sh',
      ].join('\n')
      : [
        'unzip tldrun-repo.zip -d tldrun-repo',
        'cd tldrun-repo',
        'chmod +x scripts/*.sh',
        './scripts/docker_build.sh',
        './scripts/docker_run.sh smoke',
        './scripts/docker_run.sh train',
      ].join('\n');

    try {
      await navigator.clipboard.writeText(quickstart);
      setQuickstartCopied(mode);
      window.setTimeout(() => setQuickstartCopied(null), 1800);
    } catch (err) {
      console.error('Clipboard write failed:', err);
      setQuickstartCopied(null);
    }
  };

  const handleRefreshFullContext = async () => {
    if (!job?.result || !USE_SERVER_PIPELINE || isRefreshingContext || isChatting) return;
    setIsRefreshingContext(true);
    try {
      const chatRes = await apiFetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Refresh context status for this paper and summarize availability.',
          history: chatHistory,
          pdfText: (job.result as any).pdfText || '',
          paperContext: (job.result as any).paperContext || null,
          preferFullPaper: true,
          forceContextRefresh: true,
        }),
      });
      if (!chatRes.ok) {
        const errText = await chatRes.text();
        throw new Error(`Context refresh failed (${chatRes.status}): ${errText}`);
      }
      const payload = await chatRes.json();
      const contextStatus = (payload?.contextStatus || '') as ContextStatus | '';
      const contextNotice = String(payload?.contextNotice || '').trim();
      if (contextStatus) setChatContextStatus(contextStatus);
      if (contextNotice) {
        setChatContextNotice(contextNotice);
        setChatHistory(prev => [...prev, { role: 'model', text: `Context refresh: ${contextNotice}` }]);
      }
      if (payload?.activeModel) setActiveModel(payload.activeModel);
    } catch (err) {
      console.error(err);
      setChatHistory(prev => [...prev, { role: 'model', text: 'Context refresh failed. Try again or upload the PDF manually for guaranteed full-paper interrogation.' }]);
    } finally {
      setIsRefreshingContext(false);
    }
  };

  const handleSendMessage = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!chatInput.trim() || !job?.result) return;

    const newUserMsg: ChatMessage = { role: 'user', text: chatInput };
    setChatHistory(prev => [...prev, newUserMsg]);
    setChatInput('');
    setIsChatting(true);

    try {
      if (USE_SERVER_PIPELINE) {
        const isImportedPaper = (job.result as any)?.paperContext?.sourceKind === 'imported';
        const preferFullPaper = isImportedPaper || shouldRequestFullPaperContext(newUserMsg.text);
        const chatRes = await apiFetch('/api/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: newUserMsg.text,
            history: chatHistory,
            pdfText: (job.result as any).pdfText || '',
            paperContext: (job.result as any).paperContext || null,
            preferFullPaper,
            forceContextRefresh: false,
          }),
        });
        if (!chatRes.ok) {
          const errText = await chatRes.text();
          throw new Error(`Backend chat failed (${chatRes.status}): ${errText}`);
        }
        const payload = await chatRes.json();
        if (payload?.activeModel) setActiveModel(payload.activeModel);
        const contextStatus = (payload?.contextStatus || '') as ContextStatus | '';
        const contextNotice = String(payload?.contextNotice || '').trim();
        if (contextStatus) setChatContextStatus(contextStatus);
        if (contextNotice) setChatContextNotice(contextNotice);
        setChatHistory(prev => {
          const next = [...prev];
          if (
            contextStatus &&
            contextStatus !== 'full_text' &&
            contextNotice &&
            contextNotice !== chatContextNotice
          ) {
            next.push({ role: 'model', text: `Context notice: ${contextNotice}` });
          }
          next.push({ role: 'model', text: payload?.reply || '' });
          return next;
        });
        return;
      }

      const keyConfig = getConfiguredKeys();
      if (!keyConfig) {
        throw new Error('No API key configured. Open API Key settings and add a key first.');
      }
      const chatPrimaryKey = keyConfig.primaryKey;
      const chatFallbackKey = keyConfig.fallbackKey;

      // Build conversation string natively for universality
      let conversationStr = "You are an expert AI answering questions about an ML paper. Be concise and brutally honest.\n\n";
      // Add existing history
      chatHistory.slice(1).forEach(msg => {
        conversationStr += `${msg.role === 'user' ? 'User' : 'Assistant'}: ${msg.text}\n\n`;
      });
      conversationStr += `User: ${newUserMsg.text}`;

      const wrapper = { base64: job.result.pdfBase64, text: (job.result as any).pdfText, mimeType: 'application/pdf' };
      const reply = await generateWithFallbackKey(chatPrimaryKey, chatFallbackKey, conversationStr, wrapper, undefined, 0.4);
      setChatHistory(prev => [...prev, { role: 'model', text: reply || '' }]);
    } catch (e) {
      console.error(e);
      setChatHistory(prev => [...prev, { role: 'model', text: 'Sorry, I encountered an error answering your question. Make sure your API key limits are sufficient.' }]);
    } finally {
      setIsChatting(false);
    }
  };

  const handleDownload = async () => {
    if (!job.result) return;

    const zip = new JSZip();
    Object.entries(job.result.files).forEach(([filename, content]) => {
      zip.file(filename, content as string, filename.endsWith('.sh') ? { unixPermissions: '755' } : undefined);
    });

    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'tldrun-repo.zip';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const handleDownloadNotebook = () => {
    if (!job.result?.files['train.ipynb']) return;
    const blob = new Blob([job.result.files['train.ipynb']], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'train.ipynb';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const hasConfiguredKeys = USE_SERVER_PIPELINE ? true : !!getConfiguredKeys();
  const catalogPapers = React.useMemo(() => {
    const deduped = new Map<string, SearchPaper>();
    [...PRELOADED_PAPERS, ...paperSearchResults].forEach((paper) => {
      if (typeof paper.year === 'number' && paper.year < paperMinYear) return;
      const key = paper.openAlexId || paper.id || paper.title.toLowerCase();
      if (!deduped.has(key)) deduped.set(key, paper);
    });
    return Array.from(deduped.values());
  }, [paperSearchResults, paperMinYear]);
  const normalizedQuery = paperQuery.trim().toLowerCase();
  const textFilteredPapers = React.useMemo(() => {
    if (!normalizedQuery) return catalogPapers;
    return catalogPapers.filter((paper) => {
      const haystack = [
        paper.title,
        (paper.authors || []).join(' '),
        paper.abstract,
        (paper.tags || []).join(' '),
      ].join(' ').toLowerCase();
      return haystack.includes(normalizedQuery);
    });
  }, [catalogPapers, normalizedQuery]);
  const paperTagOptions = ['All', ...Array.from(new Set(
    catalogPapers.flatMap((paper) => (paper.tags || []).filter(Boolean))
  )).slice(0, 18)];
  const visiblePaperResults = paperTagFilter === 'All'
    ? textFilteredPapers
    : textFilteredPapers.filter((paper) => (paper.tags || []).includes(paperTagFilter));
  const orderedResultFiles = React.useMemo(() => {
    const files = job?.result?.files || {};
    return Object.keys(files).sort((a, b) => filePriority(a) - filePriority(b) || a.localeCompare(b));
  }, [job?.result?.files]);
  const effectiveContextStatus = (chatContextStatus || job?.result?.paperContext?.contextStatus || '') as ContextStatus | '';
  const readiness = React.useMemo(
    () => computeImplementationReadiness(job?.result?.pipeline || {}, effectiveContextStatus),
    [job?.result?.pipeline, effectiveContextStatus],
  );

  return (
    <div className="min-h-screen font-sans text-foreground relative">
      <AnimatedBackground />

      {/* Pull to refresh */}
      <motion.div
        className="fixed top-0 left-0 right-0 flex justify-center items-end py-4 pointer-events-none z-[60] bg-primary/10 shadow-md backdrop-blur-md rounded-2xl-[2rem] border-b border-primary/20"
        initial={{ y: -100 }}
        animate={{ y: isRefreshing ? 0 : (pullY > 0 ? Math.min(pullY - 100, 0) : -100) }}
        transition={{ type: 'spring', damping: 20, stiffness: 300 }}
      >
        <div className="flex flex-col items-center gap-1.5 text-primary font-medium">
          {isRefreshing ? <Loader2 className="animate-spin mb-1" size={24} /> : <div className="text-3xl animate-bounce mb-1">🐾</div>}
          <span className="text-sm">{isRefreshing ? 'Refreshing Zoo...' : (pullY > 80 ? 'Release to refresh!' : 'Pull down...')}</span>
        </div>
      </motion.div>

      <header className="fixed top-0 left-0 right-0 z-50 border-b border-border/40 bg-background/60 backdrop-blur-xl overflow-hidden">

        {/* Dynamic Sidebar Toggle Button */}
        <motion.button
          initial={false}
          animate={{ x: isSidebarOpen ? 288 : 0 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          onClick={() => setIsSidebarOpen(!isSidebarOpen)}
          className="absolute left-0 top-0 bottom-0 w-16 flex items-center justify-center z-[60] cursor-pointer group"
        >
          <motion.div
            animate={{ rotate: isSidebarOpen ? 180 : 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="w-10 h-10 flex items-center justify-center rounded-full bg-primary/10 text-primary border border-primary/20 group-hover:bg-primary group-hover:text-primary-foreground group-hover:shadow-md transition-all duration-300"
          >
            <ChevronRight size={22} className="transition-transform group-hover:scale-110" />
          </motion.div>
        </motion.button>

        <motion.div
          layout
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className={cn(
            "h-16 flex items-center justify-between relative pl-16 pr-6 max-w-7xl",
            isSidebarOpen ? "lg:ml-72 lg:w-[calc(100%-18rem)]" : "mx-auto w-full"
          )}
        >

          <div className="flex items-center gap-1">
            <div className="flex items-center gap-3 relative z-10 bg-background/50 pl-2 pr-4 py-1.5 rounded-2xl backdrop-blur-md">
              <div className="bg-primary text-primary-foreground p-1.5 rounded-[14px] shadow-lg shadow-primary/20 relative overflow-hidden">
                <motion.div
                  className="absolute inset-0 w-24 h-full bg-gradient-to-r from-transparent via-white/30 to-transparent skew-x-12"
                  animate={{ x: ["-400%", "400%"] }}
                  transition={{ duration: 2.5, repeat: Infinity, ease: "linear", repeatDelay: 2 }}
                />
                <BrandLogo />
              </div>
              <h1 className="text-xl font-display font-bold tracking-tight">TL;DRun</h1>
            </div>

            {/* Walking Zoo */}
            <div className="hidden lg:flex pointer-events-none items-center opacity-90 overflow-hidden w-72 h-full relative" style={{ perspective: 1000 }}>
              <div className="animate-walk flex items-end gap-5 w-fit mix-blend-multiply dark:mix-blend-screen -ml-4">
                <PixelAnimal grid={PIXEL_SNAIL} className="w-5 h-5 animate-bounce text-emerald-500" style={{ animationDelay: '0ms' }} />
                <PixelAnimal grid={PIXEL_CAT} className="w-6 h-6 animate-bounce text-orange-400" style={{ animationDelay: '150ms' }} />
                <PixelAnimal grid={PIXEL_DOG} className="w-6 h-6 animate-bounce text-amber-600" style={{ animationDelay: '300ms' }} />
                <PixelAnimal grid={PIXEL_RABBIT} className="w-6 h-6 animate-bounce text-sky-400" style={{ animationDelay: '450ms' }} />
                <PixelAnimal grid={PIXEL_BIRD} className="w-5 h-5 animate-bounce mb-3 text-rose-400" style={{ animationDelay: '600ms' }} />
                <PixelAnimal grid={PIXEL_DOG} className="w-5 h-5 animate-bounce text-indigo-400" style={{ animationDelay: '750ms', transform: 'scaleX(-1)' }} />
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3 relative z-10 bg-background/50 p-1.5 rounded-2xl backdrop-blur-md tour-step-theme">
            {activeModel && (
              <div className="flex items-center gap-1.5 px-3 py-1 rounded-2xl bg-primary/10 border border-primary/20 text-xs font-mono text-primary animate-in fade-in">
                <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                {activeModel}
              </div>
            )}
            <ThemeToggle />
            <button
              onClick={goHome}
              title="Go Home"
              className="p-2 bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground rounded-xl transition-all duration-300 group shadow-sm flex items-center justify-center cursor-pointer"
            >
              <motion.div whileHover={{ y: -3 }} transition={{ type: "spring", stiffness: 400, damping: 10 }}>
                <Home size={18} className="transition-colors" />
              </motion.div>
            </button>
          </div>
        </motion.div>
      </header>

      <AnimatePresence>
        {isSidebarOpen && (
          <motion.aside
            initial={{ x: -300 }}
            animate={{ x: 0 }}
            exit={{ x: -300 }}
            transition={{ type: "spring", stiffness: 400, damping: 30 }}
            className="fixed left-0 top-16 bottom-0 w-72 bg-card/80 backdrop-blur-xl border-r border-border/50 z-40 p-4 flex flex-col overflow-y-auto custom-scrollbar shadow-[4px_0_24px_-12px_rgba(0,0,0,0.1)]"
          >
            <div className="flex items-center justify-between mb-6 pl-2">
              <h2 className="text-sm font-semibold font-display tracking-tight flex items-center gap-2">
                <Clock size={16} className="text-primary" /> Saved Papers
              </h2>
            </div>
            {history.length === 0 ? (
              <div className="flex flex-col items-center justify-center text-center p-6 bg-muted/30 rounded-2xl border border-dashed border-border/50">
                <FileText size={24} className="text-muted-foreground mb-3 opacity-30" />
                <p className="text-xs text-muted-foreground">Papers you extract will be saved locally here.</p>
              </div>
            ) : (
              <div className="space-y-3">
                {history.map(item => (
                  <button
                    key={item.id}
                    onClick={() => {
                      setJob(item.jobData);
                      setFile(new File([], item.filename));
                      setActiveTab('readiness');
                      setResultPane('summary');
                      setHasOpenedCodePane(false);
                      setActiveFile(pickInitialFile(item.jobData?.result?.files));
                      setChatHistory(item.chatHistory || []);
                      const savedPaperContext = item.jobData?.result?.paperContext as any;
                      const savedStatus = (savedPaperContext?.contextStatus || '') as ContextStatus | '';
                      const savedReason = String(savedPaperContext?.contextReason || 'metadata_only');
                      if (savedStatus) {
                        setChatContextStatus(savedStatus);
                        setChatContextNotice(buildClientContextNotice(savedStatus, savedReason));
                      } else {
                        setChatContextStatus('');
                        setChatContextNotice('');
                      }
                      setActiveHistoryId(item.id);
                      if (window.innerWidth < 1024) setIsSidebarOpen(false);
                    }}
                    className="w-full text-left p-3.5 rounded-2xl hover:bg-muted/50 border border-transparent hover:border-border transition-all group flex flex-col gap-2 relative bg-background/50 shadow-sm"
                  >
                    <div className="flex items-start justify-between">
                      <h3 className="text-[13px] font-bold text-foreground truncate max-w-[180px] leading-tight pr-4">{item.filename}</h3>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setHistory(prev => {
                            const updated = prev.filter(h => h.id !== item.id);
                            if (updated.length === 0) set('tldrun_history', updated); // force clear if empty
                            return updated;
                          });
                          if (job.status === 'completed' && activeHistoryId === item.id) {
                            setJob({ status: 'idle', progress: '' });
                            setFile(null);
                            setResultPane('summary');
                            setHasOpenedCodePane(false);
                            setActiveHistoryId(null);
                            setChatHistory([]);
                            setChatContextStatus('');
                            setChatContextNotice('');
                          }
                        }}
                        className="opacity-0 group-hover:opacity-100 p-1 text-muted-foreground hover:text-red-500 transition-colors absolute top-2 right-2 rounded-xl hover:bg-red-500/10"
                        title="Delete saved paper"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                    <p className="text-[11px] text-muted-foreground leading-snug line-clamp-3">{item.summary}</p>
                    <div className="text-[10px] text-muted-foreground/50 font-mono mt-1 pt-2 border-t border-border/50 flex justify-between items-center w-full">
                      <span>{new Date(item.date).toLocaleDateString()}</span>
                      <span className="text-primary opacity-60">View Details &rarr;</span>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </motion.aside>
        )}
      </AnimatePresence>

      <motion.main
        layout
        transition={{ type: "spring", stiffness: 400, damping: 30 }}
        className={cn(
          "pt-24 pb-12 px-6 min-h-screen flex flex-col max-w-7xl",
          isSidebarOpen ? "lg:ml-72 lg:w-[calc(100%-18rem)]" : "mx-auto w-full"
        )}
      >
        <AnimatePresence mode="wait">
          {job.status === 'idle' && (
            <motion.div
              key="upload"
              initial={{ opacity: 0, y: 40 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.95, filter: "blur(10px)" }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="flex-1 flex flex-col gap-6"
            >
              <div className="w-full flex flex-wrap items-center gap-2 bg-card/70 border border-border rounded-2xl p-2 backdrop-blur-xl">
                <button
                  onClick={() => setHomeTab('upload')}
                  className={cn(
                    "px-4 py-2 text-sm font-semibold rounded-xl transition-all",
                    homeTab === 'upload'
                      ? "bg-background text-foreground shadow-sm border border-border"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                  )}
                >
                  Upload
                </button>
                <button
                  onClick={() => setHomeTab('papers')}
                  className={cn(
                    "px-4 py-2 text-sm font-semibold rounded-xl transition-all",
                    homeTab === 'papers'
                      ? "bg-background text-foreground shadow-sm border border-border"
                      : "text-muted-foreground hover:text-foreground hover:bg-muted/50",
                  )}
                >
                  Papers
                </button>
                <div className="ml-auto px-3 py-2 rounded-xl border border-border bg-background/70 text-xs font-mono text-muted-foreground">
                  {demoQuota
                    ? `Daily runs: ${demoQuota.remaining}/${demoQuota.limit} · chats: ${demoQuota.chatRemaining ?? '-'}${demoQuota.chatLimit ? `/${demoQuota.chatLimit}` : ''} · resets in ${formatQuotaResetCountdown(demoQuota.resetAt, nowTick)}`
                    : 'Daily limit: loading...'}
                </div>
              </div>

              {homeTab === 'upload' && (
              <div className="flex-1 flex flex-col lg:flex-row items-center justify-center gap-12 lg:gap-24">
              <div className="flex-1 max-w-xl text-center lg:text-left">
                <div className="relative inline-flex mb-6">
                  <motion.div
                    initial={{ opacity: 0, y: 6, scale: 0.95 }}
                    animate={{ opacity: 1, y: [0, -3, 0], scale: [1, 1.02, 1] }}
                    transition={{ delay: 0.35, duration: 1.8, repeat: Infinity, ease: "easeInOut" }}
                    className="absolute -top-7 left-1/2 -translate-x-1/2 z-10 px-2.5 py-1 rounded-full bg-emerald-500/20 border border-emerald-400/40 text-emerald-300 text-[11px] font-bold uppercase tracking-wider shadow-md backdrop-blur-sm flex items-center gap-1.5"
                  >
                    <svg viewBox="0 0 12 12" className="w-3 h-3" fill="none" aria-hidden="true">
                      <circle cx="6" cy="6" r="4" fill="currentColor" className="opacity-80" />
                    </svg>
                    Demo
                    <span className="absolute -bottom-1.5 left-1/2 -translate-x-1/2 w-2.5 h-2.5 bg-emerald-500/20 border-r border-b border-emerald-400/40 rotate-45" />
                  </motion.div>
                  <motion.div
                    initial={{ opacity: 0, x: -20 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ delay: 0.2, duration: 0.5 }}
                    className="inline-flex items-center gap-2 px-3 py-1 rounded-2xl bg-primary/10 text-primary text-sm font-medium border border-primary/20"
                  >
                    <Flame size={14} /> Anti-Hype AI Engine
                  </motion.div>
                </div>
                <motion.h2
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.3, duration: 0.5 }}
                  className="text-5xl lg:text-7xl font-display font-bold tracking-tighter leading-[1.1] mb-6"
                >
                  Academic Hype to <br />
                  <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-500 to-purple-500">Runnable Code.</span>
                </motion.h2>
                <motion.p
                  initial={{ opacity: 0, y: 20 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.4, duration: 0.5 }}
                  className="text-lg lg:text-xl text-muted-foreground mb-8 leading-relaxed"
                >
                  Upload any ML paper. We'll extract the real pipeline, roast the missing details, estimate the true hardware cost, and generate a PyTorch repo in seconds.
                </motion.p>
              </div>

              <motion.div
                initial={{ opacity: 0, scale: 0.9 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: 0.5, duration: 0.5, type: "spring" }}
                className="flex-1 w-full max-w-md"
              >
                <div className="bg-card/50 backdrop-blur-xl p-2 rounded-2xl border border-border shadow-md tour-step-upload">
                  <div
                    className={cn(
                      "relative border-2 border-dashed rounded-2xl p-12 text-center transition-all duration-300 flex flex-col items-center justify-center min-h-[320px]",
                      isDragging ? "border-primary bg-primary/5 scale-[0.98]" : "border-border hover:border-primary/50 hover:bg-muted/50",
                      file ? "border-emerald-500/50 bg-emerald-500/5" : ""
                    )}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    onDrop={handleDrop}
                  >
                    <input
                      type="file"
                      accept="application/pdf"
                      onChange={handleFileChange}
                      className="absolute inset-0 w-full h-full opacity-0 cursor-pointer z-10"
                    />

                    <AnimatePresence mode="wait">
                      {!file ? (
                        <motion.div
                          key="empty"
                          initial={{ opacity: 0, scale: 0.8 }}
                          animate={{ opacity: 1, scale: 1 }}
                          exit={{ opacity: 0, scale: 0.8 }}
                          className="flex flex-col items-center gap-4"
                        >
                          <motion.div
                            drag dragConstraints={{ left: -15, right: 15, top: -15, bottom: 15 }} dragElastic={0.4}
                            animate={{ y: [0, -6, 0] }}
                            transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                            className="bg-background p-4 rounded-2xl shadow-md border border-primary/20 text-primary cursor-grab active:cursor-grabbing hover:bg-primary/5 transition-colors"
                          >
                            <Upload size={32} />
                          </motion.div>
                          <div>
                            <p className="text-lg font-medium text-foreground">
                              Drop your PDF here
                            </p>
                            <p className="text-sm text-muted-foreground mt-1">or click to browse</p>
                          </div>
                        </motion.div>
                      ) : (
                        <motion.div
                          key="file"
                          initial={{ opacity: 0, scale: 0.5, rotate: -10 }}
                          animate={{ opacity: 1, scale: 1, rotate: 0 }}
                          exit={{ opacity: 0, scale: 0.8 }}
                          transition={{ type: "spring", stiffness: 400, damping: 20 }}
                          className="flex flex-col items-center gap-4"
                        >
                          <motion.div
                            className="bg-emerald-500/10 p-4 rounded-2xl text-emerald-500"
                            initial={{ scale: 0 }}
                            animate={{ scale: 1 }}
                            transition={{ type: "spring", stiffness: 500, damping: 15, delay: 0.1 }}
                          >
                            <FileText size={32} />
                          </motion.div>
                          <div>
                            <p className="text-lg font-medium text-foreground truncate max-w-[200px]">
                              {file.name}
                            </p>
                            <motion.p
                              initial={{ opacity: 0, y: 5 }}
                              animate={{ opacity: 1, y: 0 }}
                              transition={{ delay: 0.2 }}
                              className="text-sm text-emerald-500 mt-1 font-medium"
                            >
                              ✓ Ready to process
                            </motion.p>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>

                  <div className="mt-2">
                    <button
                      onClick={handleUpload}
                      disabled={!file || !hasConfiguredKeys}
                      className={cn(
                        "w-full py-4 rounded-2xl font-medium transition-all duration-300 flex items-center justify-center gap-2 text-lg",
                        file && hasConfiguredKeys
                          ? "bg-primary text-primary-foreground hover:bg-primary/90 shadow-md shadow-md/20 hover:shadow-md hover:shadow-md/30 translate-y-0"
                          : "bg-muted text-muted-foreground cursor-not-allowed"
                      )}
                    >
                      Generate Repository <ChevronRight size={20} />
                    </button>
                  </div>

                  {!USE_SERVER_PIPELINE && (
                    <div className="mt-3 border border-border/60 rounded-2xl bg-background/40 p-3">
                      <button
                        onClick={() => setShowApiConfig(prev => !prev)}
                        className="w-full text-left text-xs font-mono uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
                      >
                        {showApiConfig ? 'Hide API Key Settings' : 'Show API Key Settings'}
                      </button>
                      {showApiConfig && (
                        <div className="mt-3 space-y-2">
                          <input
                            type="password"
                            value={primaryApiKey}
                            onChange={(e) => setPrimaryApiKey(e.target.value)}
                            placeholder="Primary key (Gemini/OpenRouter/OpenAI/Anthropic/Groq)"
                            className="w-full bg-background border border-border rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
                          />
                          <input
                            type="password"
                            value={fallbackApiKey}
                            onChange={(e) => setFallbackApiKey(e.target.value)}
                            placeholder="Fallback key (optional)"
                            className="w-full bg-background border border-border rounded-xl px-3 py-2 text-xs focus:outline-none focus:ring-2 focus:ring-primary/40"
                          />
                          <p className="text-[11px] text-muted-foreground leading-relaxed">
                            Keys are stored locally in your browser on this device.
                            {!ALLOW_INSECURE_CLIENT_KEYS && ' Env keys are disabled by default for safer production builds.'}
                          </p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
              </div>
              )}

              {homeTab === 'papers' && (
                <div className="flex-1 w-full space-y-4">
                  <div>
                    <h3 className="text-3xl font-display font-bold tracking-tight">Papers</h3>
                    <p className="text-muted-foreground mt-1">Browse curated papers ({paperMinYear}+), filter by tags, then import directly into implementation mode.</p>
                  </div>

                  <form onSubmit={handlePaperSearch} className="flex flex-col sm:flex-row gap-2">
                    <input
                      value={paperQuery}
                      onChange={(e) => setPaperQuery(e.target.value)}
                      placeholder="Search papers, tags, authors..."
                      className="w-full bg-background border border-border rounded-xl px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                    />
                    <button
                      type="submit"
                      disabled={isPaperSearchLoading}
                      className="px-4 py-3 rounded-xl text-sm font-semibold bg-primary text-primary-foreground disabled:opacity-60"
                    >
                      {isPaperSearchLoading ? 'Searching...' : 'Search'}
                    </button>
                  </form>

                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-xs text-muted-foreground">Year:</span>
                    {PAPER_YEAR_OPTIONS.map((year) => (
                      <button
                        key={year}
                        type="button"
                        onClick={() => {
                          setPaperMinYear(year);
                          setPaperTagFilter('All');
                        }}
                        className={cn(
                          "px-3 py-1.5 rounded-full text-xs border transition-colors",
                          paperMinYear === year
                            ? "bg-primary text-primary-foreground border-primary"
                            : "bg-card/70 border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                        )}
                      >
                        {year}+
                      </button>
                    ))}
                  </div>

                  {paperTagOptions.length > 1 && (
                    <div className="space-y-2">
                      <p className="text-xs text-muted-foreground">Filter by tags</p>
                      <div className="flex flex-wrap gap-2">
                      {paperTagOptions.map((tag) => (
                        <button
                          key={tag}
                          onClick={() => setPaperTagFilter(tag)}
                          className={cn(
                            "px-3 py-1.5 rounded-full text-xs border transition-colors",
                            paperTagFilter === tag
                              ? "bg-primary text-primary-foreground border-primary"
                              : "bg-card/70 border-border text-muted-foreground hover:text-foreground hover:border-primary/40"
                          )}
                        >
                          {tag}
                        </button>
                      ))}
                    </div>
                    </div>
                  )}

                  {paperSearchError && (
                    <p className="text-sm text-red-500">{paperSearchError}</p>
                  )}

                  {visiblePaperResults.length > 0 && (
                    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
                      {visiblePaperResults.map((paper) => {
                        const rowId = paper.openAlexId || paper.id;
                        const importing = importingPaperId === rowId;
                        return (
                          <div key={rowId} className="bg-card/80 border border-border rounded-2xl p-4 flex flex-col gap-3 shadow-sm">
                            <div className="flex items-center justify-between gap-2">
                              <div className="flex items-center gap-1">
                                <span className="text-xs font-mono px-2 py-1 rounded-lg bg-muted border border-border text-muted-foreground">{paper.year || 'n/a'}</span>
                                {!paper.openAlexId && (
                                  <span className="text-[10px] uppercase tracking-wider px-2 py-1 rounded-lg border border-primary/30 bg-primary/10 text-primary">Curated</span>
                                )}
                              </div>
                              <button
                                onClick={() => handleImportPaper(paper)}
                                disabled={importingPaperId !== null}
                                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 text-white disabled:opacity-60"
                              >
                                {importing ? 'Importing...' : 'Import'}
                              </button>
                            </div>
                            <h4 className="font-semibold text-lg leading-tight line-clamp-2">{paper.title}</h4>
                            <p className="text-xs text-muted-foreground line-clamp-2">{paper.authors?.slice(0, 4).join(', ') || 'Unknown authors'}</p>
                            <p className="text-sm text-muted-foreground leading-relaxed line-clamp-4">{paper.abstract || 'No abstract available.'}</p>
                            {(paper.tags || []).length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {(paper.tags || []).slice(0, 4).map((tag) => (
                                  <button
                                    key={tag}
                                    onClick={() => setPaperTagFilter(tag)}
                                    className="text-[11px] px-2 py-1 rounded-full border border-border bg-muted/40 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
                                  >
                                    {tag}
                                  </button>
                                ))}
                              </div>
                            )}
                            {paper.url && (
                              <a
                                href={paper.url}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="text-xs font-medium text-blue-500 hover:text-blue-400 mt-auto inline-flex items-center gap-1"
                              >
                                View Source <ExternalLink size={12} />
                              </a>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}

                  {paperSearchAttempted && !isPaperSearchLoading && !paperSearchError && visiblePaperResults.length === 0 && (
                    <div className="border border-dashed border-border rounded-2xl p-8 text-center text-muted-foreground">
                      No papers found for this query/filter. Try a different tag or clear the search.
                    </div>
                  )}
                </div>
              )}
            </motion.div>
          )}

          {job.status === 'processing' && (
            <motion.div
              key="processing"
              initial={{ opacity: 0, scale: 0.95, filter: "blur(10px)" }}
              animate={{ opacity: 1, scale: 1, filter: "blur(0px)" }}
              exit={{ opacity: 0, y: -20 }}
              transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
              className="flex-1 flex flex-col items-center justify-center max-w-2xl mx-auto w-full"
            >
              <motion.div
                className="relative mb-12"
                animate={{ y: [0, -8, 0] }}
                transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
              >
                <motion.div
                  className="absolute inset-0 bg-primary/20 blur-3xl rounded-2xl"
                  animate={{ opacity: [0.3, 0.6, 0.3], scale: [0.95, 1.05, 0.95] }}
                  transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                />
                <div className="bg-card border border-border p-6 rounded-2xl shadow-md relative">
                  <Loader2 size={48} className="animate-spin text-primary" />
                </div>
              </motion.div>

              <motion.h3
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.2 }}
                className="text-3xl font-display font-bold tracking-tight mb-3 text-center"
              >
                Synthesizing Codebase
              </motion.h3>
              <motion.p
                key={job.progress}
                initial={{ opacity: 0, y: 5 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.3 }}
                className="text-muted-foreground text-lg mb-10 text-center"
              >
                {job.progress}
              </motion.p>

              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3, duration: 0.5 }}
                className="w-full bg-card/50 backdrop-blur-xl rounded-2xl border border-border p-8 shadow-md"
              >
                <div className="space-y-6 relative before:absolute before:inset-0 before:ml-[27px] before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-border before:to-transparent">
                  {[
                    { step: "Step 1/5: Extracting pipeline from PDF...", icon: <FileText size={18} /> },
                    { step: "Step 2/5: Generating config.yaml...", icon: <Settings size={18} /> },
                    { step: "Step 3/5: Generating PyTorch code skeleton...", icon: <Code size={18} /> },
                    { step: "Step 4/5: Generating Dockerfile and requirements...", icon: <Package size={18} /> },
                    { step: "Step 5/5: Generating README.md...", icon: <FileJson size={18} /> },
                  ].map((s, i) => (
                    <motion.div
                      key={s.step}
                      initial={{ opacity: 0, x: -20 }}
                      animate={{ opacity: 1, x: 0 }}
                      transition={{ delay: 0.4 + i * 0.1, duration: 0.4, ease: "easeOut" }}
                    >
                      <StepIndicator current={job.progress} step={s.step} icon={s.icon} />
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            </motion.div>
          )}

          {job.status === 'failed' && (
            <motion.div
              key="failed"
              initial={{ opacity: 0, y: 30, filter: "blur(8px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={{ duration: 0.5 }}
              className="flex-1 flex flex-col items-center justify-center p-6 text-center"
            >
              <div className="bg-red-500/10 text-red-500 p-6 rounded-3xl mb-6 shadow-sm border border-red-500/20">
                <Flame size={56} className="animate-pulse" />
              </div>
              <h2 className="text-3xl font-bold font-display tracking-tight mb-4">Pipeline Failed</h2>
              <p className="text-muted-foreground max-w-lg mx-auto mb-8 bg-muted/30 p-4 rounded-xl font-mono text-sm border border-border/50 text-left overflow-x-auto">
                {job.error || 'An unknown error occurred.'}
              </p>
              <button
                onClick={() => setJob({ status: 'idle', progress: '' })}
                className="bg-primary hover:bg-primary/90 shadow-md hover:shadow-lg hover:-translate-y-0.5 text-primary-foreground px-8 py-4 rounded-2xl font-semibold transition-all"
              >
                Try Again
              </button>
            </motion.div>
          )}

          {job.status === 'completed' && job.result && (
            <motion.div
              key="completed"
              initial={{ opacity: 0, y: 30, filter: "blur(8px)" }}
              animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
              transition={{ duration: 0.7, ease: [0.22, 1, 0.36, 1] }}
              className="grid grid-cols-1 xl:grid-cols-12 gap-6 min-h-[800px] xl:h-[calc(100vh-12rem)]"
            >
              {activeTab === 'interrogate' ? (
                <div className="xl:col-span-12 flex flex-col h-full bg-card/80 backdrop-blur-xl rounded-2xl border border-border overflow-hidden shadow-md animate-in fade-in zoom-in-95 duration-300">
                  <div className="flex items-center gap-4 p-4 border-b border-border bg-background/50">
                    <button onClick={() => setActiveTab('reality')} className="p-2 rounded-2xl text-muted-foreground hover:text-foreground hover:bg-muted transition-colors">
                      <ArrowLeft size={20} />
                    </button>
                    <div>
                      <h3 className="font-display font-bold text-lg">Paper Interrogation Chat</h3>
                      <p className="text-xs text-muted-foreground">Ask anything about the methodology, secrets, or data.</p>
                    </div>
                    <button
                      onClick={handleRefreshFullContext}
                      disabled={!USE_SERVER_PIPELINE || isRefreshingContext || isChatting}
                      className="ml-auto inline-flex items-center gap-2 px-3 py-2 rounded-xl border border-border bg-background text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-60"
                    >
                      <RefreshCw size={14} className={cn(isRefreshingContext ? 'animate-spin' : '')} />
                      {isRefreshingContext ? 'Refreshing...' : 'Refresh full context'}
                    </button>
                  </div>
                  <div className="flex-1 overflow-y-auto p-6 space-y-6 custom-scrollbar bg-card/30">
                    {chatContextNotice && chatContextStatus && chatContextStatus !== 'full_text' && (
                      <div className="max-w-5xl mx-auto rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100 flex flex-col gap-2">
                        <div className="flex items-start gap-2 text-amber-200">
                          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
                          <span>{chatContextNotice}</span>
                        </div>
                        <div>
                          <button
                            onClick={goHome}
                            className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90"
                          >
                            <Upload size={12} /> Upload PDF For Full Context
                          </button>
                        </div>
                      </div>
                    )}
                    {chatHistory.map((msg, idx) => (
                      <div key={idx} className={cn("flex gap-4 max-w-5xl mx-auto", msg.role === 'user' ? "flex-row-reverse" : "")}>
                        <div className={cn(
                          "w-10 h-10 rounded-2xl flex items-center justify-center shrink-0 shadow-md",
                          msg.role === 'user' ? "bg-primary text-primary-foreground" : "bg-muted text-foreground border border-border"
                        )}>
                          {msg.role === 'user' ? <MessageSquare size={18} /> : <Sparkles size={18} />}
                        </div>
                        <div className={cn(
                          "p-5 rounded-2xl max-w-[85%] text-sm leading-relaxed shadow-md overflow-x-auto",
                          msg.role === 'user'
                            ? "bg-primary text-primary-foreground rounded-2xl-sm"
                            : "bg-background border border-border rounded-2xl-sm text-foreground prose-sm prose dark:prose-invert"
                        )}>
                          {msg.role === 'user' ? (
                            msg.text
                          ) : (
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>
                              {msg.text}
                            </ReactMarkdown>
                          )}
                        </div>
                      </div>
                    ))}
                    {isChatting && (
                      <div className="flex gap-4 max-w-5xl mx-auto">
                        <div className="w-10 h-10 rounded-2xl bg-muted border border-border text-foreground flex items-center justify-center shrink-0 shadow-md">
                          <Sparkles size={18} />
                        </div>
                        <div className="p-5 rounded-2xl bg-background border border-border rounded-2xl-sm flex items-center gap-2 shadow-md">
                          <span className="w-2 h-2 bg-primary/50 rounded-2xl animate-bounce" />
                          <span className="w-2 h-2 bg-primary/50 rounded-2xl animate-bounce" style={{ animationDelay: '0.2s' }} />
                          <span className="w-2 h-2 bg-primary/50 rounded-2xl animate-bounce" style={{ animationDelay: '0.4s' }} />
                        </div>
                      </div>
                    )}
                    <div ref={chatEndRef} />
                  </div>
                  <div className="p-4 bg-background/50 border-t border-border">
                    <form onSubmit={handleSendMessage} className="relative max-w-5xl mx-auto flex items-center gap-3">
                      <input
                        type="text"
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        placeholder="Ask about the methodology, datasets, or hidden tricks..."
                        className="flex-1 bg-background border border-border rounded-2xl px-5 py-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary/50 transition-all shadow-md"
                        disabled={isChatting}
                      />
                      <button
                        type="submit"
                        disabled={!chatInput.trim() || isChatting}
                        className="p-4 bg-primary text-primary-foreground rounded-2xl disabled:opacity-50 transition-opacity flex items-center justify-center shadow-md hover:bg-primary/90"
                      >
                        <Send size={20} />
                      </button>
                    </form>
                  </div>
                </div>
              ) : (
                <>
                  {/* Sidebar */}
                  <div className="xl:col-span-12 flex flex-col gap-6 h-full">
                    <div className="bg-card/80 backdrop-blur-xl rounded-2xl border border-border p-6 shadow-md flex-shrink-0">
                      <div className="flex items-center gap-4 mb-6">
                        <div className="bg-emerald-500/10 text-emerald-500 p-3 rounded-2xl">
                          <CheckCircle size={28} />
                        </div>
                        <div>
                          <h3 className="text-xl font-display font-bold">Generation Complete</h3>
                          <p className="text-sm text-muted-foreground">Your repository is ready to run</p>
                        </div>
                      </div>

                      <div className="flex gap-3">
                        <button
                          onClick={handleDownload}
                          className="flex-1 bg-primary text-primary-foreground px-4 py-3 rounded-2xl font-medium hover:bg-primary/90 transition-all shadow-md shadow-md/20 flex items-center justify-center gap-2 text-sm"
                        >
                          <Download size={18} /> ZIP
                        </button>
                        <button
                          onClick={handleDownloadNotebook}
                          className="flex-1 bg-emerald-500 text-white px-4 py-3 rounded-2xl font-medium hover:bg-emerald-600 transition-all shadow-md shadow-md-500/20 flex items-center justify-center gap-2 text-sm"
                        >
                          <DownloadCloud size={18} /> .ipynb
                        </button>
                      </div>

                      <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                        <button
                          onClick={() => copyQuickstart('venv')}
                          className="px-3 py-2 rounded-xl border border-border bg-background text-xs font-semibold hover:bg-muted flex items-center justify-center gap-2"
                        >
                          <Copy size={14} />
                          {quickstartCopied === 'venv' ? 'Copied (venv)' : 'Copy Quickstart (venv)'}
                        </button>
                        <button
                          onClick={() => copyQuickstart('docker')}
                          className="px-3 py-2 rounded-xl border border-border bg-background text-xs font-semibold hover:bg-muted flex items-center justify-center gap-2"
                        >
                          <Copy size={14} />
                          {quickstartCopied === 'docker' ? 'Copied (docker)' : 'Copy Quickstart (docker)'}
                        </button>
                      </div>

                      {job.result.paperContext?.sourceKind === 'imported' && job.result.paperContext?.contextStatus && job.result.paperContext.contextStatus !== 'full_text' && (
                        <div className="mt-3 rounded-2xl border border-amber-500/30 bg-amber-500/10 p-3">
                          <p className="text-xs text-amber-100 leading-relaxed">
                            Full text unavailable for this paper. Upload PDF to interrogate the complete paper.
                          </p>
                          <button
                            onClick={goHome}
                            className="mt-2 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-primary text-primary-foreground text-xs font-semibold hover:bg-primary/90"
                          >
                            <Upload size={12} />
                            Go To Upload
                          </button>
                        </div>
                      )}
                    </div>

                    <div className="flex items-center gap-2 bg-card/80 border border-border rounded-2xl p-2 shadow-sm">
                      <button
                        onClick={() => setResultPane('summary')}
                        className={cn(
                          "px-4 py-2 rounded-xl text-sm font-semibold transition-all",
                          resultPane === 'summary'
                            ? "bg-background text-foreground border border-border shadow-sm"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                        )}
                      >
                        Summary
                      </button>
                      <button
                        onClick={() => {
                          setResultPane('code');
                          setHasOpenedCodePane(true);
                          if (job.result?.files && !job.result.files[activeFile]) {
                            setActiveFile(pickInitialFile(job.result.files));
                          }
                        }}
                        className={cn(
                          "px-4 py-2 rounded-xl text-sm font-semibold transition-all border",
                          resultPane === 'code'
                            ? "bg-background text-foreground border-border shadow-sm"
                            : "text-muted-foreground hover:text-foreground hover:bg-muted/50 border-transparent",
                          !hasOpenedCodePane && resultPane !== 'code' ? "animate-pulse border-primary/40 text-primary" : ""
                        )}
                      >
                        Code & Docs
                      </button>
                    </div>

                    {resultPane === 'summary' && (
                    <div className="bg-card/80 backdrop-blur-xl rounded-2xl border border-border overflow-hidden shadow-md flex-1 flex flex-col min-h-0">
                      <div className="flex flex-wrap border-b border-border p-2 gap-2 flex-shrink-0">
                        <button
                          className={cn(
                            "flex-1 py-1.5 px-3 text-xs font-medium rounded-2xl transition-all whitespace-nowrap",
                            activeTab === 'readiness' ? "bg-background text-foreground shadow-md" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          )}
                          onClick={() => setActiveTab('readiness')}
                        >
                          Readiness
                        </button>
                        <button
                          className={cn(
                            "flex-1 py-1.5 px-3 text-xs font-medium rounded-2xl transition-all whitespace-nowrap",
                            activeTab === 'reality' ? "bg-background text-foreground shadow-md" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          )}
                          onClick={() => setActiveTab('reality')}
                        >
                          Reality Check
                        </button>
                        <button
                          className={cn(
                            "flex-1 py-1.5 px-3 text-xs font-medium rounded-2xl transition-all whitespace-nowrap",
                            activeTab === 'architecture' ? "bg-background text-foreground shadow-md" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          )}
                          onClick={() => setActiveTab('architecture')}
                        >
                          Architecture
                        </button>
                        <button
                          className={cn(
                            "flex-1 py-1.5 px-3 text-xs font-medium rounded-2xl transition-all whitespace-nowrap",
                            activeTab === 'pipeline' ? "bg-background text-foreground shadow-md" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          )}
                          onClick={() => setActiveTab('pipeline')}
                        >
                          Pipeline
                        </button>
                        <button
                          className={cn(
                            "flex-1 py-1.5 px-3 text-xs font-medium rounded-2xl transition-all whitespace-nowrap",
                            activeTab === 'assumptions' ? "bg-background text-foreground shadow-md" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          )}
                          onClick={() => setActiveTab('assumptions')}
                        >
                          Assumptions
                        </button>
                        <button
                          className={cn(
                            "flex-1 py-1.5 px-3 text-xs font-medium rounded-2xl transition-all whitespace-nowrap",
                            activeTab === 'related' ? "bg-background text-foreground shadow-md" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          )}
                          onClick={() => setActiveTab('related')}
                        >
                          Related Work
                        </button>
                        <button
                          className={cn(
                            "flex-1 py-1.5 px-3 text-xs font-medium rounded-2xl transition-all whitespace-nowrap",
                            activeTab === 'interrogate' ? "bg-background text-foreground shadow-md" : "text-muted-foreground hover:text-foreground hover:bg-muted/50"
                          )}
                          onClick={() => setActiveTab('interrogate')}
                        >
                          Interrogate
                        </button>
                      </div>
                      <div className="p-6 overflow-y-auto flex-1 custom-scrollbar">
                        <div className="mb-6 rounded-2xl border border-border/60 bg-muted/20 overflow-hidden">
                          <table className="w-full text-xs sm:text-sm">
                            <tbody>
                              <tr className="border-b border-border/60">
                                <th className="w-1/3 text-left font-mono uppercase tracking-wider text-muted-foreground px-4 py-3">Input</th>
                                <td className="px-4 py-3 text-foreground">{file?.name || 'Imported paper'}</td>
                              </tr>
                              <tr className="border-b border-border/60">
                                <th className="text-left font-mono uppercase tracking-wider text-muted-foreground px-4 py-3">Context</th>
                                <td className="px-4 py-3 text-foreground">
                                  {formatContextStatus(effectiveContextStatus)}
                                </td>
                              </tr>
                              <tr className="border-b border-border/60">
                                <th className="text-left font-mono uppercase tracking-wider text-muted-foreground px-4 py-3">Reproducibility</th>
                                <td className="px-4 py-3 text-foreground">{job.result.pipeline.reproducibility_score}%</td>
                              </tr>
                              <tr className="border-b border-border/60">
                                <th className="text-left font-mono uppercase tracking-wider text-muted-foreground px-4 py-3">Implementation Readiness</th>
                                <td className="px-4 py-3 text-foreground">{readiness.score}/100</td>
                              </tr>
                              <tr>
                                <th className="text-left font-mono uppercase tracking-wider text-muted-foreground px-4 py-3">Core Concept</th>
                                <td className="px-4 py-3 text-foreground">{job.result.pipeline.core_concept || 'n/a'}</td>
                              </tr>
                            </tbody>
                          </table>
                        </div>
                        <AnimatePresence mode="wait">
                          {activeTab === 'readiness' && (
                            <motion.div key="tab-readiness" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="space-y-5">
                              <div className={cn(
                                "rounded-2xl border p-4",
                                readiness.level === 'high'
                                  ? "bg-emerald-500/10 border-emerald-500/30"
                                  : readiness.level === 'medium'
                                    ? "bg-amber-500/10 border-amber-500/30"
                                    : "bg-red-500/10 border-red-500/30"
                              )}>
                                <div className="flex items-center justify-between gap-3">
                                  <div>
                                    <h4 className="text-xs font-mono font-semibold uppercase tracking-wider text-muted-foreground">Implementation Readiness</h4>
                                    <p className="text-sm text-muted-foreground mt-1">
                                      Estimated chance this paper can be implemented cleanly with current context.
                                    </p>
                                  </div>
                                  <div className="text-right">
                                    <p className="text-3xl font-display font-bold">{readiness.score}</p>
                                    <p className="text-xs uppercase tracking-wider text-muted-foreground">{readiness.level}</p>
                                  </div>
                                </div>
                                <div className="mt-3 h-2 rounded-full bg-background/70 overflow-hidden">
                                  <div
                                    className={cn(
                                      "h-full transition-all",
                                      readiness.level === 'high' ? "bg-emerald-500" : readiness.level === 'medium' ? "bg-amber-500" : "bg-red-500"
                                    )}
                                    style={{ width: `${readiness.score}%` }}
                                  />
                                </div>
                              </div>

                              <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                                <div className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                                  <h5 className="text-xs font-mono font-semibold uppercase tracking-wider text-red-400 mb-3">Top Blockers</h5>
                                  <ul className="space-y-2">
                                    {(readiness.blockers.length ? readiness.blockers : ['No critical blockers identified.']).map((item, idx) => (
                                      <li key={idx} className="text-sm text-foreground leading-relaxed flex items-start gap-2">
                                        <span className="mt-1 text-red-400">-</span>
                                        <span>{item}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>

                                <div className="rounded-2xl border border-border/60 bg-muted/20 p-4">
                                  <h5 className="text-xs font-mono font-semibold uppercase tracking-wider text-emerald-400 mb-3">Top Actions</h5>
                                  <ul className="space-y-2">
                                    {readiness.actions.map((item, idx) => (
                                      <li key={idx} className="text-sm text-foreground leading-relaxed flex items-start gap-2">
                                        <span className="mt-1 text-emerald-400">{idx + 1}.</span>
                                        <span>{item}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </div>
                            </motion.div>
                          )}

                          {activeTab === 'reality' && (
                            <motion.div key="tab-reality" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="space-y-6">
                              <div className="bg-primary/5 border border-primary/20 p-4 rounded-2xl relative overflow-hidden">
                                <div className="flex items-center justify-between mb-2">
                                  <h4 className="text-xs font-mono font-semibold text-primary uppercase tracking-wider flex items-center gap-2">
                                    <Flame size={14} /> Anti-Hype Summary
                                  </h4>
                                </div>
                                <p className="text-sm text-foreground font-medium leading-relaxed">{job.result.pipeline.anti_hype_summary}</p>
                              </div>

                              <div className="flex flex-col gap-4">
                                <div className="flex items-center gap-4 bg-muted/30 border border-border/50 p-4 rounded-2xl">
                                  <div className="flex-shrink-0 bg-card border border-border w-16 h-16 rounded-2xl shadow-md flex items-center justify-center">
                                    <span className={cn(
                                      "text-2xl font-display font-bold",
                                      job.result.pipeline.reproducibility_score >= 80 ? "text-emerald-500" :
                                        job.result.pipeline.reproducibility_score >= 50 ? "text-yellow-500" : "text-red-500"
                                    )}>
                                      {job.result.pipeline.reproducibility_score}%
                                    </span>
                                  </div>
                                  <div>
                                    <h4 className="text-xs font-mono font-semibold text-muted-foreground uppercase tracking-wider mb-1 flex items-center gap-2">
                                      <Activity size={14} /> Reproducibility
                                    </h4>
                                    <p className="text-xs text-muted-foreground/70 leading-snug">Estimated likelihood of replicating these results with the provided pipeline details.</p>
                                  </div>
                                </div>

                                <div className="bg-muted/30 border border-border/50 p-4 rounded-2xl">
                                  <h4 className="text-xs font-mono font-semibold text-muted-foreground uppercase tracking-wider mb-2 flex items-center gap-2">
                                    <Cpu size={14} /> Hardware Reality
                                  </h4>
                                  <p className="text-sm text-foreground leading-relaxed">{(job.result.pipeline.hardware_reality || '').replace(/\$\$/g, '$')}</p>
                                </div>
                              </div>

                              <div>
                                <h4 className="text-xs font-mono font-semibold text-red-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                                  <SearchX size={14} /> Missing Secrets
                                </h4>
                                <ul className="space-y-2">
                                  {job.result.pipeline.missing_secrets?.map((secret: string, i: number) => (
                                    <li key={i} className="text-sm text-muted-foreground leading-relaxed flex items-start gap-3 bg-red-500/5 p-3 rounded-2xl border border-red-500/10">
                                      <span className="text-red-500 font-mono text-xs mt-0.5 opacity-50">{String(i + 1).padStart(2, '0')}</span>
                                      {secret}
                                    </li>
                                  ))}
                                </ul>
                              </div>
                            </motion.div>
                          )}

                          {activeTab === 'pipeline' && (
                            <motion.div key="tab-pipeline" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="space-y-6">
                              {Object.entries(job.result.pipeline).map(([key, value]) => {
                                if (['assumptions', 'reproducibility_score', 'missing_secrets', 'hardware_reality', 'anti_hype_summary', 'architecture_mermaid', 'prerequisite_papers', 'core_concept'].includes(key)) return null;
                                return (
                                  <div key={key} className="group">
                                    <h4 className="text-xs font-mono font-semibold text-primary uppercase tracking-wider mb-2 flex items-center gap-2">
                                      <div className="w-1.5 h-1.5 rounded-2xl bg-primary/50 group-hover:bg-primary transition-colors" />
                                      {key.replace('_', ' ')}
                                    </h4>
                                    <p className="text-sm text-muted-foreground leading-relaxed pl-3.5 border-l border-border group-hover:border-primary/30 transition-colors">{String(value)}</p>
                                  </div>
                                );
                              })}
                            </motion.div>
                          )}
                          {activeTab === 'assumptions' && (
                            <motion.ul key="tab-assumptions" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="space-y-3">
                              {job.result.pipeline.assumptions?.map((assumption: string, i: number) => (
                                <li key={i} className="text-sm text-muted-foreground leading-relaxed flex items-start gap-3 bg-muted/30 p-3 rounded-2xl border border-border/50">
                                  <span className="text-primary font-mono text-xs mt-0.5 opacity-50">{String(i + 1).padStart(2, '0')}</span>
                                  {assumption}
                                </li>
                              ))}
                            </motion.ul>
                          )}

                          {activeTab === 'architecture' && (
                            <motion.div key="tab-architecture" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="space-y-4">
                              <div className="flex items-center justify-between mb-2">
                                <h4 className="text-xs font-mono font-semibold text-primary uppercase tracking-wider flex items-center gap-2">
                                  <Network size={14} /> Architecture Graph
                                </h4>
                                {job.result.pipeline.architecture_mermaid && (
                                  <button onClick={() => setIsDiagramModalOpen(true)} className="flex items-center gap-1.5 text-xs font-medium bg-primary/10 text-primary hover:bg-primary hover:text-primary-foreground px-3 py-1.5 rounded-xl transition-all shadow-sm cursor-pointer group">
                                    <Maximize2 size={12} className="group-hover:scale-110 transition-transform" /> View Diagram
                                  </button>
                                )}
                              </div>
                              {job.result.pipeline.architecture_mermaid ? (
                                <MermaidChart chart={job.result.pipeline.architecture_mermaid} />
                              ) : (
                                <p className="text-sm text-muted-foreground">No architecture graph extracted.</p>
                              )}
                            </motion.div>
                          )}

                          {activeTab === 'related' && (
                            <motion.div key="tab-related" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }} className="space-y-8">
                              <div>
                                <h4 className="text-xs font-mono font-semibold text-emerald-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                                  <BookOpen size={14} /> Foundational Prerequisites
                                </h4>
                                <p className="text-xs text-muted-foreground mb-3 leading-relaxed">The LLM explicitly believes you MUST read these foundational papers before grasping this implementation.</p>
                                <ul className="space-y-2">
                                  {job.result.pipeline.prerequisite_papers?.map((paper: string, i: number) => (
                                    <li key={i} className="text-sm text-foreground leading-relaxed flex items-start gap-3 bg-emerald-500/5 p-3 rounded-2xl border border-emerald-500/20 shadow-md">
                                      <span className="text-emerald-500 font-mono text-xs mt-0.5 opacity-60">{String(i + 1).padStart(2, '0')}</span>
                                      {paper}
                                    </li>
                                  ))}
                                </ul>
                              </div>

                              {job.result.similarPapers && job.result.similarPapers.length > 0 && (
                                <div>
                                  <h4 className="text-xs font-mono font-semibold text-blue-500 uppercase tracking-wider mb-3 flex items-center gap-2">
                                    <Network size={14} /> Similar Works (OpenAlex)
                                  </h4>
                                  <p className="text-xs text-muted-foreground mb-3 leading-relaxed">
                                    Semantic match found for core concept: <span className="font-semibold text-foreground">"{job.result.pipeline.core_concept}"</span>
                                  </p>
                                  <div className="space-y-3">
                                    {job.result.similarPapers.map((paper: any, i: number) => (
                                      <div key={i} className="bg-muted/30 p-4 rounded-2xl border border-border/50 flex flex-col gap-2 shadow-md transition-all hover:border-blue-500/30">
                                        <div className="flex justify-between gap-4">
                                          <h5 className="font-semibold text-sm leading-snug">{paper.title}</h5>
                                          <span className="text-xs font-mono bg-background px-2 py-1 rounded-2xl text-muted-foreground border border-border h-fit">{paper.year}</span>
                                        </div>
                                        <p className="text-xs text-muted-foreground leading-relaxed line-clamp-3">{paper.abstract}</p>
                                        {paper.url && (
                                          <a href={paper.url} target="_blank" rel="noopener noreferrer" className="text-xs font-medium text-blue-500 hover:text-blue-400 mt-1 flex gap-1 items-center w-fit">
                                            View Paper <ExternalLink size={12} />
                                          </a>
                                        )}
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}
                            </motion.div>
                          )}
                        </AnimatePresence>
                      </div>
                    </div>
                    )}
                  </div>

                  {/* Main Content - Code Viewer */}
                  {resultPane === 'code' && (
                  <div className="xl:col-span-12 bg-card rounded-2xl border border-border overflow-hidden shadow-md flex flex-col h-full min-h-[520px]">
                    <div className="flex bg-muted/50 border-b border-border overflow-x-auto no-scrollbar p-2 gap-1 flex-shrink-0">
                      {orderedResultFiles.map((filename) => (
                        <button
                          key={filename}
                          onClick={() => setActiveFile(filename)}
                          className={cn(
                            "px-4 py-2 text-sm font-mono whitespace-nowrap rounded-2xl transition-all flex items-center gap-2",
                            activeFile === filename
                              ? "bg-background text-foreground border border-border shadow-sm"
                              : "text-muted-foreground hover:text-foreground hover:bg-muted border border-transparent"
                          )}
                        >
                          {filename.endsWith('.py') && <Code size={16} className="text-blue-500" />}
                          {filename.endsWith('.yaml') && <Settings size={16} className="text-purple-500" />}
                          {filename.endsWith('.md') && <FileText size={16} className="text-yellow-500" />}
                          {filename === 'Dockerfile' && <Package size={16} className="text-cyan-500" />}
                          {filename === 'requirements.txt' && <FileJson size={16} className="text-emerald-500" />}
                          {filename}
                        </button>
                      ))}
                    </div>
                    <div className="flex-1 overflow-auto p-6 custom-scrollbar bg-card">
                      <pre className="text-[13px] font-mono text-card-foreground leading-relaxed">
                        <code>{job.result.files[activeFile] || ''}</code>
                      </pre>
                    </div>
                  </div>
                  )}
                </>
              )}
            </motion.div>
          )}

        </AnimatePresence>
      </motion.main>

      {/* Architecture Diagram Modal */}
      <AnimatePresence>
        {isDiagramModalOpen && job && job.result?.pipeline?.architecture_mermaid && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[100] bg-background/80 backdrop-blur-sm flex items-center justify-center p-6"
            onClick={() => setIsDiagramModalOpen(false)}
          >
            <motion.div
              initial={{ scale: 0.95, y: 10, opacity: 0 }}
              animate={{ scale: 1, y: 0, opacity: 1 }}
              exit={{ scale: 0.95, y: 10, opacity: 0 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
              className="bg-card w-full max-w-5xl h-[85vh] rounded-3xl border border-border shadow-2xl flex flex-col overflow-hidden relative"
            >
              <div className="flex items-center justify-between border-b border-border p-4 bg-muted/30">
                <h3 className="font-display font-bold text-lg flex items-center gap-2"><Network size={20} className="text-primary" /> Architecture Diagram</h3>
                <button onClick={() => setIsDiagramModalOpen(false)} className="p-2 hover:bg-muted rounded-full transition-colors cursor-pointer text-muted-foreground hover:text-foreground">
                  <X size={20} />
                </button>
              </div>
              <div className="flex-1 overflow-auto p-6 bg-background custom-scrollbar">
                <MermaidChart chart={job.result.pipeline.architecture_mermaid} />
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div >
  );
}

function StepIndicator({ current, step, icon }: { current: string, step: string, icon: React.ReactNode }) {
  const isDone = getStepIndex(current) > getStepIndex(step);
  const isActive = current.includes(step.split('...')[0]);

  return (
    <div className="relative flex items-center justify-between md:justify-normal md:odd:flex-row-reverse group">
      {/* Icon */}
      <div className={cn(
        "flex items-center justify-center w-14 h-14 rounded-2xl border-4 border-background shrink-0 md:order-1 md:group-odd:-translate-x-1/2 md:group-even:translate-x-1/2 shadow-md transition-all duration-500 z-10",
        isDone ? "bg-emerald-500 text-white" : isActive ? "bg-primary text-primary-foreground scale-110 shadow-md/30" : "bg-muted text-muted-foreground"
      )}>
        {isDone ? <CheckCircle size={24} /> : icon}
      </div>

      {/* Card */}
      <div className={cn(
        "w-[calc(100%-4rem)] md:w-[calc(50%-2.5rem)] p-4 rounded-2xl border shadow-md transition-all duration-500",
        isActive ? "bg-background border-primary shadow-md shadow-md/5" : "bg-card/50 border-border opacity-60"
      )}>
        <div className="flex items-center justify-between mb-1">
          <div className={cn("font-display font-bold text-sm", isActive ? "text-primary" : "text-muted-foreground")}>
            {step.split(':')[0]}
          </div>
          {isActive && <div className="text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-2xl animate-pulse">Processing</div>}
          {isDone && <div className="text-xs font-medium text-emerald-500 bg-emerald-500/10 px-2 py-0.5 rounded-2xl">Done</div>}
        </div>
        <div className={cn("text-sm", isActive ? "text-foreground" : "text-muted-foreground")}>
          {step.split(':')[1]?.trim() || step}
        </div>
      </div>
    </div>
  );
}

function getStepIndex(step: string) {
  if (step.includes('Step 1')) return 1;
  if (step.includes('Step 2')) return 2;
  if (step.includes('Step 3')) return 3;
  if (step.includes('Step 4')) return 4;
  if (step.includes('Step 5')) return 5;
  if (step.includes('Packaging')) return 6;
  if (step.includes('Done')) return 7;
  return 0;
}
