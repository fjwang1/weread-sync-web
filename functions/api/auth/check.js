import { checkAuth } from '../../../src/shared/sync.js';
import { errorJson, json, readJson } from '../_shared.js';

export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request);
    const result = await checkAuth(body.auth ?? body);
    return json({
      ok: true,
      ...result
    });
  } catch (error) {
    return errorJson(error);
  }
}
