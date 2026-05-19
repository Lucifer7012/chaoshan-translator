const state = {
  mediaRecorder: null,
  recordedChunks: [],
  recordedBlob: null,
  timer: null,
  startedAt: 0,
  mode: 'text',
  authRequired: false,
  accessPassword: localStorage.getItem('chaoshanAccessPassword') || ''
};

const labels = {
  text: {
    source: '原文/转写',
    translated: '普通话/潮汕话',
    pronunciation: '读音',
    confidence: '置信度',
    notes: '备注',
    sourcePlaceholder: '等待输入',
    translatedPlaceholder: '翻译会显示在这里',
    notesPlaceholder: '可显示词义、语气和不确定处'
  },
  voice: {
    source: '语义转写（普通话）',
    translated: '潮汕话近似写法',
    pronunciation: '读音/拼音',
    confidence: '置信度',
    notes: '释义与说明',
    sourcePlaceholder: '等待录音',
    translatedPlaceholder: '识别后会尽量还原成潮汕话写法',
    notesPlaceholder: '可显示普通话释义、方言差异和不确定处'
  }
};

const els = {
  authScreen: document.querySelector('#auth-screen'),
  authForm: document.querySelector('#auth-form'),
  accessPassword: document.querySelector('#access-password'),
  authError: document.querySelector('#auth-error'),
  status: document.querySelector('#service-status'),
  textTab: document.querySelector('#text-tab'),
  voiceTab: document.querySelector('#voice-tab'),
  textPanel: document.querySelector('#text-panel'),
  voicePanel: document.querySelector('#voice-panel'),
  direction: document.querySelector('#direction'),
  variant: document.querySelector('#variant'),
  voiceVariant: document.querySelector('#voice-variant'),
  sourceText: document.querySelector('#source-text'),
  translateButton: document.querySelector('#translate-button'),
  clearButton: document.querySelector('#clear-button'),
  audioFile: document.querySelector('#audio-file'),
  recordButton: document.querySelector('#record-button'),
  recordingState: document.querySelector('#recording-state'),
  recordingTime: document.querySelector('#recording-time'),
  audioPreview: document.querySelector('#audio-preview'),
  voiceSubmitButton: document.querySelector('#voice-submit-button'),
  voiceClearButton: document.querySelector('#voice-clear-button'),
  sourceOutputLabel: document.querySelector('#source-output-label'),
  translatedOutputLabel: document.querySelector('#translated-output-label'),
  pronunciationOutputLabel: document.querySelector('#pronunciation-output-label'),
  confidenceOutputLabel: document.querySelector('#confidence-output-label'),
  notesOutputLabel: document.querySelector('#notes-output-label'),
  sourceOutput: document.querySelector('#source-output'),
  translatedOutput: document.querySelector('#translated-output'),
  pronunciationOutput: document.querySelector('#pronunciation-output'),
  confidenceOutput: document.querySelector('#confidence-output'),
  notesOutput: document.querySelector('#notes-output')
};

document.addEventListener('DOMContentLoaded', () => {
  createIcons();
  bindEvents();
  setMode('text');
  checkHealth();
});

