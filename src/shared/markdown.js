function formatTimestamp(timestamp) {
  if (!timestamp) {
    return '';
  }

  return new Date(timestamp * 1000).toISOString().replace('T', ' ').slice(0, 19);
}

function yamlEscape(value) {
  return `"${String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function safeText(value) {
  return String(value ?? '').trim();
}

function formatTimeLine(timestamp) {
  const formatted = formatTimestamp(timestamp);
  return formatted ? `> ⏱ ${formatted}` : '';
}

function groupHighlightsByChapter(bookmarks) {
  const chapterMap = new Map();
  for (const highlight of bookmarks?.updated ?? []) {
    if (!safeText(highlight.markText)) {
      continue;
    }

    const chapterInfo = (bookmarks?.chapters ?? []).find(
      (chapter) => chapter.chapterUid === highlight.chapterUid
    );
    const chapterUid = highlight.chapterUid ?? -1;
    const existing = chapterMap.get(chapterUid) ?? {
      chapterIdx: chapterInfo?.chapterIdx ?? chapterUid,
      chapterTitle: chapterInfo?.title ?? `Chapter ${chapterUid}`,
      items: []
    };

    existing.items.push(highlight);
    chapterMap.set(chapterUid, existing);
  }

  return [...chapterMap.values()].sort((left, right) => left.chapterIdx - right.chapterIdx);
}

function renderHighlights(bookmarks) {
  const chapters = groupHighlightsByChapter(bookmarks);
  if (chapters.length === 0) {
    return '';
  }

  const lines = [];
  for (const chapter of chapters) {
    lines.push(`## ${chapter.chapterTitle}`);
    lines.push('');
    for (const highlight of chapter.items) {
      lines.push(`> 📌 ${safeText(highlight.markText)}`);
      const timeLine = formatTimeLine(highlight.createTime);
      if (timeLine) {
        lines.push(timeLine);
      }
      lines.push('');
    }
  }

  return lines.join('\n').trim();
}

function findBookmarkForReview(review, bookmarks) {
  if (!review) {
    return undefined;
  }

  return (bookmarks?.updated ?? []).find((bookmark) => {
    if (review.range && bookmark.range === review.range) {
      return true;
    }

    return Boolean(
      review.chapterUid &&
      bookmark.chapterUid === review.chapterUid &&
      review.abstract &&
      bookmark.markText?.includes(review.abstract)
    );
  });
}

function renderChapterReviews(reviews, bookmarks) {
  const chapterReviews = (reviews?.reviews ?? [])
    .map((item) => item.review)
    .filter((review) => review && review.type === 1 && safeText(review.content));

  if (chapterReviews.length === 0) {
    return '';
  }

  return chapterReviews
    .map((review) => {
      const matchedBookmark = findBookmarkForReview(review, bookmarks);
      const highlightText = safeText(review?.abstract) || safeText(matchedBookmark?.markText);
      const lines = [];

      if (highlightText) {
        lines.push(`> 📌 ${highlightText}`);
      }

      lines.push(`> 💭 ${safeText(review?.content)}`);
      const formattedTime = formatTimestamp(review?.createTime);
      if (formattedTime) {
        lines.push(`> ⏱ ${formattedTime}`);
      }

      return lines.join('\n').trim();
    })
    .join('\n\n');
}

function renderBookReviews(reviews) {
  const bookReviews = (reviews?.reviews ?? [])
    .map((item) => item.review)
    .filter((review) => review && review.type === 4 && safeText(review.content));

  if (bookReviews.length === 0) {
    return '';
  }

  return bookReviews
    .map((review, index) => {
      const lines = [`## 书评 ${index + 1}`, '', safeText(review?.content)];
      const formattedTime = formatTimestamp(review?.createTime);
      if (formattedTime) {
        lines.push(`⏱ ${formattedTime}`);
      }

      return lines.join('\n');
    })
    .join('\n\n');
}

export function renderBookMarkdown(input) {
  const progress = input.progress?.book?.progress ?? null;
  const intro = String(input.bookInfo?.intro ?? '').replace(/\r?\n+/g, ' ').trim();
  const highlights = renderHighlights(input.bookmarks);
  const chapterReviews = renderChapterReviews(input.reviews, input.bookmarks);
  const bookReviews = renderBookReviews(input.reviews);
  const frontmatter = [
    '---',
    `doc_type: "weread-sync-note"`,
    `source: "weread"`,
    `bookId: ${yamlEscape(input.bookInfo?.bookId)}`,
    `title: ${yamlEscape(input.bookInfo?.title)}`,
    `author: ${yamlEscape(input.bookInfo?.author)}`,
    `coverUrl: ${yamlEscape(input.bookInfo?.coverUrl ?? input.bookInfo?.cover)}`,
    `status: ${yamlEscape(input.status)}`,
    `progress: ${progress === null ? 'null' : progress}`,
    `noteCount: ${input.noteCount}`,
    `reviewCount: ${input.reviewCount}`,
    `lastSyncAt: ${yamlEscape(input.syncedAt)}`,
    '---',
    ''
  ];

  const body = [
    '# 简介',
    '',
    `- 书名：${input.bookInfo?.title ?? ''}`,
    `- 作者：${input.bookInfo?.author ?? ''}`,
    `- 分类：${input.bookInfo?.category ?? ''}`,
    `- 出版社：${input.bookInfo?.publisher ?? ''}`,
    `- ISBN：${input.bookInfo?.isbn ?? ''}`,
    `- 阅读状态：${input.status}`,
    `- 阅读进度：${progress === null ? '' : `${progress}%`}`,
    `- 同步时间：${input.syncedAt}`,
    `- 简介：${intro}`
  ];

  if (highlights) {
    body.push('', '# 高亮划线', '', highlights);
  }

  if (chapterReviews) {
    body.push('', '# 划线评论', '', chapterReviews);
  }

  if (bookReviews) {
    body.push('', '# 书评', '', bookReviews);
  }

  return [...frontmatter, ...body, ''].join('\n');
}

