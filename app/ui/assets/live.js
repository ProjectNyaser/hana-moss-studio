// 苔室实时通道：订阅 /hana-moss-studio/events 的 SSE 状态流。
// 连不上或宿主把响应缓冲了（5 秒内收不到第一帧）就退化成轮询，界面不至于停在旧数据上。

const API = "/hana-moss-studio";
const ROUTE_BASE = "/api/apps/hana-moss-studio/routes";
const FIRST_FRAME_TIMEOUT_MS = 10000;
const RECONNECT_DELAY_MS = 2500;
const FALLBACK_POLL_MS = 5000;
/** 退化到轮询后隔多久再试一次真流式。 */
const SSE_RETRY_MS = 45_000;

/**
 * @param {object} options
 * @param {any} options.hana 宿主注入的 sdk 实例
 * @param {(state: any) => void} options.onState 收到一帧状态
 * @param {() => Promise<any>} [options.fetchState] 退化轮询时取状态的方式
 * @param {(error: unknown) => void} [options.onError]
 * @param {string} [options.source] 谁在订（日志用：card / panel / studio）
 */
/**
 * 输出图片的直接地址。带上宿主注入的 surface 会话（appSurfaceSession），
 * <img> 能直接取，拖到别处也是真实 URL；blob: 地址出了这个 iframe 就没人认。
 * @param {string} name 输出文件名
 */
export function outputUrl(name) {
  const url = new URL(`${ROUTE_BASE}${API}/output`, location.origin);
  url.searchParams.set("name", name);
  const session = new URLSearchParams(location.search).get("appSurfaceSession");
  if (session) url.searchParams.set("appSurfaceSession", session);
  return url.toString();
}

export function previewUrl(at) {
  const url = new URL(`${ROUTE_BASE}${API}/preview`, location.origin);
  if (at) url.searchParams.set("t", String(at));
  const session = new URLSearchParams(location.search).get("appSurfaceSession");
  if (session) url.searchParams.set("appSurfaceSession", session);
  return url.toString();
}

export function startLive({ hana, onState, onEvent, fetchState, onError, source }) {
  let disposed = false;
  let retryTimer = null;
  let pollTimer = null;
  let reader = null;
  let degraded = false;

  function poll() {
    if (disposed || !fetchState) return;
    void fetchState()
      .then((state) => {
        if (!disposed && state) onState(state);
      })
      .catch((error) => onError?.(error));
  }

  function degrade(error) {
    if (degraded || disposed) return;
    degraded = true;
    onError?.(error);
    poll();
    pollTimer = setInterval(() => {
      if (!document.hidden) poll();
    }, FALLBACK_POLL_MS);
    // 轮询只是兜底。一次开流失败就永久轮询的话，请求数会一直堆着；
    // 过一阵再试一次真流式，能连上就回到推的模式。
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (disposed) return;
      clearInterval(pollTimer);
      pollTimer = null;
      degraded = false;
      void connect();
    }, SSE_RETRY_MS);
  }

  async function connect() {
    if (disposed || degraded) return;
    // 连上之前也可能一直挂着（本机偶发 ENOBUFS），计时从发请求那一刻开始算。
    let firstFrame = setTimeout(() => degrade(new Error("事件流没有回帧")), FIRST_FRAME_TIMEOUT_MS);
    try {
      const response = await hana.api.fetch(`${API}/events${source ? `?src=${encodeURIComponent(source)}` : ""}`, {
        headers: { accept: "text/event-stream" },
        cache: "no-store",
      });
      if (!response.ok || !response.body) throw new Error(`事件流不可用（${response.status}）`);
      reader = response.body.getReader();

      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut;
        while ((cut = buffer.indexOf("\n\n")) >= 0) {
          const chunk = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          const lines = chunk.split("\n");
          const nameLine = lines.find((item) => item.startsWith("event:"));
          const dataLine = lines.find((item) => item.startsWith("data:"));
          if (!dataLine) continue;
          const name = nameLine ? nameLine.slice(6).trim() : "state";
          let payload;
          try {
            payload = JSON.parse(dataLine.slice(5).trim());
          } catch {
            continue; // 半帧或坏帧
          }
          clearTimeout(firstFrame);
          firstFrame = null;
          if (name === "state") onState(payload);
          else onEvent?.(name, payload);
        }
      }
    } catch (error) {
      if (firstFrame) clearTimeout(firstFrame);
      onError?.(error);
    }
    if (disposed || degraded) return;
    retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  }

  void connect();

  return () => {
    disposed = true;
    clearTimeout(retryTimer);
    clearInterval(pollTimer);
    try {
      void reader?.cancel();
    } catch {
      /* 已经断了 */
    }
  };
}
