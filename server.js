import 'dotenv/config';

import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import express from 'express';
import multer from 'multer';
import OpenAI from 'openai';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const execFileAsync = promisify(execFile);

const app = express();
app.set('trust proxy', true);

const asrPublicDir = path.join(__dirname, 'uploads', 'asr-public');
const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: {
    fileSize: 25 * 1024 * 1024
  }
});

const port = Number(process.env.PORT || 5173);
const accessPassword = process.env.APP_PASSWORD || process.env.ACCESS_PASSWORD || '';
const defaultApiBaseUrl = 'https://api.openai.com/v1';
const apiKey = process.env.OPENAI_API_KEY || process.env.AI_API_KEY;
const apiBaseUrl = normalizeApiBaseUrl(process.env.OPENAI_BASE_URL || process.env.AI_API_BASE_URL);
const serviceBaseUrl = apiBaseUrl || defaultApiBaseUrl;
const usesDefaultOpenAIBaseUrl = serviceBaseUrl === defaultApiBaseUrl;
const openai = apiKey
  ? new OpenAI({
      apiKey,
      ...(apiBaseUrl ? { baseURL: apiBaseUrl } : {})
    })
  : null;

const textModel =
  process.env.OPENAI_MODEL ||
  process.env.AI_MODEL ||
  process.env.OPENAI_TEXT_MODEL ||
  process.env.AI_TEXT_MODEL ||
  'gpt-5.5';
const remoteTranscribeModel =
  process.env.OPENAI_TRANSCRIBE_MODEL ||
  process.env.AI_TRANSCRIBE_MODEL ||
  (usesDefaultOpenAIBaseUrl ? 'gpt-4o-transcribe' : '');
const transcribeProvider = (process.env.TRANSCRIBE_PROVIDER || '').trim().toLowerCase();
const dashscopeApiKey = process.env.DASHSCOPE_API_KEY || process.env.TRANSCRIBE_API_KEY || '';
const dashscopeBaseUrl = normalizeBaseUrl(
  process.env.DASHSCOPE_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1'
);
const dashscopeAsrModel = process.env.DASHSCOPE_ASR_MODEL || process.env.TRANSCRIBE_MODEL || 'fun-asr';
const localWhisperEnabled = readBoolean(process.env.LOCAL_WHISPER_ENABLED, false);
const localWhisperEngine = (process.env.LOCAL_WHISPER_ENGINE || 'transformers').trim().toLowerCase();
const localWhisperCommand = process.env.LOCAL_WHISPER_COMMAND || 'whisper';
const localWhisperPython = process.env.LOCAL_WHISPER_PYTHON || 'python';
const localWhisperModel = process.env.LOCAL_WHISPER_MODEL || 'small';
const localWhisperProcessor = process.env.LOCAL_WHISPER_PROCESSOR || '';
const localWhisperLanguage = process.env.LOCAL_WHISPER_LANGUAGE || 'zh';
const localWhisperFp16 = process.env.LOCAL_WHISPER_FP16 || 'False';
const localWhisperFfmpegDir = process.env.LOCAL_WHISPER_FFMPEG_DIR || '';
const localWhisperTimeoutMs = readPositiveInteger(
  process.env.LOCAL_WHISPER_TIMEOUT_MS,
  5 * 60 * 1000
);
const remoteTranscribeTimeoutMs = readPositiveInteger(
  process.env.OPENAI_TRANSCRIBE_TIMEOUT_MS || process.env.AI_TRANSCRIBE_TIMEOUT_MS,
  45 * 1000
);
const dashscopeAsrTimeoutMs = readPositiveInteger(
  process.env.DASHSCOPE_ASR_TIMEOUT_MS || process.env.TRANSCRIBE_TIMEOUT_MS,
  90 * 1000
);
const speechMode = getSpeechMode();

function normalizeBaseUrl(value) {
  if (!value) return '';

  return value.trim().replace(/\/+$/, '');
}

