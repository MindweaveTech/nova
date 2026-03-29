const hologram = document.getElementById('hologram');
const statusEl = document.getElementById('status');
const usageEl = document.getElementById('usage');
const matrixLog = document.getElementById('matrix-log');
const transcriptEl = document.getElementById('transcript');

let state = 'idle';
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let audioContext = null;
let analyser = null;
let silenceTimer = null;
let isRecording = false;
let monitoringRAF = null;
let recordStartTime = 0;
let queryCount = 0;
let partialTimer = null;

// --- VAD Tuning ---
const SPEECH_THRESHOLD = 25;
const SILENCE_THRESHOLD = 12;
const SILENCE_DURATION = 1500;
const MIN_RECORD_TIME = 600;
const SPEECH_CONFIRM_MS = 150;
const PARTIAL_INTERVAL = 2500;   // ms between partial transcriptions
const MAX_LOG_LINES = 12;
let speechConfirmTimer = null;

// =============================================
// Matrix Log
// =============================================

function matrixPush(text, type = '') {
  const line = document.createElement('div');
  line.className = `matrix-line ${type}`;
  line.textContent = text;
  matrixLog.appendChild(line);

  // Trim old lines
  while (matrixLog.children.length > MAX_LOG_LINES) {
    matrixLog.removeChild(matrixLog.firstChild);
  }

  // Auto-remove after animation
  setTimeout(() => {
    if (line.parentNode) line.parentNode.removeChild(line);
  }, 6000);
}

// --- State Management ---

function setState(newState, statusText) {
  state = newState;
  hologram.className = `hologram ${newState}`;
  statusEl.textContent = statusText || {
    idle: 'NOVA',
    monitoring: 'NOVA',
    booting: 'BOOTING...',
    listening: 'LISTENING',
    thinking: 'THINKING',
    speaking: 'SPEAKING',
    error: 'ERROR',
  }[newState];
}

function showTranscript(text, duration) {
  transcriptEl.textContent = text;
  transcriptEl.style.opacity = '1';
  setTimeout(() => { transcriptEl.style.opacity = '0'; }, duration || 4000);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// =============================================
// Boot Sequence
// =============================================

async function bootSequence() {
  console.log('[BOOT] Starting Nova boot sequence...');
  setState('booting', 'INITIALIZING');
  matrixPush('> nova.init()', 'system');

  const config = await window.nova.checkConfig();
  if (!config.hasClaude) {
    setState('error', 'KEY MISSING');
    matrixPush('ERR: ANTHROPIC_API_KEY missing', 'bright');
    return;
  }

  matrixPush('scanning subsystems...', 'dim');
  setState('booting', 'SCANNING');
  const checks = await window.nova.bootDiagnostics();

  const passed = checks.filter(c => c.status === 'pass');
  const failed = checks.filter(c => c.status === 'fail');

  // Stream diagnostics into matrix log
  for (const c of checks) {
    const icon = c.status === 'pass' ? '+' : '!';
    const type = c.status === 'pass' ? 'dim' : 'bright';
    matrixPush(`[${icon}] ${c.name}: ${c.detail}`, type);
    await sleep(80);
  }

  console.log('=== NOVA BOOT DIAGNOSTICS ===');
  checks.forEach(c => console.log(`  [${c.status === 'pass' ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`));
  console.log(`=== ${passed.length}/${checks.length} PASSED ===`);

  matrixPush(`${passed.length}/${checks.length} systems nominal`, 'bright');

  setState('speaking', 'ONLINE');
  if (failed.length === 0) {
    await window.nova.speak('Nova online. All systems in optimal state.');
  } else {
    await window.nova.speak(`Nova online. ${failed.length} systems need attention, but I'm operational.`);
  }

  startMonitoring();
}

// =============================================
// Smart Auto-Listening (Always-on VAD)
// =============================================

async function initMic() {
  if (audioStream) return;

  audioStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });

  audioContext = new AudioContext();
  const source = audioContext.createMediaStreamSource(audioStream);
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 1024;
  analyser.smoothingTimeConstant = 0.3;
  source.connect(analyser);
  console.log('[MIC] Microphone initialized');
}

