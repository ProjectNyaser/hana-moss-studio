// 苔室实时通道：订阅 /hana-moss-studio/events 的 SSE 状态流。
// 连不上或宿主把响应缓冲了（首帧迟迟不到）就退化成轮询，界面不至于停在旧数据上。
//
// 连接池只有六个位子，一条 SSE 占一个，永远不会自己空出来。所以这里的铁律是：
// 任何时刻最多一条流。退化、重连、出错都必须先把旧的那条 cancel 掉再开新的，
// 否则半开的流会和轮询一起挂着，越攒越多，把池子占满。

const API = "/hana-moss-studio";
const ROUTE_BASE = "/api/apps/hana-moss-studio/routes";
const FIRST_FRAME_TIMEOUT_MS = 10000;
const RECONNECT_DELAY_MS = 2500;
const FALLBACK_POLL_MS = 5000;
/** 退化到轮询后隔多久再试一次真流式。 */
const SSE_RETRY_MS = 45_000;
/** 连上活不过这个时长，就当这条路不通，不用每两秒再试一次。 */
const SHORT_LIVED_MS = 30_000;

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
  let connecting = false;
  let degraded = false;
  /** 连续短命连接计数：达到三次就判定流式这条路不通。 */
  let shortLived = 0;
  /** 重试窗口的退避倍数。 */
  let retryRound = 0;

  /** 掐掉当前这条流。重复调用无害。 */
  function stopReader() {
    const current = reader;
    reader = null;
    if (!current) return;
    try {
      void current.cancel();
    } catch {
      /* 已经断了 */
    }
  }

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
    // 先掐流再轮询：半开的连接留着，就和轮询一起占位子。
    stopReader();
    poll();
    pollTimer = setInterval(() => {
      if (!document.hidden) poll();
    }, FALLBACK_POLL_MS);
    // 轮询只是兜底。一次开流失败不代表以后都不行，过一阵再试一次真流式。
    clearTimeout(retryTimer);
    retryRound = Math.min(retryRound + 1, 4);
    retryTimer = setTimeout(() => {
      if (disposed) return;
      clearInterval(pollTimer);
      pollTimer = null;
      degraded = false;
      void connect();
    }, SSE_RETRY_MS * 2 ** (retryRound - 1));
  }

  async function connect() {
    if (disposed || degraded || connecting) return;
    connecting = true;
    // 进新连接之前先确保旧的那条已经关掉。
    stopReader();
    const startedAt = Date.now();
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
          if (firstFrame) {
            clearTimeout(firstFrame);
            firstFrame = null;
          }
          if (name === "state") onState(payload);
          else onEvent?.(name, payload);
        }
      }
    } catch (error) {
      onError?.(error);
    } finally {
      if (firstFrame) clearTimeout(firstFrame);
      connecting = false;
    }
    if (disposed || degraded) return;
    stopReader();
    // 宿主那层会把流截断（实测一条十五秒）。拦不住的断没关系，但连上就没命、
    // 两秒半后又开一条的，就不该继续试了，那是白占连接。
    if (Date.now() - startedAt < SHORT_LIVED_MS) {
      shortLived += 1;
      if (shortLived >= 3) {
        degrade(new Error("事件流活不长，改用轮询"));
        return;
      }
    } else {
      shortLived = 0;
      retryRound = 0;
    }
    retryTimer = setTimeout(connect, RECONNECT_DELAY_MS);
  }

  void connect();

  return () => {
    disposed = true;
    clearTimeout(retryTimer);
    clearInterval(pollTimer);
    stopReader();
  };
}
