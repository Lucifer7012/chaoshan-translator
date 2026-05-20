# 潮汕话翻译器

一个本地网页小工具，支持：

- 潮汕话文字翻译成普通话
- 普通话翻译成潮汕话表达
- 录音或上传音频后识别并翻译
- 输出转写、翻译、读音提示、备注和置信度

## 使用

```bash
npm install
copy .env.example .env
npm start
```

把 `.env` 里的文字翻译 API 配好，然后打开：

```text
http://localhost:5173
```

推荐配置：

```env
OPENAI_API_KEY=你的 OpenAI API Key
OPENAI_BASE_URL=https://api.openai.com/v1
OPENAI_MODEL=gpt-5.5
OPENAI_TRANSCRIBE_MODEL=gpt-4o-transcribe
OPENAI_TRANSCRIBE_TIMEOUT_MS=45000
```

`OPENAI_BASE_URL` 可以填 OpenAI 兼容服务的 `/v1` 地址，也可以填完整的 `/v1/chat/completions`，服务启动时会自动归一化。

没有配置 API Key 时，文字翻译会进入示例模式，只支持少量常见短句；语音翻译还需要本地 Whisper 或远程语音识别模型。

## 本地 Whisper

录音或上传音频的流程是：本地 Whisper 先把音频转成文字，然后再交给 `OPENAI_MODEL` 做翻译。

默认使用 Hugging Face Transformers 加载潮州话 Whisper 模型。推荐先用 `panlr/whisper-finetune-teochew`，它更新较新、使用 safetensors，且没有明确的 10 秒音频限制：

```env
LOCAL_WHISPER_ENABLED=true
LOCAL_WHISPER_ENGINE=transformers
LOCAL_WHISPER_MODEL=panlr/whisper-finetune-teochew
LOCAL_WHISPER_LANGUAGE=zh
LOCAL_WHISPER_TIMEOUT_MS=300000
```

也可以把 `LOCAL_WHISPER_MODEL` 改成 `efficient-nlp/teochew-whisper-medium`。它同样是潮州话 Whisper medium 微调模型，但模型卡提示训练音频较短，超过 10 秒的录音可能效果下降：

```env
LOCAL_WHISPER_MODEL=efficient-nlp/teochew-whisper-medium
```

本地 Whisper 需要先安装 Python 依赖和 `ffmpeg`：

```bash
pip install -U torch transformers accelerate ffmpeg-python
```

如果只想用 OpenAI 官方 `whisper` 命令行模型，可以改成：

```env
LOCAL_WHISPER_ENGINE=openai-cli
LOCAL_WHISPER_COMMAND=whisper
LOCAL_WHISPER_MODEL=small
```

注意：OpenAI 官方 `whisper` 命令行通常使用 `small`、`medium`、`large-v3` 这类内置模型名；Hugging Face 上的 `efficient-nlp/teochew-whisper-medium`、`panlr/whisper-finetune-teochew` 推荐走 `LOCAL_WHISPER_ENGINE=transformers`。

## 说明

潮汕话不同地区读音和用词差异很大，语音识别也会受录音质量影响。短句、清晰录音、加上地区偏好，效果会更稳定。
