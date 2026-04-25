import { createSnapshot } from '../../src/shared/sync.js';
import { errorJson, json, readJson } from './_shared.js';

export async function onRequestPost(context) {
  try {
    const body = await readJson(context.request);
    const snapshot = await createSnapshot(body);
    return json(snapshot);
  } catch (error) {
    const status = error?.code === 'AUTH_EXPIRED' ? 401 : 500;
    return errorJson(error, status);
  }
}
