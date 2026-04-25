import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createBookDetail, createBooksIndex, createSnapshot, enrichLoginAuth } from '../src/shared/sync.js';
import { getConfirmUrl, getLoginUid, waitForLogin } from '../src/shared/wereadClient.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'public');
const host = process.env.HOST || '127.0.0.1';
const port = Number(process.env.PORT || 8788);

function contentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();
  if (extension === '.html') return 'text/html; charset=utf-8';
  if (extension === '.css') return 'text/css; charset=utf-8';
  if (extension === '.js') return 'text/javascript; charset=utf-8';
  if (extension === '.svg') return 'image/svg+xml; charset=utf-8';
  return 'application/octet-stream';
}

function sendJson(response, status, payload) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

async function readBody(request) {
  const chunks = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  return text ? JSON.parse(text) : {};
}

async function handleApi(request, response, requestUrl) {
  if (requestUrl.pathname === '/api/login/start' && request.method === 'POST') {
    const result = await getLoginUid();
    const confirmUrl = getConfirmUrl(result.uid);
    sendJson(response, 200, {
      ok: true,
      uid: result.uid,
      confirmUrl,
      qrDataUrl: `https://api.qrserver.com/v1/create-qr-code/?size=320x320&data=${encodeURIComponent(confirmUrl)}`
    });
    return;
  }

  if (requestUrl.pathname === '/api/login/poll' && request.method === 'GET') {
    const uid = requestUrl.searchParams.get('uid');
    const result = await waitForLogin(uid, 25_000);
    if (result?.succeed && result.webLoginVid && result.accessToken) {
      sendJson(response, 200, {
        ok: true,
        status: 'logged-in',
        auth: await enrichLoginAuth(result)
      });
      return;
    }
    sendJson(response, 200, {
      ok: true,
      status: 'waiting',
      reason: result?.logicCode ?? 'waiting'
    });
    return;
  }

  if (requestUrl.pathname === '/api/sync' && request.method === 'POST') {
    sendJson(response, 200, await createSnapshot(await readBody(request)));
    return;
  }

  if (requestUrl.pathname === '/api/books' && request.method === 'POST') {
    sendJson(response, 200, await createBooksIndex(await readBody(request)));
    return;
  }

  if (requestUrl.pathname === '/api/book' && request.method === 'POST') {
    sendJson(response, 200, await createBookDetail(await readBody(request)));
    return;
  }

  sendJson(response, 404, {
    ok: false,
    error: {
      code: 'NOT_FOUND',
      message: 'Not found'
    }
  });
}

async function handleStatic(requestUrl, response) {
  const pathname = decodeURIComponent(requestUrl.pathname);
  const relativePath = pathname === '/' || pathname.startsWith('/books/')
    ? 'index.html'
    : pathname.slice(1);
  const filePath = path.resolve(publicDir, relativePath);

  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${path.sep}`)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const data = await fs.readFile(filePath);
    response.writeHead(200, {
      'Content-Type': contentType(filePath),
      'Cache-Control': 'no-store'
    });
    response.end(data);
  } catch {
    const data = await fs.readFile(path.join(publicDir, 'index.html'));
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store'
    });
    response.end(data);
  }
}

const server = http.createServer((request, response) => {
  void (async () => {
    const requestUrl = new URL(request.url ?? '/', `http://${request.headers.host ?? host}`);
    try {
      if (requestUrl.pathname.startsWith('/api/')) {
        await handleApi(request, response, requestUrl);
        return;
      }
      await handleStatic(requestUrl, response);
    } catch (error) {
      sendJson(response, 500, {
        ok: false,
        error: {
          code: error?.code ?? 'API_ERROR',
          message: error instanceof Error ? error.message : String(error)
        }
      });
    }
  })();
});

server.listen(port, host, () => {
  console.log(`weread-sync-web dev server: http://${host}:${port}`);
});