export function stripFrontmatter(markdown) {
  if (!markdown.startsWith('---')) {
    return markdown;
  }

  const endIndex = markdown.indexOf('\n---', 3);
  if (endIndex === -1) {
    return markdown;
  }

  const afterEnd = markdown.indexOf('\n', endIndex + 4);
  return afterEnd === -1 ? '' : markdown.slice(afterEnd + 1);
}

function splitTopLevelSections(markdown) {
  const sections = [];
  let current = {
    heading: null,
    lines: []
  };

  for (const line of markdown.split(/\r?\n/)) {
    const heading = /^#\s+(.+)$/.exec(line.trim());
    if (heading) {
      sections.push(current);
      current = {
        heading: heading[1].trim(),
        lines: [line]
      };
      continue;
    }

    current.lines.push(line);
  }

  sections.push(current);
  return sections.filter((section) => section.heading || section.lines.some((line) => line.trim()));
}

function isPlaceholderLine(line) {
  const text = line.trim();
  return text === '_无划线_' || text === '_无章节评论_' || text === '_无书评_' || text === '_空评论_';
}

function meaningfulLines(section) {
  return section.lines
    .slice(1)
    .map((line) => line.trim())
    .filter((line) => line && !isPlaceholderLine(line));
}

function isEmptyDemoSection(section) {
  if (!section.heading || section.heading === '元数据' || section.heading === '简介') {
    return false;
  }

  const lines = meaningfulLines(section);
  if (lines.length === 0) {
    return true;
  }

  if (section.heading.includes('划线评论') || section.heading.includes('章节 / 划线评论')) {
    return !lines.some((line) => /^>\s*📌/.test(line));
  }

  return false;
}

function isHighlightQuote(line) {
  return /^>\s*📌/.test(line);
}

function isCommentQuote(line) {
  return /^>\s*💭/.test(line);
}

function isTimeQuote(line) {
  return /^>\s*⏱/.test(line);
}

function lastNonEmptyLine(lines) {
  return [...lines].reverse().find((line) => line.trim())?.trim() ?? '';
}

function nextNonEmptyLine(lines, startIndex) {
  return lines.slice(startIndex).find((line) => line.trim())?.trim() ?? '';
}

function convertLegacyCommentLine(text) {
  const comment = /^-\s*💭\s*(.*)$/.exec(text);
  if (comment) {
    return `> 💭 ${comment[1]}`;
  }

  const time = /^-\s*⏱\s*(.*)$/.exec(text);
  if (time) {
    return `> ⏱ ${time[1]}`;
  }

  return null;
}

function normalizeSectionForDemo(section) {
  if (!section.heading?.includes('划线评论') && !section.heading?.includes('章节 / 划线评论')) {
    return section;
  }

  const lines = [];

  for (let index = 0; index < section.lines.length; index += 1) {
    const line = section.lines[index];
    const text = line.trim();

    if (!text) {
      const previous = lastNonEmptyLine(lines);
      const next = nextNonEmptyLine(section.lines, index + 1);
      if (isHighlightQuote(previous) && (/^-\s*💭/.test(next) || isCommentQuote(next))) {
        continue;
      }

      lines.push(line);
      continue;
    }

    if (isTimeQuote(text)) {
      const previous = lastNonEmptyLine(lines);
      if (!isCommentQuote(previous)) {
        continue;
      }
    }

    const convertedLine = convertLegacyCommentLine(text);
    if (convertedLine) {
      lines.push(convertedLine);
      continue;
    }

    lines.push(line);
  }

  return {
    ...section,
    lines
  };
}

export function prepareMarkdownForDemo(markdown) {
  const body = stripFrontmatter(markdown);
  const sections = splitTopLevelSections(body)
    .filter((section) => !isEmptyDemoSection(section))
    .map(normalizeSectionForDemo);
  return sections.map((section) => section.lines.join('\n').trim()).filter(Boolean).join('\n\n');
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderInline(value) {
  const withoutAnchors = value.replace(/\s+\^[a-zA-Z0-9_-]+/g, '');
  const escaped = escapeHtml(withoutAnchors);
  return escaped
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

export function renderMarkdownToHtml(markdown) {
  const lines = prepareMarkdownForDemo(markdown).split(/\r?\n/);
  const html = [];
  let paragraph = [];
  let inList = false;
  let inQuote = false;

  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };

  const closeQuote = () => {
    if (inQuote) {
      html.push('</blockquote>');
      inQuote = false;
    }
  };

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }

    closeList();
    closeQuote();
    html.push(`<p>${renderInline(paragraph.join(' '))}</p>`);
    paragraph = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      flushParagraph();
      closeList();
      closeQuote();
      continue;
    }

    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      closeQuote();
      const level = Math.min(heading[1].length + 1, 5);
      html.push(`<h${level}>${renderInline(heading[2].trim())}</h${level}>`);
      continue;
    }

    const quote = /^>\s?(.*)$/.exec(line);
    if (quote) {
      flushParagraph();
      closeList();
      if (!inQuote) {
        html.push('<blockquote>');
        inQuote = true;
      }
      if (quote[1].trim()) {
        html.push(`<p>${renderInline(quote[1])}</p>`);
      }
      continue;
    }

    const listItem = /^\s*-\s+(.+)$/.exec(line);
    if (listItem) {
      flushParagraph();
      closeQuote();
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${renderInline(listItem[1])}</li>`);
      continue;
    }

    paragraph.push(line.trim());
  }

  flushParagraph();
  closeList();
  closeQuote();

  return html.join('\n');
}
