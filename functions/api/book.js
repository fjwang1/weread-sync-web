import { createBookDetail } from '../../src/shared/sync.js';
import { errorJson, json, readJson } from './_shared.js';

export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request);
    const detail = await createBookDetail(body);
    return json(detail);
  } catch (error) {
    const status = error?.code === 'AUTH_EXPIRED' ? 401 : 500;
    return errorJson(error, status);
  }
}
