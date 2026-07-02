# 潮汕话翻译器变更记录

本文件记录这个项目每次重要修复、功能调整和部署相关变更。不要在这里写 API Key、访问密码或其他密钥。

## 当前版本

- GitHub 仓库：`Lucifer7012/chaoshan-translator`
- 线上地址：`https://chaoshan-translator.onrender.com`
- 文字模型：通过 `OPENAI_BASE_URL` / `OPENAI_MODEL` 配置，当前推荐 `gpt-5.5`
- 语音识别：百炼 Fun-ASR，通过 `TRANSCRIBE_PROVIDER=dashscope-fun-asr` 启用

## 记录

### 2026-07-02 - 更新文字模型供应商地址

- 问题：文字模型 OpenAI 兼容接口地址需要切换到新的 Olink Data 地址。
- 修复：将本地配置示例和项目文档中的 `OPENAI_BASE_URL` 更新为 `https://apilink.olinkdata.com/v1`。
- 注意：线上 Render 环境变量也需要手动同步修改，代码仓库里的 `.env.example` 不会自动影响 Render。

### 2026-06-22 - 更新文字模型供应商地址

- 问题：需要把文字模型 OpenAI 兼容接口地址切换到新的供应商地址。
- 修复：将示例配置和项目状态文档中的 `OPENAI_BASE_URL` 更新为 `https://olapi.olinkdata.com/v1`。
- 注意：线上 Render 环境变量也需要手动同步修改，代码仓库里的 `.env.example` 不会自动影响 Render。

### 2026-05-20 - 改进 wa / wang 人称纠错

- 提交：`7497978 Improve wa wang speech correction`
- 问题：潮汕话里 `wa` 是“我”，`wang` 是“我们”；语音识别或后处理会把 `wa` 误当成“我们”。
- 修复：在语音后处理提示词中加入人称纠错规则。
- 示例：`wa 现在要去洗碗了` 应输出“我现在要去洗碗了”，不是“我们现在要去洗碗了”。

### 2026-05-20 - 改进“陆浩 / 你好”误识别纠错

- 提交：`609e634 Improve speech ASR correction`
- 问题：Fun-ASR 会把“喂，你好……”误识别成“喂，陆浩……”，后续模型把“陆浩”当成人名。
- 修复：新增语音专用后处理函数，先做 ASR 纠错，再输出普通话释义和潮汕话近似写法。
- 示例：`喂，陆浩。汝今晚啥时倒来？` 应理解为“喂，你好，你今晚什么时候回来？”

### 2026-05-20 - 接入百炼 Fun-ASR

- 提交：`e379958 Add DashScope Fun-ASR transcription`
- 问题：原供应商不支持 `gpt-4o-transcribe`，语音识别不可用。
- 修复：新增 DashScope / 百炼 Fun-ASR 适配层。
- 实现：Render 临时保存音频为公网随机 URL，提交给 Fun-ASR，轮询任务结果，识别后删除临时音频。
- 关键配置：
  - `TRANSCRIBE_PROVIDER=dashscope-fun-asr`
  - `DASHSCOPE_API_KEY`
  - `DASHSCOPE_ASR_MODEL=fun-asr`
  - `APP_PUBLIC_URL=https://chaoshan-translator.onrender.com`

### 2026-05-20 - 强制语音识别超时

- 提交：`b662e2f Enforce remote transcription timeout`
- 问题：不支持语音接口的供应商会让页面一直停在“处理中”。
- 修复：加入硬超时和 abort，超过配置时间后返回明确错误。

### 2026-05-20 - 增加远程语音识别超时提示

- 提交：`5d95589 Add transcription timeout handling`
- 问题：远程语音识别失败时错误不够清楚。
- 修复：健康接口暴露 `transcribeTimeoutMs`，错误信息提示是否支持 `/v1/audio/transcriptions`。

### 2026-05-20 - 初次部署版本

- 提交：`e0f8583 Deploy chaoshan translator`
- 内容：整理当前 Express 应用、前端页面、密码保护、Render 部署配置和模型默认配置。
