const pending = new Map();

globalThis.window?.openidea?.onMessage?.(text => {
  let reply;
  try {
    reply = JSON.parse(text);
  } catch {
    return;
  }
  const finish = pending.get(reply?.id);
  finish?.(reply);
});

export async function duckdb(request, fileAction) {
  const api = window.openidea;
  if (fileAction && typeof api?.documentFileAction !== "function") {
    throw new Error("This action needs an OpenIDEA build with Parquet file dialogs.");
  }
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  const text = JSON.stringify({ ...request, id });
  const reply = new Promise(resolve => pending.set(id, resolve));
  let timer;
  try {
    if (fileAction) {
      const chosen = await api.documentFileAction({ ...fileAction, text });
      if (!chosen) return null;
    } else {
      api.postMessage(text);
    }
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => resolve({ error: "DuckDB did not return a result. Check the plugin's permissions and try again." }), 65_000);
    });
    const response = await Promise.race([reply, timeout]);
    if (response.error) throw new Error(response.error);
    return response.result;
  } finally {
    clearTimeout(timer);
    pending.delete(id);
  }
}
