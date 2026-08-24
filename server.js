'use strict';
/*
 * 造神计划 · 云端工作台后端
 * 零依赖（仅 Node 内置模块）。数据按 workspace 令牌隔离，持久化到 data/ws/<token>.json；
 * 上传图片存于 data/uploads/<token>/。前端改造后全部读写走 /api/*，彻底脱离 localStorage 主存储。
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const PUBLIC_DIR = path.join(__dirname, 'public');
const WS_DIR = path.join(DATA_DIR, 'ws');
const UP_DIR = path.join(DATA_DIR, 'uploads');

fs.mkdirSync(WS_DIR, { recursive: true });
fs.mkdirSync(UP_DIR, { recursive: true });

/* ---------- 工具 ---------- */
function sendJSON(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(s);
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (limit && size > limit) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function validToken(t) {
  return typeof t === 'string' && /^[A-Za-z0-9_-]{8,64}$/.test(t);
}
/* 每令牌串行锁，避免并发读写竞态 */
const locks = {};
function withLock(token, fn) {
  if (!locks[token]) locks[token] = Promise.resolve();
  const res = locks[token].then(fn, fn);
  locks[token] = res.catch(() => {});
  return res;
}
function readWS(token) {
  try {
    const s = fs.readFileSync(path.join(WS_DIR, token + '.json'), 'utf8');
    const o = JSON.parse(s);
    return { data: o.data || {}, mt: o.mt || {} };
  } catch (e) {
    return { data: {}, mt: {} };
  }
}
function writeWS(token, obj) {
  fs.mkdirSync(WS_DIR, { recursive: true });
  const f = path.join(WS_DIR, token + '.json');
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj));
  fs.renameSync(tmp, f); /* 原子替换，避免半写 */
}
function mergePayload(ws, payload) {
  const data = payload && payload.data ? payload.data : {};
  const mt = payload && payload.mt ? payload.mt : {};
  Object.keys(data).forEach((k) => {
    const cm = mt[k] || 0;
    const sm = ws.mt[k] || 0;
    if (!(k in ws.mt) || cm >= sm) { ws.data[k] = data[k]; ws.mt[k] = cm; }
  });
  return ws;
}
/* 极简 multipart/form-data 解析（仅取 file 字段） */
function parseMultipart(buf, boundary) {
  const b = Buffer.from('--' + boundary);
  const segs = [];
  let start = 0;
  while (true) {
    const i = buf.indexOf(b, start);
    if (i < 0) break;
    if (start > 0) segs.push(buf.slice(start, i));
    start = i + b.length;
    if (buf[start] === 0x2d && buf[start + 1] === 0x2d) break; /* 结束 -- */
    if (buf[start] === 0x0d) start += 2; /* 跳过 \r\n */
  }
  const files = [];
  segs.forEach((seg) => {
    const he = seg.indexOf('\r\n\r\n');
    if (he < 0) return;
    const header = seg.slice(0, he).toString('utf8');
    let content = seg.slice(he + 4);
    if (content.length >= 2 && content[content.length - 2] === 0x0d && content[content.length - 1] === 0x0a) {
      content = content.slice(0, content.length - 2);
    }
    const nm = header.match(/name="([^"]*)"/);
    const fn = header.match(/filename="([^"]*)"/);
    if (fn) files.push({ name: nm ? nm[1] : '', filename: fn[1], content });
  });
  return files;
}
const CT_EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/avif': 'avif' };
function extOf(filename, contentType) {
  if (contentType && CT_EXT[contentType]) return CT_EXT[contentType];
  const m = /\.([A-Za-z0-9]{1,5})$/.exec(filename || '');
  if (m) { const e = m[1].toLowerCase(); return (e === 'jpeg') ? 'jpg' : e; }
  return 'bin';
}

