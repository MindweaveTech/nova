const { app, BrowserWindow, ipcMain, globalShortcut, screen, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFile, exec } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const Anthropic = require('@anthropic-ai/sdk');

let mainWindow = null;
let sayProcess = null;
let anthropic = null;
let conversationHistory = [];

const SYSTEM_PROMPT = `You are Nova, a female AI assistant running on macOS, inspired by J.A.R.V.I.S. and Friday from Iron Man — calm, confident, feminine voice.

RULES:
- Maximum 2 sentences per response. No exceptions. Be concise.
- Speak naturally — sharp, slightly witty, warm but efficient.
- When the user wants you to run a terminal command, wrap it in <cmd>command</cmd> tags.
- You can include multiple <cmd> tags if needed.
- For destructive commands (rm -rf, sudo rm, DROP, etc.), warn briefly and ask confirmation.
- After command results are provided, summarize the outcome in 1-2 sentences.
- Never say "I'm an AI" or apologize. Just help.
- You have full CLI access to this macOS machine. Use it when helpful.
- Current date: ${new Date().toLocaleDateString()}
- Hostname: ${os.hostname()}
- User: ${os.userInfo().username}
- Home: ${os.homedir()}
- Platform: macOS (${os.arch()})
- CPUs: ${os.cpus().length} cores (${os.cpus()[0]?.model?.trim()})
- Memory: ${Math.round(os.totalmem() / 1073741824)}GB total`;