function normalizeApiBaseUrl(value) {
  return normalizeBaseUrl(value).replace(/\/chat\/completions$/, '');
}

function parseJsonObject(content) {
  const text = String(content || '').trim();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {}

  const fencedMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const candidate = fencedMatch?.[1] || text;
  const objectMatch = candidate.match(/\{[\s\S]*\}/);

  if (objectMatch) {
    return JSON.parse(objectMatch[0]);
  }

  throw new Error(`文本模型没有返回合法 JSON：${text.slice(0, 300)}`);
}

function readBoolean(value, defaultValue) {
  if (value === undefined || value === null || value === '') return defaultValue;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function readPositiveInteger(value, defaultValue) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : defaultValue;
}

function getSpeechMode() {
  if (localWhisperEnabled) return `local-whisper-${localWhisperEngine}`;
  if (transcribeProvider === 'dashscope-fun-asr' && dashscopeApiKey) return 'dashscope-fun-asr';
  if (openai && remoteTranscribeModel) return 'openai-audio';
  return 'disabled';
}

function getWhisperChildEnv() {
  const env = {
    ...process.env,
    PYTHONIOENCODING: 'utf-8'
  };

  if (localWhisperFfmpegDir) {
    env.PATH = `${localWhisperFfmpegDir}${path.delimiter}${env.PATH || ''}`;
  }

  return env;
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/asr-audio/:filename', async (req, res) => {
  const filename = path.basename(req.params.filename || '');

  if (!/^[a-f0-9-]+\.[a-z0-9]+$/i.test(filename)) {
    return res.status(404).end();
  }

  const filePath = path.join(asrPublicDir, filename);
  if (!filePath.startsWith(asrPublicDir)) {
    return res.status(404).end();
  }

  res.type(getMimeType(path.extname(filename)));
  res.sendFile(filePath, (error) => {
    if (error && !res.headersSent) res.status(404).end();
  });
});

function requireAccess(req, res, next) {
  if (!accessPassword) {
    next();
    return;
  }

  const providedPassword = req.get('x-app-password') || '';
  if (providedPassword === accessPassword) {
    next();
    return;
  }

  res.status(401).json({ error: '访问密码不正确。' });
}

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    authRequired: Boolean(accessPassword),
    openaiConfigured: Boolean(openai),
    apiBaseUrl: serviceBaseUrl,
    textModel,
    speechMode,
    speechConfigured: speechMode !== 'disabled',
    transcribeProvider: speechMode,
    transcribeModel: getActiveTranscribeModel(),
    transcribeTimeoutMs:
      speechMode === 'dashscope-fun-asr'
        ? dashscopeAsrTimeoutMs
        : speechMode === 'openai-audio'
          ? remoteTranscribeTimeoutMs
          : null,
    localWhisper: localWhisperEnabled
      ? {
          engine: localWhisperEngine,
          command: localWhisperCommand,
          python: localWhisperPython,
          model: localWhisperModel,
          processor: localWhisperProcessor || null,
          language: localWhisperLanguage
        }
      : null
  });
});

app.post('/api/translate', requireAccess, async (req, res) => {
  try {
    const { text, direction = 'chaoshan-to-mandarin', variant = 'auto' } = req.body || {};

    if (!text || !text.trim()) {
      return res.status(400).json({ error: '请先输入要翻译的潮汕话或普通话。' });
    }

    const result = openai
      ? await translateText({ text: text.trim(), direction, variant })
      : demoTranslate(text.trim(), direction);

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: '翻译失败，请稍后再试。',
      detail: error.message
    });
  }
});

