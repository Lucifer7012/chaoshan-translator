import 'dotenv/config';

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
const speechMode = getSpeechMode();

function normalizeApiBaseUrl(value) {
  if (!value) return '';

  return value.trim().replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
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
    transcribeModel: remoteTranscribeModel || null,
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
    const transcription = await transcribeAudio(uploadedPath, req.file);
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

async function transcribeAudio(filePath, file) {
  if (localWhisperEnabled) {
    return transcribeWithLocalWhisper(filePath, file);
  }

  return transcribeWithOpenAIAudio(filePath);
}

async function transcribeWithOpenAIAudio(filePath) {
  const response = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: remoteTranscribeModel,
    language: 'zh',
    prompt:
      '这是一段潮汕话、潮州话、汕头话、揭阳话或潮阳话语音。请尽量保留方言词，输出中文转写。'
  });

  return response.text?.trim() || '';
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
  const translated = await translateText({
    text: transcription,
    direction: 'mandarin-to-chaoshan',
    variant
  });
  const notes = [
    `普通话释义：${transcription}`,
    '这条“语义转写（普通话）”是本地 Whisper 对潮汕话语音的意思还原，不一定保留原样写法。',
    translated.notes ? String(translated.notes) : ''
  ]
    .filter(Boolean)
    .join('\n');

  return {
    detectedLanguage: '潮汕话语音',
    sourceText: transcription,
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
