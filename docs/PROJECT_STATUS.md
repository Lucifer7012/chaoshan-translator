# 潮汕话翻译器项目状态

## 当前目标

给朋友长期使用的潮汕话翻译网页：

- 支持文字翻译。
- 支持录音或上传音频后识别并翻译。
- 有访问密码，避免公开链接被随便消耗 API 额度。
- 部署在 Render，用户电脑不需要一直开机。

## 当前功能

- 文字翻译：
  - 潮汕话文字翻译成普通话。
  - 普通话翻译成潮汕话近似表达。
  - 输出原文/转写、翻译、读音、置信度、备注。

- 语音翻译：
  - 浏览器录音。
  - 上传音频文件。
  - 使用百炼 Fun-ASR 做语音识别。
  - 使用文字模型做 ASR 后处理、普通话释义和潮汕话近似写法。

- 安全与访问控制：
  - `APP_PASSWORD` 控制访问密码。
  - 前端输入密码后保存到浏览器本地。
  - 后端校验每个翻译和语音请求。

- 部署：
  - Render Web Service。
  - GitHub 仓库：`Lucifer7012/chaoshan-translator`。
  - 线上地址：`https://chaoshan-translator.onrender.com`。

## 当前线上环境变量

Render 里应配置以下变量。不要把真实值写进 GitHub。

```env
OPENAI_API_KEY=文字模型供应商 key
OPENAI_BASE_URL=http://43.166.202.16:3000/v1
OPENAI_MODEL=gpt-5.5
APP_PASSWORD=访问密码

TRANSCRIBE_PROVIDER=dashscope-fun-asr
DASHSCOPE_API_KEY=百炼 API Key
DASHSCOPE_BASE_URL=https://dashscope.aliyuncs.com/api/v1
DASHSCOPE_ASR_MODEL=fun-asr
DASHSCOPE_ASR_TIMEOUT_MS=90000
APP_PUBLIC_URL=https://chaoshan-translator.onrender.com

LOCAL_WHISPER_ENABLED=false
```

## 重要实现说明

- Fun-ASR 需要公网可访问音频 URL，不能直接识别本地 `localhost` 文件。
- 线上服务会把上传音频临时复制到 `uploads/asr-public`，生成随机 URL，提交给百炼后删除。
- 本地不用安装 Whisper、Python 或 ffmpeg，除非以后重新启用本地 Whisper。
- 语音后处理会做常见 ASR 纠错：
  - “喂，陆浩……”按语境纠正为“喂，你好……”
  - `wa` 优先理解为“我”，`wang` 才是“我们”

## 已知限制

- 潮汕话各地读音差异很大，Fun-ASR 不一定能稳定识别所有口音。
- Render 免费服务会休眠，首次打开可能较慢。
- 语音识别和文字翻译都可能消耗第三方额度。
- 访问密码不是完整账号系统，只适合小范围朋友使用。

## 后续优化候选

- 收集真实误识别样本，继续扩充语音后处理规则。
- 增加“识别原文 / 纠错后普通话 / 潮汕话写法”三栏显示，方便定位是 ASR 错还是翻译错。
- 增加简单使用次数统计，观察 API 消耗。
- 如果使用人数变多，改成更正式的登录或邀请码。

