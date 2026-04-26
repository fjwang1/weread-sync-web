const app = document.querySelector('#app');
const syncStateNode = document.querySelector('[data-sync-state]');
const loginButton = document.querySelector('[data-login]');
const syncButton = document.querySelector('[data-sync]');
const homeButton = document.querySelector('[data-home]');
const APP_TITLE = '微信读书评论';
const DB_NAME = 'weread-sync-web';
const DB_VERSION = 1;
const BOOKS_INDEX_KEY = 'booksIndex';
const LEGACY_SNAPSHOT_KEY = 'snapshot';
const DETAIL_CACHE_VERSION = 3;
const SIDEBAR_COLLAPSED_KEY = 'sidebarCollapsed';
const SIDEBAR_ANIMATION_MS = 300;

let auth = null;
let booksIndex = null;
let busy = false;
let toastTimer = null;
let detailRequestSeq = 0;
let activeDetailBookId = null;
let activeDetailMeta = null;
let activeDetailData = null;
let authValidated = false;
let authValidationPromise = null;
let detailRefreshLoadingBookId = null;
let sidebarCollapsed = readSidebarCollapsed();
const manuallyUpdatedBooks = new Set();

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

function readSidebarCollapsed() {
  try {
    return window.localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeSidebarCollapsed(value) {
  try {
    window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(value));
  } catch {
    // Local storage is only a convenience; the toggle still works without it.
  }
}

function sidebarToggleButton(extraClass = '') {
  const label = sidebarCollapsed ? '展开书架栏' : '收起书架栏';
  return `
    <button class="sidebar-toggle ${extraClass}" type="button" data-toggle-sidebar aria-label="${label}" aria-expanded="${String(!sidebarCollapsed)}">
      <svg viewBox="0 0 24 24" aria-hidden="true">
        <rect x="3" y="4" width="18" height="16" rx="4"></rect>
        <path d="M9 4v16"></path>
      </svg>
    </button>
  `;
}

function updateSidebarToggleState() {
  document.querySelectorAll('[data-toggle-sidebar]').forEach((node) => {
    const label = sidebarCollapsed ? '展开书架栏' : '收起书架栏';
    node.setAttribute('aria-label', label);
    node.setAttribute('aria-expanded', String(!sidebarCollapsed));
  });
}

function shouldAnimateSidebar() {
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches;
}

function animateArticleShift(article, firstRect) {
  const lastRect = article.getBoundingClientRect();
  const deltaX = firstRect.left - lastRect.left;
  const deltaY = firstRect.top - lastRect.top;

  if (Math.abs(deltaX) < 1 && Math.abs(deltaY) < 1) {
    return;
  }

  article.getAnimations().forEach((animation) => animation.cancel());
  article.animate(
    [
      { transform: `translate3d(${deltaX}px, ${deltaY}px, 0)` },
      { transform: 'translate3d(0, 0, 0)' }
    ],
    {
      duration: SIDEBAR_ANIMATION_MS,
      easing: 'cubic-bezier(0.2, 0, 0, 1)'
    }
  );
}

function animateSidebarPresence(sidebar, collapsed) {
  sidebar.getAnimations().forEach((animation) => animation.cancel());
  sidebar.animate(
    collapsed
      ? [
          { opacity: 1, transform: 'translate3d(0, 0, 0)' },
          { opacity: 0, transform: 'translate3d(-18px, 0, 0)' }
        ]
      : [
          { opacity: 0, transform: 'translate3d(-18px, 0, 0)' },
          { opacity: 1, transform: 'translate3d(0, 0, 0)' }
        ],
    {
      duration: 220,
      easing: 'cubic-bezier(0.2, 0, 0, 1)'
    }
  );
}

function applySidebarCollapsedState(options = {}) {
  const layout = document.querySelector('.detail-layout');
  if (!layout) {
    return false;
  }

  const article = document.querySelector('.article');
  const sidebar = document.querySelector('.detail-sidebar');
  const animate = options.animate && article && sidebar && shouldAnimateSidebar();
  const firstArticleRect = animate ? article.getBoundingClientRect() : null;

  layout.classList.toggle('detail-layout--collapsed', sidebarCollapsed);
  updateSidebarToggleState();

  if (animate && firstArticleRect) {
    animateArticleShift(article, firstArticleRect);
    animateSidebarPresence(sidebar, sidebarCollapsed);
  }

  return true;
}

function setSidebarCollapsed(value) {
  if (sidebarCollapsed === value) {
    return;
  }
  sidebarCollapsed = value;
  writeSidebarCollapsed(value);
  if (!applySidebarCollapsedState({ animate: true })) {
    rerenderActiveDetail();
  }
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

async function dbDelete(key) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').delete(key);
    tx.oncomplete = () => {
      db.close();
      resolve();
    };
    tx.onerror = () => reject(tx.error);
  });
}

