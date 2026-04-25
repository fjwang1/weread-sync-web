export function json(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...(init.headers ?? {})
    }
  });
}

export function errorJson(error, status = 500) {
  return json(
    {
      ok: false,
      error: {
        code: error?.code ?? 'API_ERROR',
        message: error instanceof Error ? error.message : String(error)
      }
    },
    { status }
  );
}

export async function readJson(request) {
  const text = await request.text();
  return text.trim() ? JSON.parse(text) : {};
}