/* ---------- 静态文件 ---------- */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8'
};
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!filePath.startsWith(PUBLIC_DIR)) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      /* SPA 回退到 index.html */
      fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, idx) => {
        if (e2) { res.writeHead(404); res.end('not found'); } else { res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(idx); }
      });
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}
function serveUpload(req, res, token, file) {
  if (!validToken(token)) { res.writeHead(400); res.end('bad token'); return; }
  const filePath = path.normalize(path.join(UP_DIR, token, file));
  if (!filePath.startsWith(path.join(UP_DIR, token))) { res.writeHead(403); res.end('forbidden'); return; }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

/* ---------- API 路由 ---------- */
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  /* 上传图片静态访问 */
  const upMatch = p.match(/^\/uploads\/([^/]+)\/(.+)$/);
  if (upMatch) { serveUpload(req, res, upMatch[1], upMatch[2]); return; }

  if (p === '/api/health') { sendJSON(res, 200, { ok: true, t: Date.now() }); return; }

  /* 新建 workspace */
  if (p === '/api/workspace/new' && req.method === 'GET') {
    const token = crypto.randomBytes(12).toString('base64url');
    withLock(token, () => { writeWS(token, { data: {}, mt: {} }); }).then(() => {
      sendJSON(res, 200, { token });
    }).catch((e) => sendJSON(res, 500, { error: String(e) }));
    return;
  }

  const wsMatch = p.match(/^\/api\/workspace\/([^/]+)$/);
  if (wsMatch) {
    const token = wsMatch[1];
    if (!validToken(token)) { sendJSON(res, 400, { error: 'bad token' }); return; }
    if (req.method === 'GET') {
      withLock(token, () => {
        const ws = readWS(token);
        sendJSON(res, 200, { token, data: ws.data, mt: ws.mt });
      }).catch((e) => sendJSON(res, 500, { error: String(e) }));
      return;
    }
    if (req.method === 'POST') {
      readBody(req, 5 * 1024 * 1024).then((buf) => {
        let payload = {};
        try { payload = JSON.parse(buf.toString('utf8') || '{}'); } catch (e) { sendJSON(res, 400, { error: 'bad json' }); return; }
        withLock(token, () => {
          const ws = readWS(token);
          mergePayload(ws, payload);
          writeWS(token, ws);
          sendJSON(res, 200, { token, data: ws.data, mt: ws.mt });
        }).catch((e) => sendJSON(res, 500, { error: String(e) }));
      }).catch(() => sendJSON(res, 413, { error: 'payload too large' }));
      return;
    }
    res.writeHead(405); res.end('method not allowed'); return;
  }

  const mgMatch = p.match(/^\/api\/migrate\/([^/]+)$/);
  if (mgMatch && req.method === 'POST') {
    const token = mgMatch[1];
    if (!validToken(token)) { sendJSON(res, 400, { error: 'bad token' }); return; }
    readBody(req, 5 * 1024 * 1024).then((buf) => {
      let payload = {};
      try { payload = JSON.parse(buf.toString('utf8') || '{}'); } catch (e) { sendJSON(res, 400, { error: 'bad json' }); return; }
      withLock(token, () => {
        const ws = readWS(token);
        const before = Object.keys(ws.data).length;
        mergePayload(ws, payload);
        writeWS(token, ws);
        const after = Object.keys(ws.data).length;
        sendJSON(res, 200, { token, imported: after - before, data: ws.data, mt: ws.mt });
      }).catch((e) => sendJSON(res, 500, { error: String(e) }));
    }).catch(() => sendJSON(res, 413, { error: 'payload too large' }));
    return;
  }

  const upApiMatch = p.match(/^\/api\/upload\/([^/]+)$/);
  if (upApiMatch && req.method === 'POST') {
    const token = upApiMatch[1];
    if (!validToken(token)) { sendJSON(res, 400, { error: 'bad token' }); return; }
    const ct = req.headers['content-type'] || '';
    const bm = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
    if (!bm) { sendJSON(res, 400, { error: 'no boundary' }); return; }
    readBody(req, 12 * 1024 * 1024).then((buf) => {
      const files = parseMultipart(buf, bm[1] || bm[2]);
      const f = files[0];
      if (!f) { sendJSON(res, 400, { error: 'no file' }); return; }
      const dir = path.join(UP_DIR, token);
      fs.mkdirSync(dir, { recursive: true });
      const id = crypto.randomBytes(12).toString('hex') + '.' + extOf(f.filename, req.headers['content-type']);
      fs.writeFileSync(path.join(dir, id), f.content);
      sendJSON(res, 200, { url: '/uploads/' + token + '/' + id, size: f.content.length });
    }).catch(() => sendJSON(res, 413, { error: 'upload too large' }));
    return;
  }

  if (p.startsWith('/api/')) { sendJSON(res, 404, { error: 'not found' }); return; }
  serveStatic(req, res, p);
});

server.listen(PORT, () => {
  console.log('[zs5-cloud] listening on http://localhost:' + PORT);
  console.log('[zs5-cloud] data dir:', DATA_DIR);
});
