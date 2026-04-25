import { renderBookMarkdown, renderMarkdownToHtml } from './markdown.js';
import { classifyReadingStatus, parseIncludeStatuses } from './status.js';
import {
  fetchBookInfo,
  fetchBookmarkList,
  fetchBookProgress,
  fetchNotebookList,
  fetchReviewList,
  fetchUserInfo
} from './wereadClient.js';

const DETAIL_CACHE_VERSION = 3;

function asRecord(value) {
  return value && typeof value === 'object' ? value : {};
}

function readString(value) {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function extractCoverUrl(...sources) {
  for (const source of sources) {
    const record = asRecord(source);
    const direct =
      readString(record.coverUrl) ??
      readString(record.cover) ??
      readString(record.bookCoverUrl) ??
      readString(record.bookCover);
    if (direct) {
      return direct;
    }
  }

  return null;
}

function progressValue(progress) {
  return progress?.book?.progress ?? null;
}

function finishTimeValue(progress) {
  return progress?.book?.finishTime ?? null;
}

function normalizeAuth(auth) {
  const vid = String(auth?.vid ?? auth?.webLoginVid ?? '');
  const skey = String(auth?.skey ?? auth?.accessToken ?? '');
  if (!vid || !skey) {
    throw new Error('Missing auth. Expected auth.vid and auth.skey.');
  }

  return { vid, skey };
}

function notebookBookToIndex(entry) {
  const book = asRecord(entry?.book);
  const bookId = readString(book.bookId);
  if (!bookId) {
    return null;
  }

  return {
    bookId,
    title: readString(book.title) ?? '未命名书籍',
    author: readString(book.author) ?? '',
    coverUrl: extractCoverUrl(book),
    noteCount: entry.noteCount ?? 0,
    reviewCount: entry.reviewCount ?? 0,
    sort: entry.sort ?? 0
  };
}

async function mapWithConcurrency(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker())
  );

  return results;
}

