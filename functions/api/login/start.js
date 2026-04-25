import QRCode from 'qrcode';

import { getConfirmUrl, getLoginUid } from '../../../src/shared/wereadClient.js';
import { errorJson, json } from '../_shared.js';

export async function onRequestPost() {
  try {
    const result = await getLoginUid();
    if (!result.uid) {
      throw new Error('Missing uid from login response');
    }

    const confirmUrl = getConfirmUrl(result.uid);
    const qrDataUrl = await QRCode.toDataURL(confirmUrl, {
      width: 320,
      margin: 2
    });

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