function getAudioLevel() {
  if (!analyser) return 0;
  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const sampleRate = audioContext.sampleRate;
  const binSize = sampleRate / analyser.fftSize;
  const startBin = Math.floor(300 / binSize);
  const endBin = Math.floor(3000 / binSize);
  let sum = 0;
  for (let i = startBin; i < endBin && i < data.length; i++) sum += data[i];
  return sum / (endBin - startBin);
}

// Phase 1: Monitor
async function startMonitoring() {
  try {
    await initMic();
  } catch (err) {
    console.error('[MIC] Access denied:', err);
    setState('error', 'MIC ERROR');
    matrixPush('ERR: microphone access denied', 'bright');
    setTimeout(() => setState('idle'), 2000);
    return;
  }

  setState('monitoring');
  matrixPush('vad.monitoring()', 'dim');
  monitorLoop();
}

function monitorLoop() {
  if (state !== 'monitoring') return;

  const level = getAudioLevel();

  if (level >= SPEECH_THRESHOLD) {
    if (!speechConfirmTimer) {
      speechConfirmTimer = setTimeout(() => {
        speechConfirmTimer = null;
        if (state === 'monitoring' && getAudioLevel() >= SPEECH_THRESHOLD) {
          console.log('[VAD] Speech confirmed, recording...');
          startRecording();
        }
      }, SPEECH_CONFIRM_MS);
    }
  } else {
    if (speechConfirmTimer) {
      clearTimeout(speechConfirmTimer);
      speechConfirmTimer = null;
    }
  }

  monitoringRAF = requestAnimationFrame(monitorLoop);
}

function stopMonitoring() {
  if (monitoringRAF) { cancelAnimationFrame(monitoringRAF); monitoringRAF = null; }
  if (speechConfirmTimer) { clearTimeout(speechConfirmTimer); speechConfirmTimer = null; }
}

// Phase 2: Record with real-time partial transcription
function startRecording() {
  stopMonitoring();

  setState('listening');
  matrixPush('speech detected', 'bright');
  audioChunks = [];
  recordStartTime = Date.now();
  isRecording = true;

  mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm;codecs=opus' });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = handleRecordingComplete;
  mediaRecorder.start(100);

  // Start partial transcription loop
  startPartialTranscription();
  detectSilence();
}

function startPartialTranscription() {
  if (partialTimer) clearInterval(partialTimer);

  partialTimer = setInterval(async () => {
    if (!isRecording || audioChunks.length === 0) return;

    try {
      // Clone current chunks for partial transcription
      const partialBlob = new Blob([...audioChunks], { type: 'audio/webm' });
      const buf = await partialBlob.arrayBuffer();

      const partial = await window.nova.transcribe(buf);
      if (partial && partial.trim().length > 2) {
        // Filter low-confidence: very short or common noise artifacts
        const cleaned = partial.trim();
        const isNoise = /^(you|the|a|i|uh|um|hmm|ah|oh|okay|so)$/i.test(cleaned);
        if (!isNoise && cleaned.length > 3) {
          matrixPush(cleaned, 'speech');
        }
      }
    } catch (e) {
      // Partial transcription failed silently — that's ok
    }
  }, PARTIAL_INTERVAL);
}

function stopPartialTranscription() {
  if (partialTimer) { clearInterval(partialTimer); partialTimer = null; }
}

