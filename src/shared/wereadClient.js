const BASE_URL = 'https://weread.qq.com';

export class ApiError extends Error {
  constructor(message, code = 'API_ERROR', detail) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.detail = detail;
  }
}

function createCookieHeader(vid, skey) {
  return `wr_vid=${vid}; wr_skey=${skey}`;
}

export function getConfirmUrl(uid) {
  return `${BASE_URL}/web/confirm?uid=${encodeURIComponent(uid)}`;
}

async function readJsonResponse(path, response) {
  const text = await response.text();
  let json = null;

  if (text) {
    try {
      json = JSON.parse(text);
    } catch {
      throw new ApiError(`Expected JSON from ${path}`, 'INVALID_JSON', text.slice(0, 200));
    }
  }

  if (!response.ok) {
    throw new ApiError(
      response.status === 401 ? '登录已失效，请重新登录' : `HTTP ${response.status} for ${path}`,
      response.status === 401 ? 'AUTH_EXPIRED' : 'HTTP_ERROR',
      json
    );
  }

  const errCode = json?.errCode ?? json?.errcode;
  if (typeof errCode === 'number' && errCode < 0) {
    const message = json?.errMsg ?? json?.errmsg ?? `WeRead returned error ${errCode}`;
    throw new ApiError(message, errCode === -2010 || errCode === -2012 ? 'AUTH_EXPIRED' : 'WEREAD_ERROR', json);
  }

  return json;
}

export async function requestWereadJson(path, init = {}) {
  const controller = new AbortController();
  const timer =
    typeof init.timeoutMs === 'number'
      ? setTimeout(() => controller.abort(), init.timeoutMs)
      : undefined;

  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      method: 'GET',
      ...init,
      headers: {
        Accept: 'application/json, text/plain, */*',
        ...(init.headers ?? {})
      },
      signal: controller.signal
    });

    return await readJsonResponse(path, response);
  } catch (error) {
    if (error instanceof ApiError) {
      throw error;
    }

    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError(`Request timed out for ${path}`, 'REQUEST_TIMEOUT');
    }

    throw new ApiError(error instanceof Error ? error.message : String(error), 'NETWORK_ERROR');
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

export function getLoginUid() {
  return requestWereadJson('/api/auth/getLoginUid');
}

export function waitForLogin(uid, timeoutMs = 25_000) {
  const searchParams = new URLSearchParams({ uid });
  return requestWereadJson(`/api/auth/getLoginInfo?${searchParams.toString()}`, {
    timeoutMs
  });
}

export function fetchUserInfo(vid, skey, userVid = vid) {
  return requestWereadJson(`/api/userInfo?userVid=${encodeURIComponent(userVid)}`, {
    headers: {
      'x-vid': vid,
      'x-skey': skey
    }
  });
}

export async function fetchNotebookList(vid, skey) {
  const response = await requestWereadJson('/api/user/notebook', {
    headers: {
      'x-vid': vid,
      'x-skey': skey
    }
  });
  return response?.books ?? [];
}

export function fetchBookmarkList(vid, skey, bookId) {
  return requestWereadJson(`/web/book/bookmarklist?bookId=${encodeURIComponent(bookId)}`, {
    headers: {
      Cookie: createCookieHeader(vid, skey)
    }
  });
}

export function fetchReviewList(vid, skey, bookId) {
  return requestWereadJson(
    `/web/review/list?bookId=${encodeURIComponent(bookId)}&listType=11&mine=1&synckey=0`,
    {
      headers: {
        Cookie: createCookieHeader(vid, skey)
      }
    }
  );
}

export function fetchBookInfo(vid, skey, bookId) {
  return requestWereadJson(`/web/book/info?bookId=${encodeURIComponent(bookId)}`, {
    headers: {
      Cookie: createCookieHeader(vid, skey)
    }
  });
}

export function fetchBookProgress(vid, skey, bookId) {
  return requestWereadJson(`/web/book/getProgress?bookId=${encodeURIComponent(bookId)}`, {
    headers: {
      Cookie: createCookieHeader(vid, skey)
    }
  });
}
