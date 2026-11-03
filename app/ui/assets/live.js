// 苔室实时通道。
//
// 首选 SSE：一条长连接，服务端推。实测这条能稳住（Network 里那条 src 一直在，
// 末尾标「尚未完成请求」），之前看着断得勤是面板抢跑：自己先开一条流，等广播来
// 了才关，两条一起占连接池。现在侧栏不再开流，只吃主界面的同源广播。
//
// 退化仍然保留，但不是常态，是兜底：
//
//   有任务在跑（生成 / 排队 / 下载）    1.5 秒一次
//   空闲                              10 秒一次
//
// 每条流只留一条，任何时刻不多开。活不过 30 秒的连接连续三次就判定这条路不通，
// 重试窗口按 45s / 90s / 180s / 360s 退避。

const API = "/hana-moss-studio";
const ROUTE_BASE = "/api/apps/hana-moss-studio/routes";
const FIRST_FRAME_TIMEOUT_MS = 10000;
const RECONNECT_DELAY_MS = 2500;
/** 有活儿时的轮询间隔。 */
const POLL_ACTIVE_MS = 1500;
/** 空闲时的轮询间隔。 */
const POLL_IDLE_MS = 10000;
/** 退化到轮询后隔多久再试一次真流式。 */
const SSE_RETRY_MS = 45_000;
/** 连上活不过这个时长，就当这条路不通。 */
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

/**
 * 缩略图地址。画廊一屏几十张，原图一张几 MB，这里走服务端缩好的 WebP。
 * @param {string} name 输出文件名
 * @param {number} [size] 宽度像素
 */
export function thumbUrl(name, size = 320) {
  const url = new URL(`${ROUTE_BASE}${API}/thumb`, location.origin);
  url.searchParams.set("name", name);
  url.searchParams.set("size", String(size));
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

export function startLive({ hana, onState, onEvent, fetchState, onError }) {
  let disposed = false;
  let retryTimer = null;
  let pollTimer = null;
  let reader = null;
  let connecting = false;
  let degraded = false;
  /** 连续短命连接计数：达到三次就判定流式这条路不通。 */
  let shortLived = 0;
  /** 重试窗口的退避轮数。 */
  let retryRound = 0;
  /** 最近一帧，用来判断有没有活儿在跑，决定轮询多勤。 */
  let lastState = null;

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

  /** 有没有活儿：生成中、队列非空、下载没结束，任一成立就算忙。 */
  function busy() {
    if (!lastState) return false;
    if (lastState.engine?.active) return true;
    if (Array.isArray(lastState.queue) && lastState.queue.length) return true;
    return Array.isArray(lastState.installs) && lastState.installs.some((item) => !item.finishedAt);
  }

  function poll() {
    if (disposed || !fetchState) return Promise.resolve();
    return fetchState()
      .then((state) => {
        if (disposed || !state) return;
        lastState = state;
        onState(state);
      })
      .catch((error) => onError?.(error));
  }

  function schedulePoll() {
    clearTimeout(pollTimer);
    if (disposed || !degraded) return;
    pollTimer = setTimeout(() => {
      if (disposed) return;
      // 上一轮结束再排下一轮。宿主慢的时候请求会超过间隔，不串行就会叠着跑。
      const round = document.hidden ? Promise.resolve() : poll();
      void round.then(() => {
        if (!disposed) schedulePoll();
      });
    }, busy() ? POLL_ACTIVE_MS : POLL_IDLE_MS);
  }

  function degrade(error) {
    if (degraded || disposed) return;
    degraded = true;
    onError?.(error);
    // 先掐流再轮询：半开的连接留着，就和轮询一起占位子。
    stopReader();
    poll();
    schedulePoll();
    // 流式只是首选，不是唯一。过一阵再试一次，通了就回到推的模式。
    clearTimeout(retryTimer);
    retryRound = Math.min(retryRound + 1, 4);
    retryTimer = setTimeout(() => {
      if (disposed) return;
      clearTimeout(pollTimer);
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
      const response = await hana.api.fetch(`${API}/events`, {
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
          if (name === "state") {
            lastState = payload;
            onState(payload);
          } else onEvent?.(name, payload);
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
    clearTimeout(pollTimer);
    stopReader();
  };
}
