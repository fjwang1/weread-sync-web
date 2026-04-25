import QRCode from 'qrcode';

import { getConfirmUrl, getLoginUid } from '../../../src/shared/wereadClient.js';
import { errorJson, json } from '../_shared.js';

async function createQrDataUrl(value) {
  const svg = await QRCode.toString(value, {
    type: 'svg',
    width: 320,
    margin: 2
  });
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export async function onRequestPost() {
  try {
    const result = await getLoginUid();
    if (!result.uid) {
      throw new Error('Missing uid from login response');
    }

    const confirmUrl = getConfirmUrl(result.uid);
    const qrDataUrl = await createQrDataUrl(confirmUrl);

    return json({
      ok: true,
      uid: result.uid,
      confirmUrl,
      qrDataUrl
    });
  } catch (error) {
    return errorJson(error);
  }
}
