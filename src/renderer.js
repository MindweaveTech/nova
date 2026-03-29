const hologram = document.getElementById('hologram');
const statusEl = document.getElementById('status');
const transcriptEl = document.getElementById('transcript');

let state = 'idle';
let mediaRecorder = null;
let audioChunks = [];
let audioStream = null;
let silenceTimer = null;
let analyser = null;
let isRecording = false;

const SILENCE_THRESHOLD = 15;
const SILENCE_DURATION = 1800;
const MIN_RECORD_TIME = 500;
let recordStartTime = 0;

// --- State Management ---

function setState(newState, statusText) {
  state = newState;
  hologram.className = `hologram ${newState}`;
  statusEl.textContent = statusText || {
    idle: 'NOVA',
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

// --- Boot Sequence ---

async function bootSequence() {
  console.log('[BOOT] Starting Nova boot sequence...');
  setState('booting', 'INITIALIZING');

  // Step 1: Config check
  const config = await window.nova.checkConfig();
  console.log('[BOOT] Config:', JSON.stringify(config));
  if (!config.hasClaude) {
    setState('error', 'KEY MISSING');
    showTranscript('Set ANTHROPIC_API_KEY in .env', 10000);
    return;
  }

  // Run diagnostics silently while showing booting animation
  console.log('[BOOT] Running diagnostics...');
  setState('booting', 'SCANNING');
  const checks = await window.nova.bootDiagnostics();

  const passed = checks.filter(c => c.status === 'pass');
  const failed = checks.filter(c => c.status === 'fail');

  // Log to console only
  console.log('=== NOVA BOOT DIAGNOSTICS ===');
  checks.forEach(c => {
    console.log(`  [${c.status === 'pass' ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
  });
  console.log(`=== ${passed.length}/${checks.length} PASSED ===`);

  // One concise spoken summary
  setState('speaking', 'ONLINE');
  if (failed.length === 0) {
    await window.nova.speak('Nova online. All systems in optimal state.');
  } else {
    await window.nova.speak(`Nova online. ${failed.length} systems need attention, but I'm operational.`);
  }

  setState('idle');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// --- Audio Capture ---

async function startListening() {
  if (state === 'listening') return;

  if (state === 'speaking') {
    await window.nova.stopSpeaking();
  }

  try {
    if (!audioStream) {
      audioStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
      });
    }

    setState('listening');
    audioChunks = [];
    recordStartTime = Date.now();

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(audioStream);
    analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    mediaRecorder = new MediaRecorder(audioStream, { mimeType: 'audio/webm;codecs=opus' });
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) audioChunks.push(e.data);
    };
    mediaRecorder.onstop = handleRecordingComplete;
    mediaRecorder.start(100);
    isRecording = true;

    detectSilence();
  } catch (err) {
    console.error('Mic access error:', err);
    setState('error', 'MIC ERROR');
    setTimeout(() => setState('idle'), 2000);
  }
}

function detectSilence() {
  if (!analyser || !isRecording) return;

  const data = new Uint8Array(analyser.frequencyBinCount);
  analyser.getByteFrequencyData(data);
  const avg = data.reduce((a, b) => a + b, 0) / data.length;

  if (avg < SILENCE_THRESHOLD) {
    if (!silenceTimer) {
      silenceTimer = setTimeout(() => {
        if (isRecording && (Date.now() - recordStartTime) > MIN_RECORD_TIME) {
          stopListening();
        }
      }, SILENCE_DURATION);
    }
  } else {
    clearTimeout(silenceTimer);
    silenceTimer = null;
  }

  if (isRecording) requestAnimationFrame(detectSilence);
}

function stopListening() {
  if (!isRecording) return;
  isRecording = false;
  clearTimeout(silenceTimer);
  silenceTimer = null;

  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }
}

async function handleRecordingComplete() {
  if (audioChunks.length === 0) {
    setState('idle');
    return;
  }

  setState('thinking');

  try {
    const blob = new Blob(audioChunks, { type: 'audio/webm' });
    const arrayBuffer = await blob.arrayBuffer();

    const transcript = await window.nova.transcribe(arrayBuffer);
    if (!transcript || transcript.trim().length === 0) {
      setState('idle');
      return;
    }

    showTranscript(transcript);
    await processMessage(transcript);
  } catch (err) {
    console.error('Processing error:', err);
    setState('error', err.message?.substring(0, 30) || 'ERROR');
    setTimeout(() => setState('idle'), 3000);
  }
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

    setState('idle');
  } catch (err) {
    console.error('AI error:', err);
    setState('error', err.message?.substring(0, 30) || 'ERROR');
    setTimeout(() => setState('idle'), 3000);
  }
}

// --- Event Handlers ---

hologram.addEventListener('click', () => {
  if (state === 'idle' || state === 'error') {
    startListening();
  } else if (state === 'listening') {
    stopListening();
  } else if (state === 'speaking') {
    window.nova.stopSpeaking();
    startListening();
  }
});

window.nova.onToggleListen(() => {
  if (state === 'idle' || state === 'error') {
    startListening();
  } else if (state === 'listening') {
    stopListening();
  } else if (state === 'speaking') {
    window.nova.stopSpeaking();
    startListening();
  }
});

window.nova.onSpeakingStarted(() => {
  if (state !== 'speaking') setState('speaking');
});

window.nova.onSpeakingEnded(() => {
  if (state === 'speaking') setState('idle');
});

// --- Init: Run Boot Sequence ---

bootSequence().catch(err => {
  console.error('[BOOT] Fatal error:', err);
  setState('error', 'BOOT FAIL');
  showTranscript(err.message || String(err), 10000);
});
