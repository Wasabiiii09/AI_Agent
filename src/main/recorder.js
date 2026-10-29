'use strict';
// Microphone recording to 16 kHz mono WAV via pw-record (PipeWire) or arecord (ALSA).
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

function which(bin) { return spawnSync('sh', ['-c', `command -v ${bin}`]).status === 0; }

function recorderCommand(backend, file) {
  if (backend === 'pw-record') return ['pw-record', ['--rate', '16000', '--channels', '1', '--format', 's16', file]];
  if (backend === 'arecord') return ['arecord', ['-q', '-f', 'S16_LE', '-r', '16000', '-c', '1', '-t', 'wav', file]];
  throw new Error(`неизвестный backend записи: ${backend}`);
}

function createRecorder(cfg = {}) {
  const r = cfg.recorder || {};
  let child = null, file = null, startedAt = 0, guard = null;
  const pick = () => (r.backend && r.backend !== 'auto' ? r.backend : which('pw-record') ? 'pw-record' : 'arecord');

  return {
    get recording() { return !!child; },
    start() {
      if (child) return false;
      file = path.join(os.tmpdir(), `companion-rec-${process.pid}-${Date.now()}.wav`);
      const [cmd, args] = recorderCommand(pick(), file);
      child = spawn(cmd, args, { stdio: 'ignore' });
      child.on('error', () => { child = null; });
      startedAt = Date.now();
      guard = setTimeout(() => this.stop(), (r.maxSeconds || 30) * 1000);
      return true;
    },
    /** stop -> { file, ms } or null when nothing recorded */
    stop() {
      clearTimeout(guard);
      if (!child) return Promise.resolve(null);
      const c = child; child = null;
      const ms = Date.now() - startedAt;
      return new Promise((resolve) => {
        const done = () => resolve(fs.existsSync(file) && fs.statSync(file).size > 2000 ? { file, ms } : null);
        c.once('close', done);
        c.kill('SIGINT'); // lets pw-record/arecord finalize the WAV header
        setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, 1500);
      });
    },
  };
}

module.exports = { createRecorder, recorderCommand };