function createWindow() {
  const display = screen.getPrimaryDisplay();
  const { width, height } = display.workAreaSize;

  mainWindow = new BrowserWindow({
    width: 320,
    height: 400,
    x: width - 340,
    y: height - 420,
    transparent: true,
    frame: false,
    alwaysOnTop: true,
    hasShadow: false,
    resizable: false,
    skipTaskbar: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
  mainWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  mainWindow.setAlwaysOnTop(true, 'floating', 1);
  mainWindow.setIgnoreMouseEvents(false);

  mainWindow.webContents.on('console-message', (event, level, message) => {
    const tag = ['LOG', 'WARN', 'ERR'][level] || 'LOG';
    console.log(`[RENDERER:${tag}] ${message}`);
  });

  // Send initial theme + watch for changes
  mainWindow.webContents.on('did-finish-load', () => {
    mainWindow.webContents.send('nova:theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  });

  nativeTheme.on('updated', () => {
    mainWindow?.webContents.send('nova:theme', nativeTheme.shouldUseDarkColors ? 'dark' : 'light');
  });
}

function initAPIs() {
  if (process.env.ANTHROPIC_API_KEY) {
    anthropic = new Anthropic.default({ apiKey: process.env.ANTHROPIC_API_KEY });
  }
}

// --- Local Whisper STT ---

function transcribeWithWhisper(audioPath) {
  return new Promise((resolve, reject) => {
    const outDir = path.dirname(audioPath);
    const baseName = path.basename(audioPath, path.extname(audioPath));

    exec(
      `/opt/homebrew/bin/whisper "${audioPath}" --model base.en --language en --output_format txt --output_dir "${outDir}" --fp16 False`,
      { timeout: 30000 },
      (error, stdout, stderr) => {
        // Read the output txt file
        const txtPath = path.join(outDir, `${baseName}.txt`);
        try {
          const text = fs.readFileSync(txtPath, 'utf-8').trim();
          // Cleanup
          try { fs.unlinkSync(txtPath); } catch {}
          try { fs.unlinkSync(audioPath); } catch {}
          resolve(text);
        } catch (readErr) {
          // Fallback: parse stdout for transcription
          const lines = stdout.split('\n').filter(l => l.includes(']'));
          const text = lines.map(l => l.replace(/\[.*?\]\s*/, '')).join(' ').trim();
          try { fs.unlinkSync(audioPath); } catch {}
          if (text) resolve(text);
          else reject(new Error('Whisper produced no output'));
        }
      }
    );
  });
}

// --- Boot Diagnostics ---

async function runBootDiagnostics() {
  const checks = [];

  const check = (name, fn) => {
    return fn().then(result => {
      checks.push({ name, status: 'pass', detail: result });
    }).catch(err => {
      checks.push({ name, status: 'fail', detail: err.message || String(err) });
    });
  };

  await Promise.all([
    check('CPU', async () => `${os.cpus().length} cores, ${os.cpus()[0]?.model?.trim()}`),
    check('Memory', async () => {
      const free = Math.round(os.freemem() / 1073741824 * 10) / 10;
      const total = Math.round(os.totalmem() / 1073741824);
      return `${free}GB free of ${total}GB`;
    }),
    check('Disk', () => new Promise((resolve, reject) => {
      exec("df -h / | tail -1 | awk '{print $4 \" available of \" $2}'", (err, stdout) => {
        err ? reject(err) : resolve(stdout.trim());
      });
    })),
    check('Network', () => new Promise((resolve) => {
      exec("ping -c 1 -t 3 8.8.8.8 2>/dev/null && echo 'connected' || echo 'offline'", (err, stdout) => {
        resolve(stdout.trim().includes('connected') ? 'online' : 'offline');
      });
    })),
    check('Docker', () => new Promise((resolve) => {
      exec("docker info --format '{{.ContainersRunning}} containers running' 2>/dev/null", (err, stdout) => {
        resolve(err ? 'not running' : stdout.trim());
      });
    })),
    check('Git', () => new Promise((resolve) => {
      exec("git --version 2>/dev/null", (err, stdout) => {
        resolve(err ? 'not installed' : stdout.trim().replace('git version ', 'v'));
      });
    })),
    check('Node', () => new Promise((resolve) => {
      resolve(`v${process.versions.node}`);
    })),
    check('Claude API', async () => {
      if (!anthropic) throw new Error('no key');
      const r = await anthropic.messages.create({
        model: 'claude-opus-4-20250514', max_tokens: 5,
        messages: [{ role: 'user', content: 'Say OK' }],
      });
      return 'connected';
    }),
    check('Whisper STT', () => new Promise((resolve, reject) => {
      exec("which /opt/homebrew/bin/whisper", (err) => {
        err ? reject('not found') : resolve('local (base.en)');
      });
    })),
    check('TTS Engine', () => new Promise((resolve, reject) => {
      exec("which say", (err) => {
        err ? reject('missing') : resolve('macOS native');
      });
    })),
    check('Mindweave Server', () => new Promise((resolve) => {
      exec("ssh -o ConnectTimeout=3 -o BatchMode=yes mindweavehq echo ok 2>/dev/null", (err, stdout) => {
        resolve(stdout.trim() === 'ok' ? 'reachable' : 'unreachable');
      });
    })),
  ]);

  return checks;
}

// --- IPC Handlers ---

ipcMain.handle('nova:transcribe', async (event, audioBuffer) => {
  const tmpFile = path.join(os.tmpdir(), `nova-${Date.now()}.wav`);
  fs.writeFileSync(tmpFile, Buffer.from(audioBuffer));

  // Convert webm to wav using ffmpeg, then transcribe
  const wavFile = path.join(os.tmpdir(), `nova-${Date.now()}-converted.wav`);

  return new Promise((resolve, reject) => {
    exec(`ffmpeg -i "${tmpFile}" -ar 16000 -ac 1 -y "${wavFile}" 2>/dev/null`, { timeout: 10000 }, async (err) => {
      try { fs.unlinkSync(tmpFile); } catch {}

      if (err) {
        // Try transcribing the raw file if ffmpeg fails
        try {
          const text = await transcribeWithWhisper(tmpFile);
          resolve(text);
        } catch (e) {
          reject(new Error('Audio conversion failed'));
        }
        return;
      }

      try {
        const text = await transcribeWithWhisper(wavFile);
        resolve(text);
      } catch (e) {
        reject(e);
      }
    });
  });
});

ipcMain.handle('nova:chat', async (event, userMessage) => {
  if (!anthropic) throw new Error('Anthropic API key not set');

  conversationHistory.push({ role: 'user', content: userMessage });

  if (conversationHistory.length > 20) {
    conversationHistory = conversationHistory.slice(-20);
  }

  const response = await anthropic.messages.create({
    model: 'claude-opus-4-20250514',
    max_tokens: 200,
    system: SYSTEM_PROMPT,
    messages: conversationHistory,
  });

  const text = response.content[0].text;
  conversationHistory.push({ role: 'assistant', content: text });
  return text;
});

ipcMain.handle('nova:execute', async (event, command) => {
  return new Promise((resolve) => {
    exec(command, {
      timeout: 30000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, PATH: process.env.PATH + ':/usr/local/bin:/opt/homebrew/bin' },
    }, (error, stdout, stderr) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: error ? error.code || 1 : 0,
      });
    });
  });
});

let playProcess = null;

ipcMain.handle('nova:speak', async (event, text) => {
  // Kill any current speech
  if (sayProcess) { sayProcess.kill('SIGKILL'); sayProcess = null; }
  if (playProcess) { playProcess.kill('SIGKILL'); playProcess = null; }

  const voice = process.env.NOVA_VOICE || 'en-US-JennyNeural';
  const rate = process.env.NOVA_RATE || '+5%';
  const mp3File = path.join(os.tmpdir(), `nova-tts-${Date.now()}.mp3`);

  mainWindow?.webContents.send('nova:speaking-started');

  return new Promise((resolve) => {
    // Generate speech with edge-tts
    exec(
      `edge-tts --voice "${voice}" --rate="${rate}" --text "${text.replace(/"/g, '\\"')}" --write-media "${mp3File}"`,
      { timeout: 15000 },
      (err) => {
        if (err) {
          // Fallback to macOS say
          sayProcess = execFile('say', ['-r', '195', text], () => {
            sayProcess = null;
            mainWindow?.webContents.send('nova:speaking-ended');
            resolve(true);
          });
          return;
        }

        // Play the mp3
        playProcess = execFile('afplay', [mp3File], () => {
          playProcess = null;
          try { fs.unlinkSync(mp3File); } catch {}
          mainWindow?.webContents.send('nova:speaking-ended');
          resolve(true);
        });
      }
    );
  });
});

ipcMain.handle('nova:stop-speaking', async () => {
  let stopped = false;
  if (sayProcess) { sayProcess.kill('SIGKILL'); sayProcess = null; stopped = true; }
  if (playProcess) { playProcess.kill('SIGKILL'); playProcess = null; stopped = true; }
  if (stopped) mainWindow?.webContents.send('nova:speaking-ended');
  return stopped;
});

ipcMain.handle('nova:boot-diagnostics', async () => {
  return await runBootDiagnostics();
});

ipcMain.handle('nova:check-config', async () => {
  return {
    hasClaude: !!process.env.ANTHROPIC_API_KEY,
    voice: process.env.NOVA_VOICE || 'Samantha',
  };
});

// --- App Lifecycle ---

app.whenReady().then(() => {
  initAPIs();
  createWindow();

  globalShortcut.register('Alt+Space', () => {
    mainWindow?.webContents.send('nova:toggle-listen');
    mainWindow?.focus();
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  if (sayProcess) sayProcess.kill('SIGKILL');
});

app.on('window-all-closed', () => {
  app.quit();
});
