'use strict';
// Unix socket so Hyprland binds (bin/companion-ctl) can talk to the running app.
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

function socketPath() {
  const dir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return process.env.COMPANION_SOCKET || path.join(dir, 'anime-companion.sock');
}

function startControlServer(onCommand, file = socketPath()) {
  try { fs.unlinkSync(file); } catch { /* not there */ }
  const server = net.createServer((sock) => {
    let buf = '';
    sock.setEncoding('utf8');
    sock.on('data', async (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        const [cmd, ...rest] = line.split(' ');
        let reply;
        try { reply = (await onCommand(cmd, rest.join(' '))) || 'ok'; } catch (e) { reply = `error: ${e.message}`; }
        sock.write(String(reply) + '\n');
      }
    });
    sock.on('error', () => {});
  });
  server.listen(file, () => { try { fs.chmodSync(file, 0o600); } catch { /* ignore */ } });
  return { server, file, close() { server.close(); try { fs.unlinkSync(file); } catch { /* ignore */ } } };
}

function sendCommand(line, file = socketPath(), timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(file);
    const timer = setTimeout(() => { sock.destroy(); reject(new Error('timeout')); }, timeoutMs);
    let out = '';
    sock.setEncoding('utf8');
    sock.on('connect', () => sock.write(line + '\n'));
    sock.on('data', (d) => { out += d; if (out.includes('\n')) { clearTimeout(timer); sock.end(); resolve(out.trim()); } });
    sock.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
}

module.exports = { startControlServer, sendCommand, socketPath };