function bookDetailKey(bookId) {
  return `bookDetail:${bookId}`;
}

function makeBooksIndexFromLegacy(snapshot) {
  if (!Array.isArray(snapshot?.books)) {
    return null;
  }

  return {
    ok: true,
    version: 2,
    syncedAt: snapshot.syncedAt,
    totalBooks: snapshot.totalBooks ?? snapshot.books.length,
    bookCount: snapshot.books.length,
    books: snapshot.books.map((book) => ({
      bookId: book.bookId,
      title: book.title,
      author: book.author,
      coverUrl: book.coverUrl,
      noteCount: book.noteCount ?? 0,
      reviewCount: book.reviewCount ?? 0,
      sort: book.sort ?? 0
    }))
  };
}

function makeBookDetailFromLegacy(snapshot, bookId) {
  const book = snapshot?.books?.find((item) => item.bookId === bookId);
  if (!book?.html) {
    return null;
  }

  return {
    ok: true,
    version: DETAIL_CACHE_VERSION,
    syncedAt: book.syncedAt ?? snapshot.syncedAt,
    book
  };
}

function readDisplayText(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function normalizeDetailHtml(html) {
  if (typeof html !== 'string' || !html.trim()) {
    return '<h2>简介</h2>';
  }

  const firstHeadingPattern = /^\s*<h([1-5])>.*?<\/h\1>/;
  if (firstHeadingPattern.test(html)) {
    return html.replace(firstHeadingPattern, '<h$1>简介</h$1>');
  }

  return `<h2>简介</h2>${html}`;
}

function normalizeBookDetail(detail, fallbackBook = {}) {
  if (!detail?.book?.html) {
    return null;
  }

  const mergedBook = {
    ...fallbackBook,
    ...(detail.book ?? {})
  };
  const title = readDisplayText(mergedBook.title) || readDisplayText(fallbackBook.title) || '未命名书籍';
  const author = readDisplayText(mergedBook.author) || readDisplayText(fallbackBook.author);
  const intro = readDisplayText(mergedBook.intro);

  return {
    ...detail,
    ok: detail.ok !== false,
    version: DETAIL_CACHE_VERSION,
    syncedAt: detail.syncedAt ?? mergedBook.syncedAt ?? null,
    book: {
      ...mergedBook,
      title,
      author,
      intro,
      html: normalizeDetailHtml(mergedBook.html),
      syncedAt: mergedBook.syncedAt ?? detail.syncedAt ?? null
    }
  };
}

async function loadLocalState() {
  const [storedAuth, storedIndex, legacySnapshot] = await Promise.all([
    dbGet('auth'),
    dbGet(BOOKS_INDEX_KEY),
    dbGet(LEGACY_SNAPSHOT_KEY)
  ]);
  auth = storedAuth;
  authValidated = false;
  authValidationPromise = null;
  booksIndex = storedIndex ?? makeBooksIndexFromLegacy(legacySnapshot);
  if (!storedIndex && booksIndex) {
    await dbSet(BOOKS_INDEX_KEY, booksIndex);
  }
  updateHeader();
}

async function readBookDetail(bookId) {
  const cachedDetail = await dbGet(bookDetailKey(bookId));
  if (cachedDetail?.book?.html) {
    const normalizedDetail = normalizeBookDetail(
      cachedDetail,
      booksIndex?.books?.find((item) => item.bookId === bookId)
    );
    if (normalizedDetail) {
      if (
        cachedDetail.version !== DETAIL_CACHE_VERSION ||
        cachedDetail.book.html !== normalizedDetail.book.html ||
        cachedDetail.book.intro !== normalizedDetail.book.intro
      ) {
        await dbSet(bookDetailKey(bookId), normalizedDetail);
      }
      return normalizedDetail;
    }
  }

  const legacySnapshot = await dbGet(LEGACY_SNAPSHOT_KEY);
  const legacyDetail = makeBookDetailFromLegacy(legacySnapshot, bookId);
  if (legacyDetail) {
    const normalizedDetail = normalizeBookDetail(
      legacyDetail,
      booksIndex?.books?.find((item) => item.bookId === bookId)
    );
    await dbSet(bookDetailKey(bookId), normalizedDetail);
    return normalizedDetail;
  }
  return null;
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

function resetPageScroll() {
  window.requestAnimationFrame(() => {
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.documentElement.scrollTop = 0;
    document.body.scrollTop = 0;
    app.scrollTop = 0;
    document.querySelector('.detail')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    document.querySelector('.article')?.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  });
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
  document.querySelectorAll('[data-refresh-book]').forEach((node) => {
    node.disabled = value;
  });
}

function isAuthenticated() {
  return Boolean(auth?.vid && auth?.skey);
}

async function clearAuth() {
  auth = null;
  authValidated = false;
  authValidationPromise = null;
  await dbDelete('auth');
  updateHeader();
}

async function ensureValidAuth() {
  if (!isAuthenticated()) {
    return false;
  }

  if (authValidated) {
    return true;
  }

  if (authValidationPromise) {
    return authValidationPromise;
  }

  renderLoading('正在校验登录状态...');
  authValidationPromise = (async () => {
    try {
      const result = await api('/api/auth/check', {
        method: 'POST',
        body: JSON.stringify({ auth })
      });
      if (result.valid) {
        authValidated = true;
        updateHeader();
        return true;
      }
    } catch (error) {
      showToast(error.message);
    }

    await clearAuth();
    return false;
  })().finally(() => {
    authValidationPromise = null;
  });

  return authValidationPromise;
}

function hasBooks() {
  return Array.isArray(booksIndex?.books) && booksIndex.books.length > 0;
}

function updateHeader() {
  const authenticated = isAuthenticated();
  loginButton.hidden = authenticated;
  loginButton.textContent = '登录';
  syncButton.hidden = !authenticated;
  syncStateNode.textContent =
    authenticated && hasBooks() && booksIndex?.syncedAt
      ? `${booksIndex.books.length} 本 · ${formatDate(booksIndex.syncedAt)}`
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

function noteSummary(book) {
  const notes = Number(book.noteCount ?? 0);
  const reviews = Number(book.reviewCount ?? 0);
  if (reviews > 0) {
    return `${notes} 条划线 · ${reviews} 条评论`;
  }
  return `${notes} 条划线`;
}

function renderLoading(text = '加载中...') {
  setView('loading');
  app.className = 'main';
  app.innerHTML = `<section class="panel"><p class="loading-line">${escapeHtml(text)}</p></section>`;
}

function renderSyncLoading(text = '正在拉取书籍。') {
  setView('loading');
  app.className = 'main';
  app.innerHTML = `
    <section class="panel loading-panel">
      <div class="loader" aria-hidden="true"></div>
      <h1>正在同步</h1>
      <p class="loading-line" data-sync-progress>${escapeHtml(text)}</p>
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

  if (isAuthenticated()) {
    app.innerHTML = `
      <section class="panel">
        <h1>还没有本地缓存</h1>
        <p>当前已登录，可以先同步一次书籍。</p>
        <button class="text-button primary" type="button" data-start-sync>同步书架</button>
      </section>
    `;
    app.querySelector('[data-start-sync]')?.addEventListener('click', () => void syncBooksIndex());
    return;
  }

  app.innerHTML = `
    <section class="panel">
      <h1>登录微信读书</h1>
      <p>${hasBooks() ? '请先登录微信读书，登录后可以继续查看本地缓存并更新内容。' : '本地还没有可展示的缓存。扫码登录后会自动同步，并在这里展示书籍列表。'}</p>
      <button class="text-button primary" type="button" data-start-login>显示二维码</button>
    </section>
  `;
  app.querySelector('[data-start-login]')?.addEventListener('click', () => void startLogin(true));
}

function renderHomeGrid(books) {
  setView('home');
  activeDetailBookId = null;
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
              <span>${escapeHtml(noteSummary(book))}</span>
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
  detailRequestSeq += 1;
  if (!booksIndex) {
    await loadLocalState();
  }

  if (!(await ensureValidAuth())) {
    renderEmptyState();
    return;
  }

  if (!hasBooks()) {
    renderEmptyState();
    return;
  }

  const firstBook = booksIndex.books[0];
  window.history.replaceState({}, '', routeBookPath(firstBook.bookId));
  await renderDetail(firstBook.bookId);
}

function renderSidebar(books, activeBookId) {
  return `
    <aside class="detail-sidebar">
      <div class="side-head">
        <div class="side-brand">${APP_TITLE}</div>
        ${sidebarToggleButton()}
      </div>
      <div class="detail-side-list">
        ${books.map((book) => `
          <button class="side-book ${book.bookId === activeBookId ? 'active' : ''}" type="button" data-side-book="${escapeHtml(book.bookId)}">
            <span class="side-cover">
              <img src="${escapeHtml(coverSrc(book))}" data-fallback="${escapeHtml(placeholderCover(book))}" alt="" loading="lazy" decoding="async" />
            </span>
            <span class="side-book-body">
              <span class="side-book-title">${escapeHtml(book.title)}</span>
              <span class="side-book-author">${escapeHtml(book.author || '未知作者')}</span>
              <span class="side-book-meta">${escapeHtml(noteSummary(book))}</span>
            </span>
          </button>
        `).join('')}
      </div>
    </aside>
  `;
}

function detailRefreshStatus(bookId) {
  if (detailRefreshLoadingBookId === bookId) {
    return 'loading';
  }

  if (manuallyUpdatedBooks.has(bookId)) {
    return 'success';
  }

  return 'idle';
}

function rerenderActiveDetail() {
  if (!activeDetailMeta || currentBookId() !== activeDetailMeta.bookId) {
    return;
  }

  renderDetailLayout(activeDetailMeta, activeDetailData);
}

function renderDetailLayout(bookMeta, detail) {
  const normalizedDetail = normalizeBookDetail(detail, bookMeta);
  const books = booksIndex?.books ?? [bookMeta];
  const book = {
    ...bookMeta,
    ...(normalizedDetail?.book ?? {})
  };
  const html = normalizedDetail?.book?.html
    ? normalizedDetail.book.html
    : '<p class="loading-line">正在拉取。</p>';
  const meta = [
    book.author,
    normalizedDetail?.book?.status ? statusLabel(normalizedDetail.book.status) : null,
    formatDate(normalizedDetail?.book?.syncedAt ?? normalizedDetail?.syncedAt)
  ].filter(Boolean).join(' · ');
  const shouldResetScroll = activeDetailBookId !== book.bookId;
  activeDetailBookId = book.bookId;
  activeDetailMeta = bookMeta;
  activeDetailData = normalizedDetail;

  setView('detail');
  document.title = `${book.title} - ${APP_TITLE}`;
  app.className = 'main detail';
  const refreshStatus = detailRefreshStatus(book.bookId);
  app.innerHTML = `
    <section class="detail-layout ${sidebarCollapsed ? 'detail-layout--collapsed' : ''}">
      ${sidebarToggleButton('sidebar-toggle-floating')}
      ${renderSidebar(books, book.bookId)}
      <article class="article">
        <div class="article-top">
          <div class="article-brand">${APP_TITLE}</div>
        </div>
        <h1>${escapeHtml(book.title)}</h1>
        <div class="article-meta">${escapeHtml(meta)}</div>
        <div class="article-actions">
          <button class="text-button primary refresh-button" type="button" data-refresh-book>更新</button>
          <span class="refresh-indicator refresh-indicator--${refreshStatus}" aria-hidden="${refreshStatus === 'idle' ? 'true' : 'false'}">
            <span class="status-spinner" aria-hidden="true"></span>
            <span class="status-check" aria-hidden="true"></span>
          </span>
        </div>
        <div class="article-body">${html}</div>
      </article>
      <div class="right-space"></div>
    </section>
  `;

  app.querySelectorAll('[data-side-book]').forEach((node) => {
    node.addEventListener('click', () => navigate(routeBookPath(node.dataset.sideBook)));
  });

  app.querySelectorAll('[data-toggle-sidebar]').forEach((node) => {
    node.addEventListener('click', () => setSidebarCollapsed(!sidebarCollapsed));
  });

  app.querySelectorAll('.side-cover img').forEach((image) => {
    image.addEventListener('error', () => {
      image.src = image.dataset.fallback;
    }, { once: true });
  });

  app.querySelector('[data-refresh-book]')?.addEventListener('click', () => {
    void syncBookDetail(bookMeta);
  });

  if (busy) {
    setBusy(true);
  }

  if (shouldResetScroll) {
    resetPageScroll();
  }
}

async function renderDetail(bookId) {
  if (!booksIndex) {
    await loadLocalState();
  }

  if (!(await ensureValidAuth())) {
    renderEmptyState();
    return;
  }

  const bookMeta = booksIndex?.books?.find((item) => item.bookId === bookId);
  if (!bookMeta) {
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

  const cachedDetail = await readBookDetail(bookId);
  renderDetailLayout(bookMeta, cachedDetail);
  if (!cachedDetail) {
    await syncBookDetail(bookMeta, { silent: true });
  }
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

async function handleAuthExpired(error) {
  if (error?.code !== 'AUTH_EXPIRED') {
    return false;
  }

  await clearAuth();
  showToast('登录已失效，请重新登录');
  await renderRoute();
  return true;
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
        authValidated = true;
        authValidationPromise = null;
        await dbSet('auth', auth);
        updateHeader();
        showToast('登录成功');
        setBusy(false);
        if (syncAfterLogin) {
          await syncBooksIndex();
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

function startElapsedTimer(text) {
  const startedAt = Date.now();
  return window.setInterval(() => {
    const progress = document.querySelector('[data-sync-progress]');
    if (progress) {
      const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
      progress.textContent = `${text}，已用时 ${elapsedSeconds} 秒。`;
    }
  }, 1000);
}

async function syncBooksIndex() {
  if (busy) {
    return;
  }

  if (!isAuthenticated()) {
    await startLogin(true);
    return;
  }

  setBusy(true);
  renderSyncLoading('正在拉取书籍。');
  const timer = startElapsedTimer('正在拉取');

  try {
    const payload = await api('/api/books', {
      method: 'POST',
      body: JSON.stringify({ auth })
    });
    booksIndex = payload;
    await dbSet(BOOKS_INDEX_KEY, booksIndex);
    updateHeader();
    showToast('同步完成');
    setBusy(false);
    window.clearInterval(timer);
    await renderRoute();
  } catch (error) {
    window.clearInterval(timer);
    setBusy(false);
    if (await handleAuthExpired(error)) {
      return;
    }
    showToast(error.message);
    await renderRoute();
  }
}

async function syncBookDetail(bookMeta, options = {}) {
  if (!isAuthenticated()) {
    await startLogin(false);
    return;
  }

  const requestSeq = ++detailRequestSeq;
  if (!options.silent) {
    detailRefreshLoadingBookId = bookMeta.bookId;
  }
  setBusy(true);
  if (!options.silent) {
    rerenderActiveDetail();
  }

  try {
    const payload = normalizeBookDetail(await api('/api/book', {
      method: 'POST',
      body: JSON.stringify({
        auth,
        bookId: bookMeta.bookId,
        book: bookMeta
      })
    }), bookMeta);
    await dbSet(bookDetailKey(bookMeta.bookId), payload);
    if (detailRefreshLoadingBookId === bookMeta.bookId) {
      detailRefreshLoadingBookId = null;
    }

    if (currentBookId() === bookMeta.bookId && requestSeq === detailRequestSeq) {
      if (!options.silent) {
        manuallyUpdatedBooks.add(bookMeta.bookId);
      }
      renderDetailLayout(bookMeta, payload);
      if (!options.silent) {
        showToast('同步完成');
      }
    }
  } catch (error) {
    if (detailRefreshLoadingBookId === bookMeta.bookId) {
      detailRefreshLoadingBookId = null;
    }
    if (!(await handleAuthExpired(error))) {
      showToast(error.message);
      if (!options.silent && currentBookId() === bookMeta.bookId) {
        await renderRoute();
      } else {
        rerenderActiveDetail();
      }
    }
  } finally {
    setBusy(false);
  }
}

async function startSync() {
  const bookId = currentBookId();
  if (!bookId) {
    await syncBooksIndex();
    return;
  }

  if (!booksIndex) {
    await loadLocalState();
  }
  const bookMeta = booksIndex?.books?.find((item) => item.bookId === bookId);
  if (!bookMeta) {
    await syncBooksIndex();
    return;
  }
  await syncBookDetail(bookMeta);
}

homeButton.addEventListener('click', () => navigate('/'));
loginButton.addEventListener('click', () => void startLogin(!hasBooks()));
syncButton.addEventListener('click', () => void startSync());
window.addEventListener('popstate', () => void renderRoute());

void renderRoute();
