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

export async function duckdb(request) {
  const id = Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join("");
  let timer;
  try {
    const response = await new Promise(resolve => {
      const startTimeout = () => setTimeout(() => resolve({ error: "DuckDB did not return a result. Check the plugin's permissions and try again." }), 65_000);
      timer = startTimeout();
      pending.set(id, reply => {
        clearTimeout(timer);
        if (reply.phase === "running") timer = startTimeout();
        else if (reply.phase !== "picking") resolve(reply);
      });
      window.openidea.postMessage(JSON.stringify({ ...request, id }));
    });
    if (response.error) throw new Error(response.error);
    return response.result;
  } finally {
    clearTimeout(timer);
    pending.delete(id);
  }
}