app.post('/api/transcribe-translate', requireAccess, upload.single('audio'), async (req, res) => {
  let uploadedPath;

  try {
    if (!req.file) {
      return res.status(400).json({ error: '请先录音或上传音频文件。' });
    }

    uploadedPath = req.file.path;

    if (!openai) {
      return res.status(400).json({
        error: '语音翻译需要先配置文字翻译 API Key；本地 Whisper 只负责语音转文字。',
        hint: '请配置 OPENAI_API_KEY 或 AI_API_KEY 后重启服务。'
      });
    }

    if (speechMode === 'disabled') {
      return res.status(400).json({
        error: '当前只配置了文字翻译模型，语音翻译还需要本地 Whisper 或远程语音识别模型。',
        hint: '推荐设置 LOCAL_WHISPER_ENABLED=true，并在本机安装 openai-whisper 与 ffmpeg。'
      });
    }

    const variant = req.body?.variant || 'auto';
    const transcription = await transcribeAudio(uploadedPath, req.file, req);
    const speechResult = await interpretSpeechResult({
      transcription,
      variant
    });

    res.json(speechResult);
  } catch (error) {
    console.error(error);
    res.status(500).json({
      error: '语音识别或翻译失败，请换一段更清晰的录音再试。',
      detail: error.message
    });
  } finally {
    if (uploadedPath) {
      fs.promises.unlink(uploadedPath).catch(() => {});
    }
  }
});

async function transcribeAudio(filePath, file, req) {
  if (localWhisperEnabled) {
    return transcribeWithLocalWhisper(filePath, file);
  }

  if (speechMode === 'dashscope-fun-asr') {
    return transcribeWithDashScopeFunAsr(filePath, file, getPublicBaseUrl(req));
  }

  return transcribeWithOpenAIAudio(filePath);
}

function getActiveTranscribeModel() {
  if (speechMode === 'dashscope-fun-asr') return dashscopeAsrModel;
  return remoteTranscribeModel || null;
}

function getPublicBaseUrl(req) {
  const configuredUrl = process.env.APP_PUBLIC_URL || process.env.PUBLIC_BASE_URL;
  if (configuredUrl) return normalizeBaseUrl(configuredUrl);
  return `${req.protocol}://${req.get('host')}`;
}

async function transcribeWithDashScopeFunAsr(filePath, file, publicBaseUrl) {
  if (!dashscopeApiKey) {
    throw new Error('请先配置 DASHSCOPE_API_KEY 或 TRANSCRIBE_API_KEY。');
  }

  const publicAudio = await createPublicAudioFile(filePath, file);

  try {
    const fileUrl = `${publicBaseUrl}/api/asr-audio/${publicAudio.filename}`;
    const taskId = await submitDashScopeAsrTask(fileUrl);
    const resultUrl = await waitForDashScopeAsrResult(taskId);
    const result = await fetchJson(resultUrl);
    const text = extractDashScopeText(result);

    if (!text) {
      throw new Error('Fun-ASR 没有返回可用的识别文本，请换一段更清晰的录音再试。');
    }

    return text;
  } finally {
    fs.promises.unlink(publicAudio.path).catch(() => {});
  }
}

async function createPublicAudioFile(filePath, file) {
  await fs.promises.mkdir(asrPublicDir, { recursive: true });
  const extension = getAudioExtension(file);
  const filename = `${crypto.randomUUID()}${extension}`;
  const publicPath = path.join(asrPublicDir, filename);
  await fs.promises.copyFile(filePath, publicPath);
  return { filename, path: publicPath };
}

async function submitDashScopeAsrTask(fileUrl) {
  const payload = {
    model: dashscopeAsrModel,
    input: {
      file_urls: [fileUrl]
    },
    parameters: {
      channel_id: [0]
    }
  };
  const data = await dashscopePostJson('/services/audio/asr/transcription', payload, {
    'X-DashScope-Async': 'enable'
  });
  const taskId = data?.output?.task_id;

  if (!taskId) {
    throw new Error(`Fun-ASR 任务提交失败：${JSON.stringify(data).slice(0, 500)}`);
  }

  return taskId;
}