export async function checkAuth(auth) {
  let normalizedAuth;
  try {
    normalizedAuth = normalizeAuth(auth);
  } catch {
    return {
      authenticated: false,
      valid: false,
      reason: 'Missing auth'
    };
  }

  try {
    const { vid, skey } = normalizedAuth;
    await fetchUserInfo(vid, skey);
    return {
      authenticated: true,
      valid: true,
      reason: null
    };
  } catch (error) {
    return {
      authenticated: true,
      valid: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function enrichLoginAuth(result) {
  const vid = String(result.webLoginVid ?? '');
  const skey = String(result.accessToken ?? '');
  let userInfo = null;

  if (vid && skey) {
    try {
      userInfo = await fetchUserInfo(vid, skey);
    } catch {
      userInfo = null;
    }
  }

  return {
    vid,
    skey,
    refreshToken: result.refreshToken ? String(result.refreshToken) : undefined,
    loginAt: new Date().toISOString(),
    userInfo
  };
}

export async function createBooksIndex(options) {
  const { vid, skey } = normalizeAuth(options?.auth);
  const syncedAt = new Date().toISOString();
  const notebookEntries = await fetchNotebookList(vid, skey);
  const books = notebookEntries
    .map((entry) => notebookBookToIndex(entry))
    .filter(Boolean)
    .sort((left, right) => right.sort - left.sort);

  return {
    ok: true,
    version: 2,
    syncedAt,
    totalBooks: notebookEntries.length,
    bookCount: books.length,
    books
  };
}

export async function createBookDetail(options) {
  const { vid, skey } = normalizeAuth(options?.auth);
  const bookId = readString(options?.bookId);
  if (!bookId) {
    throw new Error('Missing bookId.');
  }

  const syncedAt = new Date().toISOString();
  const bookMeta = asRecord(options?.book);
  const [bookInfo, progress, bookmarks, reviews] = await Promise.all([
    fetchBookInfo(vid, skey, bookId),
    fetchBookProgress(vid, skey, bookId),
    fetchBookmarkList(vid, skey, bookId),
    fetchReviewList(vid, skey, bookId)
  ]);
  const readingProgress = progressValue(progress);
  const finishTime = finishTimeValue(progress);
  const status = classifyReadingStatus(readingProgress, finishTime);
  const bookInfoRecord = {
    ...bookMeta,
    ...asRecord(bookInfo),
    bookId
  };
  const coverUrl = extractCoverUrl(bookInfoRecord, bookMeta);
  const intro = readString(bookInfoRecord.intro) ?? '';
  const markdown = renderBookMarkdown({
    syncedAt,
    bookInfo: {
      ...bookInfoRecord,
      bookId,
      title: readString(bookInfoRecord.title) ?? readString(bookMeta.title) ?? '未命名书籍',
      author: readString(bookInfoRecord.author) ?? readString(bookMeta.author) ?? '',
      intro,
      coverUrl
    },
    progress,
    bookmarks,
    reviews,
    status,
    noteCount: options?.noteCount ?? bookMeta.noteCount ?? 0,
    reviewCount: options?.reviewCount ?? bookMeta.reviewCount ?? 0
  });

  return {
    ok: true,
    version: DETAIL_CACHE_VERSION,
    syncedAt,
    book: {
      bookId,
      title: readString(bookInfoRecord.title) ?? readString(bookMeta.title) ?? '未命名书籍',
      author: readString(bookInfoRecord.author) ?? readString(bookMeta.author) ?? '',
      intro,
      coverUrl,
      status,
      progress: readingProgress,
      finishTime,
      noteCount: options?.noteCount ?? bookMeta.noteCount ?? 0,
      reviewCount: options?.reviewCount ?? bookMeta.reviewCount ?? 0,
      sort: options?.sort ?? bookMeta.sort ?? 0,
      syncedAt,
      markdown,
      html: renderMarkdownToHtml(markdown)
    }
  };
}

export async function createSnapshot(options) {
  const { vid, skey } = normalizeAuth(options?.auth);

  const includeStatuses = parseIncludeStatuses(options.includeStatuses);
  const syncedAt = new Date().toISOString();
  const notebookEntries = await fetchNotebookList(vid, skey);
  const filteredEntries = options.bookId
    ? notebookEntries.filter((entry) => entry.book?.bookId === options.bookId)
    : notebookEntries;

  const candidates = await mapWithConcurrency(filteredEntries, 6, async (entry) => {
    const bookId = entry.book.bookId;
    const progress = await fetchBookProgress(vid, skey, bookId);
    const readingProgress = progressValue(progress);
    const finishTime = finishTimeValue(progress);
    const status = classifyReadingStatus(readingProgress, finishTime);

    return {
      bookId,
      title: entry.book.title,
      author: entry.book.author,
      bookMeta: asRecord(entry.book),
      noteCount: entry.noteCount ?? 0,
      reviewCount: entry.reviewCount ?? 0,
      sort: entry.sort ?? 0,
      status,
      progress: readingProgress,
      finishTime
    };
  });

  const includedCandidates = candidates.filter((candidate) => includeStatuses.includes(candidate.status));
  const books = await mapWithConcurrency(includedCandidates, 4, async (candidate) => {
    const [bookInfo, progress, bookmarks, reviews] = await Promise.all([
      fetchBookInfo(vid, skey, candidate.bookId),
      fetchBookProgress(vid, skey, candidate.bookId),
      fetchBookmarkList(vid, skey, candidate.bookId),
      fetchReviewList(vid, skey, candidate.bookId)
    ]);

    const bookInfoRecord = {
      ...candidate.bookMeta,
      ...asRecord(bookInfo)
    };
    const coverUrl = extractCoverUrl(bookInfoRecord, candidate.bookMeta);
    const markdown = renderBookMarkdown({
      syncedAt,
      bookInfo: {
        ...bookInfoRecord,
        bookId: candidate.bookId,
        title: bookInfoRecord.title ?? candidate.title,
        author: bookInfoRecord.author ?? candidate.author,
        coverUrl
      },
      progress,
      bookmarks,
      reviews,
      status: candidate.status,
      noteCount: candidate.noteCount,
      reviewCount: candidate.reviewCount
    });

    return {
      bookId: candidate.bookId,
      title: readString(bookInfoRecord.title) ?? candidate.title,
      author: readString(bookInfoRecord.author) ?? candidate.author ?? '',
      coverUrl,
      status: candidate.status,
      progress: progressValue(progress) ?? candidate.progress,
      finishTime: finishTimeValue(progress) ?? candidate.finishTime,
      noteCount: candidate.noteCount,
      reviewCount: candidate.reviewCount,
      sort: candidate.sort,
      syncedAt,
      markdown,
      html: renderMarkdownToHtml(markdown)
    };
  });

  books.sort((left, right) => right.sort - left.sort);

  return {
    ok: true,
    version: 1,
    syncedAt,
    includeStatuses,
    totalBooks: notebookEntries.length,
    bookCount: books.length,
    books
  };
}
