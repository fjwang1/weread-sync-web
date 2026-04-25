import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { createSnapshot } from '../src/shared/sync.js';
import { fetchNotebookList } from '../src/shared/wereadClient.js';

async function readAuth() {
  if (process.env.WEREAD_VID && process.env.WEREAD_SKEY) {
    return {
      vid: process.env.WEREAD_VID,
      skey: process.env.WEREAD_SKEY
    };
  }

  const authFile = path.join(
    os.homedir(),
    'Library',
    'Application Support',
    'WereadSync',
    'auth',
    'auth.json'
  );
  const auth = JSON.parse(await fs.readFile(authFile, 'utf8'));
  return {
    vid: auth.webLoginVid,
    skey: auth.accessToken
  };
}

const auth = await readAuth();
const bookId = process.argv[2] || (await fetchNotebookList(auth.vid, auth.skey))[0]?.book?.bookId;
if (!bookId) {
  throw new Error('No notebook book found for verification.');
}

const startedAt = Date.now();
const snapshot = await createSnapshot({
  auth,
  bookId,
  includeStatuses: ['reading', 'finished', 'other']
});
const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
const book = snapshot.books[0];

console.log(JSON.stringify({
  ok: true,
  elapsedSeconds,
  bookCount: snapshot.books.length,
  book: book
    ? {
        bookId: book.bookId,
        title: book.title,
        author: book.author,
        status: book.status,
        progress: book.progress,
        htmlLength: book.html.length,
        markdownLength: book.markdown.length,
        hasCoverUrl: Boolean(book.coverUrl)
      }
    : null
}, null, 2));