async function waitForDashScopeAsrResult(taskId) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < dashscopeAsrTimeoutMs) {
    const data = await dashscopeGetJson(`/tasks/${encodeURIComponent(taskId)}`);
    const output = data?.output || data;
    const status = output?.task_status;

    if (status === 'SUCCEEDED') {
      const result = output.results?.find((item) => item.subtask_status === 'SUCCEEDED');
      if (result?.transcription_url) return result.transcription_url;

      const failed = output.results?.find((item) => item.subtask_status === 'FAILED');
      throw new Error(failed?.message || 'Fun-ASR 任务完成，但没有返回 transcription_url。');
    }

    if (status === 'FAILED') {
      const detail = output?.message || output?.results?.[0]?.message || JSON.stringify(data).slice(0, 500);
      throw new Error(`Fun-ASR 识别失败：${detail}`);
    }

    await delay(1000);
  }

  throw new Error(`Fun-ASR 识别超过 ${Math.round(dashscopeAsrTimeoutMs / 1000)} 秒没有返回。`);
}

async function dashscopePostJson(pathname, payload = null, extraHeaders = {}) {
  const response = await fetch(`${dashscopeBaseUrl}${pathname}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${dashscopeApiKey}`,
      'Content-Type': 'application/json',
      ...extraHeaders
    },
    ...(payload ? { body: JSON.stringify(payload) } : {})
  });
  const text = await response.text();
  const data = text ? parseJsonObject(text) : {};

  if (!response.ok) {
    throw new Error(`Fun-ASR 接口错误 ${response.status}：${data.message || data.code || text}`);
  }

  return data;
}

async function dashscopeGetJson(pathname) {
  const response = await fetch(`${dashscopeBaseUrl}${pathname}`, {
    headers: {
      Authorization: `Bearer ${dashscopeApiKey}`
    }
  });
  const text = await response.text();
  const data = text ? parseJsonObject(text) : {};

  if (!response.ok) {
    throw new Error(`Fun-ASR 接口错误 ${response.status}：${data.message || data.code || text}`);
  }

  return data;
}

async function fetchJson(url) {
  const response = await fetch(url);
  const text = await response.text();

  if (!response.ok) {
    throw new Error(`下载 Fun-ASR 结果失败 ${response.status}：${text.slice(0, 300)}`);
  }

  return parseJsonObject(text);
}

function extractDashScopeText(result) {
  const texts = [];

  for (const transcript of result?.transcripts || []) {
    if (transcript.text) texts.push(transcript.text);
    for (const sentence of transcript.sentences || []) {
      if (!transcript.text && sentence.text) texts.push(sentence.text);
    }
  }

  return texts.join('\n').trim();
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function transcribeWithOpenAIAudio(filePath) {
  const controller = new AbortController();

  try {
    const response = await withTimeout(
      openai.audio.transcriptions.create(
        {
          file: fs.createReadStream(filePath),
          model: remoteTranscribeModel,
          language: 'zh',
          prompt:
            '这是一段潮汕话、潮州话、汕头话、揭阳话或潮阳话语音。请尽量保留方言词，输出中文转写。'
        },
        {
          signal: controller.signal,
          timeout: remoteTranscribeTimeoutMs
        }
      ),
      remoteTranscribeTimeoutMs,
      () => controller.abort()
    );

    return response.text?.trim() || '';
  } catch (error) {
    const message = String(error?.message || error || '');

    if (/timeout|timed out|aborted/i.test(message)) {
      throw new Error(
        `远程语音识别超过 ${Math.round(remoteTranscribeTimeoutMs / 1000)} 秒没有返回。请确认当前供应商支持 /v1/audio/transcriptions，或换用支持语音识别的 OpenAI 兼容服务。`
      );
    }

    if (/404|not found|unsupported|unknown|audio|transcription|transcribe/i.test(message)) {
      throw new Error(
        `当前供应商可能不支持 OpenAI 语音识别接口 /v1/audio/transcriptions。原始错误：${message}`
      );
    }

    throw error;
  }
}

function withTimeout(promise, timeoutMs, onTimeout) {
  let timeoutId;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      if (onTimeout) onTimeout();
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeoutId));
}

