import { enrichLoginAuth } from '../../../src/shared/sync.js';
import { waitForLogin } from '../../../src/shared/wereadClient.js';
import { errorJson, json } from '../_shared.js';

function isLoggedIn(result) {
  return Boolean(result?.succeed && result.webLoginVid && result.accessToken);
}

export async function onRequestGet(context) {
  const uid = new URL(context.request.url).searchParams.get('uid');
  if (!uid) {
    return errorJson(new Error('Missing uid'), 400);
  }

  try {
    const result = await waitForLogin(uid, 25_000);
    if (!isLoggedIn(result)) {
      return json({
        ok: true,
        status: 'waiting',
        reason: result?.logicCode ?? 'waiting'
      });
    }

    return json({
      ok: true,
      status: 'logged-in',
      auth: await enrichLoginAuth(result)
    });
  } catch (error) {
    if (error?.code === 'REQUEST_TIMEOUT' || error?.code === 'NETWORK_ERROR') {
      return json({
        ok: true,
        status: 'waiting',
        reason: error.code
      });
    }

    return errorJson(error);
  }
}