function createIcons() {
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

function bindEvents() {
  els.authForm.addEventListener('submit', handleAuthSubmit);
  els.textTab.addEventListener('click', () => setMode('text'));
  els.voiceTab.addEventListener('click', () => setMode('voice'));
  els.translateButton.addEventListener('click', translateText);
  els.clearButton.addEventListener('click', clearText);
  els.recordButton.addEventListener('click', toggleRecording);
  els.voiceSubmitButton.addEventListener('click', submitVoice);
  els.voiceClearButton.addEventListener('click', clearAudio);
  els.audioFile.addEventListener('change', handleAudioFile);
}

async function checkHealth() {
  try {
    const response = await fetch('/api/health');
    const health = await response.json();
    const label = getServiceModeLabel(health);

    state.authRequired = Boolean(health.authRequired);
    renderAuthState();
    els.status.classList.toggle('is-ready', health.openaiConfigured);
    els.status.classList.toggle('is-limited', !health.openaiConfigured);
    els.status.querySelector('span:last-child').textContent = label;
  } catch {
    els.status.querySelector('span:last-child').textContent = '服务未连接';
  }
}

function handleAuthSubmit(event) {
  event.preventDefault();
  const password = els.accessPassword.value.trim();
  if (!password) {
    els.authError.textContent = '请输入访问密码。';
    return;
  }

  state.accessPassword = password;
  localStorage.setItem('chaoshanAccessPassword', password);
  renderAuthState();
}

function renderAuthState() {
  const locked = state.authRequired && !state.accessPassword;
  els.authScreen.classList.toggle('is-hidden', !locked);
  document.body.classList.toggle('is-locked', locked);
  if (locked) els.accessPassword.focus();
}

function getAuthHeaders() {
  return state.accessPassword ? { 'x-app-password': state.accessPassword } : {};
}

function handleUnauthorized() {
  state.accessPassword = '';
  localStorage.removeItem('chaoshanAccessPassword');
  els.authError.textContent = '访问密码不正确，请重新输入。';
  renderAuthState();
}

function getServiceModeLabel(health) {
  if (!health.openaiConfigured) return '示例模式';
  if (health.speechConfigured) return '文字+语音模式';
  return '文字模式';
}

function setMode(mode) {
  state.mode = mode;
  const isText = mode === 'text';
  els.textPanel.classList.toggle('is-hidden', !isText);
  els.voicePanel.classList.toggle('is-hidden', isText);
  els.textTab.classList.toggle('is-active', isText);
  els.voiceTab.classList.toggle('is-active', !isText);
  els.textTab.setAttribute('aria-selected', String(isText));
  els.voiceTab.setAttribute('aria-selected', String(!isText));
  applyResultLabels(labels[mode]);
  renderPlaceholder();
}

function applyResultLabels(currentLabels) {
  els.sourceOutputLabel.textContent = currentLabels.source;
  els.translatedOutputLabel.textContent = currentLabels.translated;
  els.pronunciationOutputLabel.textContent = currentLabels.pronunciation;
  els.confidenceOutputLabel.textContent = currentLabels.confidence;
  els.notesOutputLabel.textContent = currentLabels.notes;
}

async function translateText() {
  const text = els.sourceText.value.trim();
  if (!text) {
    showError('请先输入要翻译的内容。');
    return;
  }

  setBusy(els.translateButton, true, '翻译中');

  try {
    const response = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...getAuthHeaders() },
      body: JSON.stringify({
        text,
        direction: els.direction.value,
        variant: els.variant.value
      })
    });

    const data = await response.json();
    if (response.status === 401) {
      handleUnauthorized();
      throw createApiError(data.error || '访问密码不正确');
    }
    if (!response.ok) throw createApiError(data.error || '翻译失败', data.detail);
    renderResult(data);
  } catch (error) {
    showError(error.message, error.detail);
  } finally {
    setBusy(els.translateButton, false, '翻译');
  }
}

async function toggleRecording() {
  if (state.mediaRecorder?.state === 'recording') {
    state.mediaRecorder.stop();
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    state.recordedChunks = [];
    state.mediaRecorder = new MediaRecorder(stream);

    state.mediaRecorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) state.recordedChunks.push(event.data);
    });

    state.mediaRecorder.addEventListener('stop', () => {
      stream.getTracks().forEach((track) => track.stop());
      state.recordedBlob = new Blob(state.recordedChunks, { type: state.mediaRecorder.mimeType });
      showAudioPreview(state.recordedBlob);
      stopTimer();
      els.recordButton.classList.remove('is-recording');
      els.recordingState.textContent = '录音已完成';
      els.recordButton.title = '开始录音';
      els.recordButton.innerHTML = '<i data-lucide="mic"></i>';
      createIcons();
    });

    state.mediaRecorder.start();
    state.startedAt = Date.now();
    state.timer = window.setInterval(updateRecordingTime, 250);
    els.recordButton.classList.add('is-recording');
    els.recordingState.textContent = '正在录音';
    els.recordButton.title = '停止录音';
    els.recordButton.innerHTML = '<i data-lucide="square"></i>';
    createIcons();
  } catch {
    showError('无法打开麦克风，请检查浏览器权限。');
  }
}