async function transcribeWithLocalWhisper(filePath, file) {
  if (localWhisperEngine === 'transformers') {
    return transcribeWithTransformersWhisper(filePath, file);
  }

  if (localWhisperEngine !== 'openai-cli') {
    throw new Error('LOCAL_WHISPER_ENGINE 只支持 transformers 或 openai-cli。');
  }

  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chaoshan-whisper-'));
  const audioPath = path.join(workDir, `audio${getAudioExtension(file)}`);

  try {
    await fs.promises.copyFile(filePath, audioPath);
    const args = [
      audioPath,
      '--model',
      localWhisperModel,
      '--language',
      localWhisperLanguage,
      '--task',
      'transcribe',
      '--output_format',
      'txt',
      '--output_dir',
      workDir,
      '--fp16',
      localWhisperFp16
    ];

    await execFileAsync(localWhisperCommand, args, {
      timeout: localWhisperTimeoutMs,
      maxBuffer: 20 * 1024 * 1024
    });

    const text = await readWhisperTranscript(workDir);
    if (!text) {
      throw new Error('Whisper 没有返回识别文本。');
    }

    return text;
  } catch (error) {
    throw new Error(formatWhisperError(error));
  } finally {
    fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function transcribeWithTransformersWhisper(filePath, file) {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'chaoshan-whisper-'));
  const audioPath = path.join(workDir, `audio${getAudioExtension(file)}`);
  const scriptPath = path.join(__dirname, 'scripts', 'transcribe_with_transformers.py');

  try {
    await fs.promises.copyFile(filePath, audioPath);
    const { stdout } = await execFileAsync(
      localWhisperPython,
      [
        scriptPath,
        audioPath,
        '--model',
        localWhisperModel,
        ...(localWhisperProcessor ? ['--processor', localWhisperProcessor] : []),
        '--language',
        localWhisperLanguage
      ],
      {
        timeout: localWhisperTimeoutMs,
        maxBuffer: 20 * 1024 * 1024,
        env: getWhisperChildEnv()
      }
    );

    const text = stdout.trim();
    if (!text) {
      throw new Error('Whisper 没有返回识别文本。');
    }

    return text;
  } catch (error) {
    throw new Error(formatWhisperError(error));
  } finally {
    fs.promises.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

function getAudioExtension(file) {
  const originalExtension = path.extname(file?.originalname || '').toLowerCase();
  if (/^\.[a-z0-9]{1,8}$/.test(originalExtension)) return originalExtension;

  const mimeToExtension = new Map([
    ['audio/mpeg', '.mp3'],
    ['audio/mp3', '.mp3'],
    ['audio/mp4', '.m4a'],
    ['audio/wav', '.wav'],
    ['audio/x-wav', '.wav'],
    ['audio/webm', '.webm'],
    ['audio/ogg', '.ogg']
  ]);

  return mimeToExtension.get(file?.mimetype) || '.webm';
}

function getMimeType(extension) {
  const extensionToMime = new Map([
    ['.mp3', 'audio/mpeg'],
    ['.m4a', 'audio/mp4'],
    ['.mp4', 'audio/mp4'],
    ['.wav', 'audio/wav'],
    ['.webm', 'audio/webm'],
    ['.ogg', 'audio/ogg']
  ]);

  return extensionToMime.get(String(extension || '').toLowerCase()) || 'application/octet-stream';
}

async function readWhisperTranscript(workDir) {
  const primaryPath = path.join(workDir, 'audio.txt');

  try {
    return (await fs.promises.readFile(primaryPath, 'utf8')).trim();
  } catch {
    const entries = await fs.promises.readdir(workDir);
    const transcriptName = entries.find((entry) => entry.toLowerCase().endsWith('.txt'));
    if (!transcriptName) return '';
    return (await fs.promises.readFile(path.join(workDir, transcriptName), 'utf8')).trim();
  }
}

function formatWhisperError(error) {
  if (error?.code === 'ENOENT') {
    if (localWhisperEngine === 'transformers') {
      return `未找到 Python 命令 "${localWhisperPython}"，请安装 Python，或把 LOCAL_WHISPER_PYTHON 指向可执行文件。`;
    }

    return `未找到本地 Whisper 命令 "${localWhisperCommand}"，请先安装 openai-whisper，或把 LOCAL_WHISPER_COMMAND 指向可执行文件。`;
  }

  if (error?.killed || error?.signal === 'SIGTERM') {
    return `本地 Whisper 识别超时，请换用更小模型或调大 LOCAL_WHISPER_TIMEOUT_MS。`;
  }

  const output = [error?.message, error?.stderr, error?.stdout]
    .filter(Boolean)
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join('\n');

  return `本地 Whisper 识别失败：${output || '未知错误'}`;
}

async function translateText({ text, direction, variant }) {
  const system = [
    '你是一个严谨的潮汕话翻译助手。',
    '潮汕话也可能被称为潮州话、潮语、Teochew、Chaoshan、汕头话、揭阳话、潮阳话。',
    '请根据语境翻译，不确定时要明确说明，不要编造。',
    '输出必须是严格 JSON/json，不要使用 Markdown。',
    '字段：detectedLanguage, sourceText, translatedText, pronunciation, notes, confidence。',
    'pronunciation 用来给出潮汕话常见读音、拼音式近似或空字符串。',
    'notes 用简短中文说明关键词、语气、歧义或更地道说法。',
    'confidence 是 0 到 1 的数字。'
  ].join('\n');

  const target =
    direction === 'mandarin-to-chaoshan'
      ? '把普通话翻译成自然的潮汕话表达。'
      : '把潮汕话文字翻译成自然、准确的普通话。';

  const user = [
    target,
    '请只返回一个合法 json 对象。',
    `方言区域偏好：${variant || 'auto'}`,
    `原文：${text}`
  ].join('\n');

  const response = await openai.chat.completions.create({
    model: textModel,
    temperature: 0.2,
    response_format: { type: 'json_object' },
    stream: true,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  });

  const content = await readStreamedChatContent(response);
  return normalizeResult(parseJsonObject(content), text);
}

async function readStreamedChatContent(stream) {
  let content = '';

  for await (const chunk of stream) {
    const delta = chunk.choices?.[0]?.delta?.content;
    if (delta) content += delta;
  }

  return content || '{}';
}

async function interpretSpeechResult({ transcription, variant }) {
  const translated = await interpretChaoshanSpeechText({
    transcription,
    variant
  });
  const notes = [
    translated.notes ? String(translated.notes) : '',
    `语音识别原文：${transcription}`,
    '语音识别原文可能包含同音误识别；上方结果会按上下文做谨慎纠错。'
  ]
    .filter(Boolean)
    .join('\n');

  return {
    detectedLanguage: translated.detectedLanguage || '潮汕话语音',
    sourceText: translated.sourceText || transcription,
    translatedText: translated.translatedText || transcription,
    pronunciation: translated.pronunciation || '',
    notes,
    confidence: clampConfidence(translated.confidence),
    resultLabels: {
      source: '语义转写（普通话）',
      translated: '潮汕话近似写法',
      pronunciation: '读音/拼音',
      confidence: '置信度',
      notes: '释义与说明'
    }
  };
}

async function interpretChaoshanSpeechText({ transcription, variant }) {
  const system = [
    '你是一个严谨的潮汕话语音后处理与翻译助手。',
    '输入来自 ASR 语音识别，可能把潮汕话、普通话或混合口语听错成同音字、人名或奇怪词。',
    '请先根据上下文谨慎纠错，再给出普通话语义转写和自然的潮汕话近似写法。',
    '常见纠错规则：在“喂/欸/诶”之后出现“陆浩、路好、李好、你好”等近音时，若上下文是问候，应优先理解为“你好/汝好”，不要当成人名；只有明确是在称呼某个人时才保留人名。',
    '不要编造音频里没有的实质信息；不确定时在 notes 说明。',
    '输出必须是严格 JSON/json，不要使用 Markdown。',
    '字段：detectedLanguage, sourceText, translatedText, pronunciation, notes, confidence。',
    'sourceText 必须写纠错后的自然普通话语义，不要写方言转写。',
    'translatedText 必须写潮汕话近似汉字表达。',
    '示例：ASR 原文“喂，陆浩。汝今晚啥时倒来？”应理解为 sourceText“喂，你好，你今晚什么时候回来？”，translatedText“喂，汝好，汝今暝底时转来？”。',
    'pronunciation 写潮汕话读音或拼音式近似。',
    'confidence 是 0 到 1 的数字。'
  ].join('\n');

  const user = [
    '请只返回一个合法 json 对象。',
    `方言区域偏好：${variant || 'auto'}`,
    `ASR 原文：${transcription}`
  ].join('\n');

  const response = await openai.chat.completions.create({
    model: textModel,
    temperature: 0.1,
    response_format: { type: 'json_object' },
    stream: true,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ]
  });

  const content = await readStreamedChatContent(response);
  return normalizeResult(parseJsonObject(content), transcription);
}

function normalizeResult(result, fallbackText) {
  return {
    detectedLanguage: String(result.detectedLanguage || '未知'),
    sourceText: String(result.sourceText || fallbackText || ''),
    translatedText: String(result.translatedText || ''),
    pronunciation: String(result.pronunciation || ''),
    notes: String(result.notes || ''),
    confidence: clampConfidence(result.confidence)
  };
}

function clampConfidence(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.max(0, Math.min(1, number));
}

function demoTranslate(text, direction) {
  const dictionary = new Map([
    ['食未', '吃了吗？'],
    ['汝好', '你好。'],
    ['胶己人', '自己人。'],
    ['爱来坐', '有空来坐坐。'],
    ['多谢', '谢谢。'],
    ['我唔知', '我不知道。'],
    ['去叨位', '去哪里？'],
    ['做乜个', '做什么？']
  ]);

  const translatedText =
    direction === 'mandarin-to-chaoshan'
      ? '示例模式暂不支持可靠的普通话转潮汕话，请配置 OPENAI_API_KEY 或 AI_API_KEY 使用完整翻译。'
      : dictionary.get(text) || '示例模式只能翻译少量常见短句；配置 OPENAI_API_KEY 或 AI_API_KEY 后可使用完整翻译。';

  return {
    detectedLanguage: direction === 'mandarin-to-chaoshan' ? '普通话' : '潮汕话',
    sourceText: text,
    translatedText,
    pronunciation: '',
    notes: openai
      ? ''
      : '当前未配置 API Key，因此只启用本地示例词库。',
    confidence: dictionary.has(text) ? 0.55 : 0.15
  };
}

app.listen(port, () => {
  console.log(`Chaoshan translator running at http://localhost:${port}`);
  console.log(`OpenAI configured: ${Boolean(openai)}`);
  console.log(`API base URL: ${serviceBaseUrl}`);
  console.log(`Text model: ${textModel}`);
  console.log(`Speech mode: ${speechMode}`);
  if (localWhisperEnabled) {
    console.log(`Local Whisper engine: ${localWhisperEngine}`);
    console.log(`Local Whisper model: ${localWhisperModel}`);
  } else {
    console.log(`Speech model: ${remoteTranscribeModel || 'not configured'}`);
  }
});