function detectSilence() {
  if (!isRecording) return;
  const level = getAudioLevel();

  if (level < SILENCE_THRESHOLD) {
    if (!silenceTimer) {
      silenceTimer = setTimeout(() => {
        if (isRecording && (Date.now() - recordStartTime) > MIN_RECORD_TIME) {
          stopRecording();
        }
      }, SILENCE_DURATION);
    }
  } else {
    if (silenceTimer) { clearTimeout(silenceTimer); silenceTimer = null; }
  }

  if (isRecording) requestAnimationFrame(detectSilence);
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  clearTimeout(silenceTimer);
  silenceTimer = null;
  stopPartialTranscription();

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

// Phase 3: Process
async function handleRecordingComplete() {
  if (audioChunks.length === 0) {
    startMonitoring();
    return;
  }

  setState('thinking');
  matrixPush('transcribing...', 'dim');

  try {
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const arrayBuffer = await blob.arrayBuffer();

    const transcript = await window.nova.transcribe(arrayBuffer);
    if (!transcript || transcript.trim().length === 0) {
      matrixPush('(silence)', 'dim');
      startMonitoring();
      return;
    }

    console.log('[STT] Final:', transcript);
    matrixPush(`"${transcript}"`, 'speech');
    showTranscript(transcript);
    queryCount++;
    usageEl.textContent = `${queryCount} ${queryCount === 1 ? 'query' : 'queries'}`;

    await processMessage(transcript);
  } catch (err) {
    console.error('[PROCESS] Error:', err);
    matrixPush(`err: ${err.message?.substring(0, 40)}`, 'bright');
    setState('error', err.message?.substring(0, 30) || 'ERROR');
    await sleep(2000);
  }

  startMonitoring();
}

// =============================================
// AI Interaction
// =============================================

async function processMessage(userMessage) {
  setState('thinking');
  matrixPush('claude.opus.thinking()', 'system');

  try {
    let response = await window.nova.chat(userMessage);

    const cmdRegex = /<cmd>([\s\S]*?)<\/cmd>/g;
    let match;
    const commands = [];
    while ((match = cmdRegex.exec(response)) !== null) {
      commands.push(match[1].trim());
    }

    const spokenText = response.replace(/<cmd>[\s\S]*?<\/cmd>/g, '').trim();

    if (spokenText) {
      matrixPush(`> ${spokenText.substring(0, 60)}`, 'bright');
      setState('speaking');
      await window.nova.speak(spokenText);
    }

    if (commands.length > 0) {
      for (const cmd of commands) {
        matrixPush(`$ ${cmd}`, 'system');
        setState('thinking', 'EXECUTING');
        showTranscript(`> ${cmd}`);

        const result = await window.nova.execute(cmd);
        const output = result.stdout || result.stderr || '(no output)';
        const preview = output.split('\n')[0].substring(0, 50);
        matrixPush(`  ${preview}`, result.exitCode === 0 ? 'dim' : 'bright');

        const summary = await window.nova.chat(
          `Command executed: \`${cmd}\`\nExit code: ${result.exitCode}\nOutput:\n${output.substring(0, 1000)}`
        );

        const summaryClean = summary.replace(/<cmd>[\s\S]*?<\/cmd>/g, '').trim();
        if (summaryClean) {
          matrixPush(`> ${summaryClean.substring(0, 60)}`, 'bright');
          setState('speaking');
          await window.nova.speak(summaryClean);
        }
      }
    }
  } catch (err) {
    console.error('[AI] Error:', err);
    matrixPush(`err: ${err.message?.substring(0, 40)}`, 'bright');
    setState('error', err.message?.substring(0, 30) || 'ERROR');
    await sleep(2000);
  }
}

// =============================================
// Interrupt
// =============================================

function interrupt() {
  if (state === 'speaking') {
    window.nova.stopSpeaking();
    matrixPush('interrupted', 'dim');
    setTimeout(() => startRecording(), 200);
  }
}

hologram.addEventListener('click', interrupt);

window.nova.onToggleListen(() => {
  if (state === 'speaking') {
    interrupt();
  } else if (state === 'monitoring') {
    startRecording();
  }
});

window.nova.onSpeakingStarted(() => {
  if (state !== 'speaking') setState('speaking');
});

window.nova.onSpeakingEnded(() => {});

// =============================================
// Init
// =============================================

bootSequence().catch(err => {
  console.error('[BOOT] Fatal error:', err);
  setState('error', 'BOOT FAIL');
  matrixPush(`fatal: ${err.message}`, 'bright');
});
