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
  const vid = String(auth?.vid ?? auth?.webLoginVid ?? '');
  const skey = String(auth?.skey ?? auth?.accessToken ?? '');

  if (!vid || !skey) {
    return {
      authenticated: false,
      valid: false,
      reason: 'Missing auth'
    };
  }

  try {
    await fetchNotebookList(vid, skey);
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

export async function createSnapshot(options) {
  const auth = options?.auth ?? {};
  const vid = String(auth.vid ?? auth.webLoginVid ?? '');
  const skey = String(auth.skey ?? auth.accessToken ?? '');
  if (!vid || !skey) {
    throw new Error('Missing auth. Expected auth.vid and auth.skey.');
  }

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
