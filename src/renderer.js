const hologram = document.getElementById('hologram');
const statusEl = document.getElementById('status');
const usageEl = document.getElementById('usage');
const transcriptEl = document.getElementById('transcript');

let queryCount = 0;

let state = 'idle'; // idle, monitoring, listening, thinking, speaking, booting, error
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let audioContext = null;
let analyser = null;
let silenceTimer = null;
let isRecording = false;
let monitoringRAF = null;
let recordStartTime = 0;

// --- VAD Tuning ---
const SPEECH_THRESHOLD = 25;     // Level to trigger recording (above background noise)
const SILENCE_THRESHOLD = 12;    // Level considered silence during recording
const SILENCE_DURATION = 1500;   // ms of silence to stop recording
const MIN_RECORD_TIME = 600;     // minimum recording length to process
const SPEECH_CONFIRM_MS = 150;   // ms of sustained speech before we commit to recording
let speechConfirmTimer = null;

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

// --- Boot Sequence ---

async function bootSequence() {
  console.log('[BOOT] Starting Nova boot sequence...');
  setState('booting', 'INITIALIZING');

  const config = await window.nova.checkConfig();
  console.log('[BOOT] Config:', JSON.stringify(config));
  if (!config.hasClaude) {
    setState('error', 'KEY MISSING');
    showTranscript('Set ANTHROPIC_API_KEY in .env', 10000);
    return;
  }

  console.log('[BOOT] Running diagnostics...');
  setState('booting', 'SCANNING');
  const checks = await window.nova.bootDiagnostics();

  const passed = checks.filter(c => c.status === 'pass');
  const failed = checks.filter(c => c.status === 'fail');

  console.log('=== NOVA BOOT DIAGNOSTICS ===');
  checks.forEach(c => {
    console.log(`  [${c.status === 'pass' ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
  });
  console.log(`=== ${passed.length}/${checks.length} PASSED ===`);

  setState('speaking', 'ONLINE');
  if (failed.length === 0) {
    await window.nova.speak('Nova online. All systems in optimal state.');
  } else {
    await window.nova.speak(`Nova online. ${failed.length} systems need attention, but I'm operational.`);
  }

  // After boot, start auto-listening
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
  // Weight towards speech frequencies (300Hz - 3kHz)
  const sampleRate = audioContext.sampleRate;
  const binSize = sampleRate / analyser.fftSize;
  const startBin = Math.floor(300 / binSize);
  const endBin = Math.floor(3000 / binSize);
  let sum = 0;
  for (let i = startBin; i < endBin && i < data.length; i++) {
    sum += data[i];
  }
  return sum / (endBin - startBin);
}

// Phase 1: Monitor — mic is hot, watching for speech
async function startMonitoring() {
  try {
    await initMic();
  } catch (err) {
    console.error('[MIC] Access denied:', err);
    setState('error', 'MIC ERROR');
    setTimeout(() => setState('idle'), 2000);
    return;
  }

  setState('monitoring');
  console.log('[VAD] Monitoring started');
  monitorLoop();
}

function monitorLoop() {
  if (state !== 'monitoring') return;

  const level = getAudioLevel();

  if (level >= SPEECH_THRESHOLD) {
    // Speech detected — wait for confirmation (sustained speech, not a click/bump)
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
  if (monitoringRAF) {
    cancelAnimationFrame(monitoringRAF);
    monitoringRAF = null;
  }
  if (speechConfirmTimer) {
    clearTimeout(speechConfirmTimer);
    speechConfirmTimer = null;
  }
}

// Phase 2: Record — speech detected, capturing audio
function startRecording() {
  stopMonitoring();

  setState('listening');
  audioChunks = [];
  recordStartTime = Date.now();
  isRecording = true;

  mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm;codecs=opus' });
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0) audioChunks.push(e.data);
  };
  mediaRecorder.onstop = handleRecordingComplete;
  mediaRecorder.start(100);

  detectSilence();
}

function detectSilence() {
  if (!isRecording) return;

  const level = getAudioLevel();

  if (level < SILENCE_THRESHOLD) {
    if (!silenceTimer) {
      silenceTimer = setTimeout(() => {
        if (isRecording && (Date.now() - recordStartTime) > MIN_RECORD_TIME) {
          console.log('[VAD] Silence detected, stopping recording');
          stopRecording();
        }
      }, SILENCE_DURATION);
    }
  } else {
    // Speech continuing — reset silence timer
    if (silenceTimer) {
      clearTimeout(silenceTimer);
      silenceTimer = null;
    }
  }

  if (isRecording) requestAnimationFrame(detectSilence);
}

function stopRecording() {
  if (!isRecording) return;
  isRecording = false;
  clearTimeout(silenceTimer);
  silenceTimer = null;

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

// Phase 3: Process — transcribe + AI + speak, then back to monitoring
async function handleRecordingComplete() {
  if (audioChunks.length === 0) {
    startMonitoring();
    return;
  }

  setState('thinking');

  try {
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const arrayBuffer = await blob.arrayBuffer();

    const transcript = await window.nova.transcribe(arrayBuffer);
    if (!transcript || transcript.trim().length === 0) {
      startMonitoring();
      return;
    }

    console.log('[STT] Transcript:', transcript);
    showTranscript(transcript);
    queryCount++;
    usageEl.textContent = `${queryCount} ${queryCount === 1 ? 'query' : 'queries'}`;
    await processMessage(transcript);
  } catch (err) {
    console.error('[PROCESS] Error:', err);
    setState('error', err.message?.substring(0, 30) || 'ERROR');
    await sleep(2000);
  }

  // Always return to monitoring after processing
  startMonitoring();
}

// --- AI Interaction ---

async function processMessage(userMessage) {
  setState('thinking');

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
      setState('speaking');
      await window.nova.speak(spokenText);
    }

    if (commands.length > 0) {
      setState('thinking', 'EXECUTING');

      for (const cmd of commands) {
        showTranscript(`> ${cmd}`);
        const result = await window.nova.execute(cmd);
        const output = result.stdout || result.stderr || '(no output)';

        const summary = await window.nova.chat(
          `Command executed: \`${cmd}\`\nExit code: ${result.exitCode}\nOutput:\n${output.substring(0, 1000)}`
        );

        const summaryClean = summary.replace(/<cmd>[\s\S]*?<\/cmd>/g, '').trim();
        if (summaryClean) {
          setState('speaking');
          await window.nova.speak(summaryClean);
        }
      }
    }
  } catch (err) {
    console.error('[AI] Error:', err);
    setState('error', err.message?.substring(0, 30) || 'ERROR');
    await sleep(2000);
  }
}

// --- Interrupt: click or hotkey while speaking ---

function interrupt() {
  if (state === 'speaking') {
    window.nova.stopSpeaking();
    // Short delay then start listening fresh
    setTimeout(() => startRecording(), 200);
  }
}

hologram.addEventListener('click', interrupt);

window.nova.onToggleListen(() => {
  if (state === 'speaking') {
    interrupt();
  } else if (state === 'monitoring') {
    // Force start recording (manual trigger)
    startRecording();
  }
});

window.nova.onSpeakingStarted(() => {
  if (state !== 'speaking') setState('speaking');
});

window.nova.onSpeakingEnded(() => {
  // Don't go back to monitoring here — let the processMessage flow handle it
});

// --- Init ---

bootSequence().catch(err => {
  console.error('[BOOT] Fatal error:', err);
  setState('error', 'BOOT FAIL');
  showTranscript(err.message || String(err), 10000);
});