function updateRecordingTime() {
  const seconds = Math.floor((Date.now() - state.startedAt) / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  els.recordingTime.textContent = `${pad(minutes)}:${pad(remainder)}`;
}

function stopTimer() {
  window.clearInterval(state.timer);
  state.timer = null;
}

async function submitVoice() {
  const audio = state.recordedBlob || els.audioFile.files?.[0];
  if (!audio) {
    showError('请先录音或上传音频文件。');
    return;
  }

  const form = new FormData();
  form.append('audio', audio, audio.name || 'recording.webm');
  form.append('variant', els.voiceVariant.value);
  setBusy(els.voiceSubmitButton, true, '处理中');

  try {
    const response = await fetch('/api/transcribe-translate', {
      method: 'POST',
      headers: getAuthHeaders(),
      body: form
    });

    const data = await response.json();
    if (response.status === 401) {
      handleUnauthorized();
      throw createApiError(data.error || '访问密码不正确');
    }
    if (!response.ok) throw createApiError(data.error || '语音翻译失败', data.detail);
    renderResult(data);
  } catch (error) {
    showError(error.message, error.detail);
  } finally {
    setBusy(els.voiceSubmitButton, false, '识别并翻译');
  }
}

function handleAudioFile() {
  const file = els.audioFile.files?.[0];
  if (!file) return;
  state.recordedBlob = null;
  showAudioPreview(file);
  els.recordingState.textContent = '已选择音频文件';
  els.recordingTime.textContent = '00:00';
}

function showAudioPreview(blob) {
  els.audioPreview.src = URL.createObjectURL(blob);
  els.audioPreview.classList.remove('is-hidden');
}

function clearText() {
  els.sourceText.value = '';
  renderPlaceholder();
}

function clearAudio() {
  state.recordedBlob = null;
  state.recordedChunks = [];
  els.audioFile.value = '';
  els.audioPreview.removeAttribute('src');
  els.audioPreview.classList.add('is-hidden');
  els.recordingState.textContent = '点击麦克风开始录音';
  els.recordingTime.textContent = '00:00';
  renderPlaceholder();
}

function renderResult(data) {
  if (data.resultLabels) {
    applyResultLabels({
      source: data.resultLabels.source || labels[state.mode].source,
      translated: data.resultLabels.translated || labels[state.mode].translated,
      pronunciation: data.resultLabels.pronunciation || labels[state.mode].pronunciation,
      confidence: data.resultLabels.confidence || labels[state.mode].confidence,
      notes: data.resultLabels.notes || labels[state.mode].notes
    });
  } else {
    applyResultLabels(labels[state.mode]);
  }

  els.sourceOutput.textContent = data.sourceText || '-';
  els.translatedOutput.textContent = data.translatedText || '-';
  els.pronunciationOutput.textContent = data.pronunciation || '-';
  els.confidenceOutput.textContent =
    typeof data.confidence === 'number' ? `${Math.round(data.confidence * 100)}%` : '-';
  els.notesOutput.textContent = data.notes || '-';
}

function renderPlaceholder() {
  const currentLabels = labels[state.mode];
  applyResultLabels(currentLabels);
  els.sourceOutput.textContent = currentLabels.sourcePlaceholder;
  els.translatedOutput.textContent = currentLabels.translatedPlaceholder;
  els.pronunciationOutput.textContent = '-';
  els.confidenceOutput.textContent = '-';
  els.notesOutput.textContent = currentLabels.notesPlaceholder;
}

function createApiError(message, detail = '') {
  const error = new Error(message);
  error.detail = detail || '';
  return error;
}

function showError(message, detail = '') {
  const currentLabels = labels[state.mode];
  applyResultLabels(currentLabels);
  els.sourceOutput.textContent = '出错了';
  els.translatedOutput.textContent = message;
  els.pronunciationOutput.textContent = '-';
  els.confidenceOutput.textContent = '-';
  els.notesOutput.textContent =
    detail || '请确认服务已启动；语音功能需要启用本地 Whisper 或远程语音识别。';
}

function setBusy(button, busy, label) {
  button.disabled = busy;
  const icon = button.querySelector('svg')?.outerHTML || '';
  button.innerHTML = `${icon}${label}`;
}

function pad(number) {
  return String(number).padStart(2, '0');
}
