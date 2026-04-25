const app = document.querySelector('#app');
const syncStateNode = document.querySelector('[data-sync-state]');
const loginButton = document.querySelector('[data-login]');
const syncButton = document.querySelector('[data-sync]');
const homeButton = document.querySelector('[data-home]');
const APP_TITLE = '微信读书评论';
const DB_NAME = 'weread-sync-web';
const DB_VERSION = 1;

let auth = null;
let snapshot = null;
let busy = false;
let toastTimer = null;

function setView(view) {
  document.body.dataset.view = view;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function delay(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function openDb() {
  return new Promise((resolve, reject) => {
    if (!('indexedDB' in window)) {
      reject(new Error('当前浏览器不支持 IndexedDB，无法使用本地缓存。'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains('kv')) {
        db.createObjectStore('kv');
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function dbGet(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readonly');
    const request = tx.objectStore('kv').get(key);
    request.onsuccess = () => resolve(request.result ?? null);
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => db.close();
  });
}

async function dbSet(key, value) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

async function loadLocalState() {
  [auth, snapshot] = await Promise.all([
    dbGet('auth'),
    dbGet('snapshot')
  ]);
  updateHeader();
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers ?? {})
    }
  });
  const payload = await response.json();
  if (!response.ok || payload.ok === false) {
    const message = payload.error?.message ?? `Request failed: ${response.status}`;
    const error = new Error(message);
    error.code = payload.error?.code;
    throw error;
  }
  return payload;
}

function statusLabel(status) {
  if (status === 'reading') {
    return '在读';
  }
  if (status === 'finished') {
    return '已读';
  }
  return '其他';
}

function formatDate(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return date.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
}

function progressText(book) {
  if (typeof book.progress === 'number') {
    return `${book.progress}%`;
  }
  return statusLabel(book.status);
}

function routeBookPath(bookId) {
  return `/books/${encodeURIComponent(bookId)}`;
}

function currentBookId() {
  const match = /^\/books\/([^/]+)$/.exec(window.location.pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

function navigate(path) {
  window.history.pushState({}, '', path);
  void renderRoute();
}

function showToast(message) {
  window.clearTimeout(toastTimer);
  document.querySelector('.toast')?.remove();
  const node = document.createElement('div');
  node.className = 'toast';
  node.textContent = message;
  document.body.append(node);
  toastTimer = window.setTimeout(() => node.remove(), 3200);
}

function setBusy(value) {
  busy = value;
  syncButton.disabled = value;
  loginButton.disabled = value;
}

function hasBooks() {
  return Array.isArray(snapshot?.books) && snapshot.books.length > 0;
}

function updateHeader() {
  const authenticated = Boolean(auth?.vid && auth?.skey);
  loginButton.hidden = authenticated;
  loginButton.textContent = '登录';
  syncButton.hidden = !authenticated;
  syncStateNode.textContent =
    hasBooks() && snapshot?.syncedAt
      ? `${snapshot.books.length} 本 · ${formatDate(snapshot.syncedAt)}`
      : '';
}

function placeholderCover(book) {
  const mark = escapeHtml(Array.from(book.title || '书').slice(0, 2).join(''));
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="640" viewBox="0 0 480 640">
  <rect width="480" height="640" rx="22" fill="#f7f7f4"/>
  <rect x="36" y="36" width="408" height="568" rx="16" fill="#fff" stroke="#e6e6e6"/>
  <text x="240" y="292" text-anchor="middle" font-family="STKaiti, KaiTi, serif" font-size="54" fill="#a67c52">${mark}</text>
  <text x="240" y="342" text-anchor="middle" font-family="STKaiti, KaiTi, serif" font-size="20" fill="#8a8a8a">微信读书评论</text>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function coverSrc(book) {
  return book.coverUrl || placeholderCover(book);
}

function renderLoading(text = '加载中...') {
  setView('loading');
  app.className = 'main';
  app.innerHTML = `<section class="panel"><p class="loading-line">${escapeHtml(text)}</p></section>`;
}

function renderSyncLoading() {
  setView('loading');
  app.className = 'main';
  app.innerHTML = `
    <section class="panel loading-panel">
      <div class="loader" aria-hidden="true"></div>
      <h1>正在同步</h1>
      <p class="loading-line" data-sync-progress>正在实时拉取书籍、划线和书评。</p>
      <div class="sync-steps" aria-hidden="true">
        <span></span>
        <span></span>
        <span></span>
      </div>
    </section>
  `;
}

function renderEmptyState() {
  setView('home');
  app.className = 'main';

  if (auth?.vid && auth?.skey) {
    app.innerHTML = `
      <section class="panel">
        <h1>还没有本地缓存</h1>
        <p>当前已登录，可以先同步一次书籍和笔记。</p>
        <button class="text-button primary" type="button" data-start-sync>同步书架</button>
      </section>
    `;
    app.querySelector('[data-start-sync]')?.addEventListener('click', () => void startSync());
    return;
  }

  app.innerHTML = `
    <section class="panel">
      <h1>登录微信读书</h1>
      <p>本地还没有可展示的缓存。扫码登录后会自动同步，并在这里展示书籍列表。</p>
      <button class="text-button primary" type="button" data-start-login>显示二维码</button>
    </section>
  `;
  app.querySelector('[data-start-login]')?.addEventListener('click', () => void startLogin(true));
}

function renderHomeGrid(books) {
  setView('home');
  document.title = APP_TITLE;
  app.className = 'main home';
  app.innerHTML = `
    <section class="book-grid">
      ${books.map((book) => `
        <a class="book-card" href="${routeBookPath(book.bookId)}" data-book-id="${escapeHtml(book.bookId)}">
          <div class="cover-wrap">
            <img src="${escapeHtml(coverSrc(book))}" data-fallback="${escapeHtml(placeholderCover(book))}" alt="${escapeHtml(book.title)}" loading="lazy" />
          </div>
          <div class="card-body">
            <h2 class="book-title">${escapeHtml(book.title)}</h2>
            <p class="book-author">${escapeHtml(book.author || '未知作者')}</p>
            <div class="book-meta">
              <span class="status-badge">${escapeHtml(statusLabel(book.status))}</span>
              <span>${escapeHtml(progressText(book))}</span>
            </div>
          </div>
        </a>
      `).join('')}
    </section>
  `;

  app.querySelectorAll('[data-book-id]').forEach((node) => {
    node.addEventListener('click', (event) => {
      event.preventDefault();
      navigate(routeBookPath(node.dataset.bookId));
    });
  });

  app.querySelectorAll('.cover-wrap img').forEach((image) => {
    image.addEventListener('error', () => {
      image.src = image.dataset.fallback;
    }, { once: true });
  });
}

async function renderHome() {
  if (!snapshot) {
    await loadLocalState();
  }

  if (!hasBooks()) {
    renderEmptyState();
    return;
  }

  renderHomeGrid(snapshot.books);
}

function renderSidebar(books, activeBookId) {
  return `
    <aside class="detail-sidebar">
      <button class="side-brand" type="button" data-route-home>${APP_TITLE}</button>
      <button class="back-button" type="button" data-route-home>返回列表</button>
      <div class="detail-side-list">
        ${books.map((book) => `
          <button class="side-book ${book.bookId === activeBookId ? 'active' : ''}" type="button" data-side-book="${escapeHtml(book.bookId)}">
            ${escapeHtml(book.title)}
          </button>
        `).join('')}
      </div>
    </aside>
  `;
}

async function renderDetail(bookId) {
  setView('detail');
  if (!snapshot) {
    await loadLocalState();
  }

  const books = snapshot?.books ?? [];
  const book = books.find((item) => item.bookId === bookId);
  if (!book) {
    app.className = 'main';
    app.innerHTML = `
      <section class="panel">
        <h1>没有找到这本书</h1>
        <p>请返回列表，或点击更新重新同步。</p>
        <button class="text-button primary" type="button" data-route-home>返回列表</button>
      </section>
    `;
    app.querySelector('[data-route-home]')?.addEventListener('click', () => navigate('/'));
    return;
  }

  document.title = `${book.title} - ${APP_TITLE}`;
  app.className = 'main detail';
  app.innerHTML = `
    <section class="detail-layout">
      ${renderSidebar(books, book.bookId)}
      <article class="article">
        <div class="article-top">
          <button class="article-brand" type="button" data-route-home>${APP_TITLE}</button>
          <button class="back-button" type="button" data-route-home>返回列表</button>
        </div>
        <h1>${escapeHtml(book.title)}</h1>
        <div class="article-meta">
          ${escapeHtml([book.author, statusLabel(book.status), formatDate(book.syncedAt)].filter(Boolean).join(' · '))}
        </div>
        <div class="article-body">${book.html}</div>
      </article>
      <div class="right-space"></div>
    </section>
  `;

  app.querySelectorAll('[data-route-home]').forEach((node) => {
    node.addEventListener('click', () => navigate('/'));
  });

  app.querySelectorAll('[data-side-book]').forEach((node) => {
    node.addEventListener('click', () => navigate(routeBookPath(node.dataset.sideBook)));
  });
}

async function renderRoute() {
  try {
    const bookId = currentBookId();
    if (bookId) {
      await renderDetail(bookId);
      return;
    }
    await renderHome();
  } catch (error) {
    app.className = 'main';
    app.innerHTML = `
      <section class="panel">
        <h1>页面加载失败</h1>
        <p>${escapeHtml(error.message)}</p>
        <button class="text-button primary" type="button" data-route-home>返回列表</button>
      </section>
    `;
    app.querySelector('[data-route-home]')?.addEventListener('click', () => navigate('/'));
  }
}

async function startLogin(syncAfterLogin) {
  if (busy) {
    return;
  }

  setBusy(true);
  app.className = 'main';
  app.innerHTML = `
    <section class="panel">
      <h1>正在生成二维码</h1>
      <p class="loading-line">请稍等。</p>
    </section>
  `;

  try {
    const payload = await api('/api/login/start', {
      method: 'POST',
      body: '{}'
    });

    app.innerHTML = `
      <section class="panel">
        <h1>扫码登录</h1>
        <p>请用微信扫码确认登录，成功后会自动继续。</p>
        <div class="qr-box">
          <img src="${payload.qrDataUrl}" alt="微信读书登录二维码" />
        </div>
        <p class="loading-line">等待扫码中...</p>
      </section>
    `;

    while (true) {
      const poll = await api(`/api/login/poll?uid=${encodeURIComponent(payload.uid)}`);
      if (poll.status === 'logged-in') {
        auth = poll.auth;
        await dbSet('auth', auth);
        updateHeader();
        showToast('登录成功');
        setBusy(false);
        if (syncAfterLogin) {
          await startSync();
        } else {
          await renderRoute();
        }
        return;
      }
      await delay(1000);
    }
  } catch (error) {
    showToast(error.message);
    setBusy(false);
    await renderRoute();
  }
}

async function startSync() {
  if (busy) {
    return;
  }

  if (!auth?.vid || !auth?.skey) {
    await startLogin(true);
    return;
  }

  setBusy(true);
  renderSyncLoading();
  const startedAt = Date.now();
  const timer = window.setInterval(() => {
    const progress = document.querySelector('[data-sync-progress]');
    if (progress) {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      progress.textContent = `同步进行中，已用时 ${elapsedSeconds} 秒。结果会写入当前浏览器缓存。`;
    }
  }, 1000);

  try {
    const payload = await api('/api/sync', {
      method: 'POST',
      body: JSON.stringify({
        auth,
        includeStatuses: ['reading', 'finished']
      })
    });
    snapshot = payload;
    await dbSet('snapshot', snapshot);
    updateHeader();
    showToast('同步完成');
    setBusy(false);
    window.clearInterval(timer);
    await renderRoute();
  } catch (error) {
    window.clearInterval(timer);
    showToast(error.message);
    setBusy(false);
    await renderRoute();
  }
}

homeButton.addEventListener('click', () => navigate('/'));
loginButton.addEventListener('click', () => void startLogin(!hasBooks()));
syncButton.addEventListener('click', () => void startSync());
window.addEventListener('popstate', () => void renderRoute());

void renderRoute();
