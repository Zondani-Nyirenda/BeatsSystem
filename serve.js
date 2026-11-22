// Tiny static web server for Beats Studio.
// Browsers only allow microphone recording on http://localhost or https, so run:  npm start
const http = require('http');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const START_PORT = Number(process.env.PORT) || 4800;
const ROOT = __dirname;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.wav': 'audio/wav'
};

function handler(req, res) {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = path.normalize(path.join(ROOT, urlPath === '/' ? 'index.html' : urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  });
}

// "localhost" can mean IPv4 (127.0.0.1) or IPv6 (::1). Claim the port on BOTH, so another app
// (e.g. a Vite dev server on ::1) can never answer http://localhost:<port> instead of us.
function listen(port, host) {
  return new Promise((resolve, reject) => {
    const s = http.createServer(handler);
    s.once('error', err => (err.code === 'EADDRNOTAVAIL' || err.code === 'EAFNOSUPPORT') ? resolve(null) : reject(err));
    s.listen(port, host, () => resolve(s));
  });
}

(async () => {
  for (let port = START_PORT; port < START_PORT + 50; port++) {
    let v4 = null;
    try {
      v4 = await listen(port, '127.0.0.1');
      await listen(port, '::1');
    } catch (err) {
      if (v4) v4.close();
      if (err.code === 'EADDRINUSE') { console.log(`  Port ${port} is used by another app, trying ${port + 1}…`); continue; }
      throw err;
    }
    const url = `http://localhost:${port}`;
    console.log(`\n  Beats Studio is running at ${url}\n  Press Ctrl+C to stop.\n`);
    if (!process.env.NO_OPEN) {
      const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
      exec(cmd, () => { });
    }
    return;
  }
  console.error('  No free port found.');
  process.exit(1);
})();
