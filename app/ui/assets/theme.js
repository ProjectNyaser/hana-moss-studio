// 明暗判定。URL 上的 hana-theme-appearance 是宿主当场给的外观，最可信；
// 没有这个参数时才问 SDK 快照，最后才退到系统偏好。
// 三处界面（侧栏、工作区、任务卡）共用这一份，别各写一套。
export function applyTheme(hana) {
  const params = new URLSearchParams(location.search);
  let dark = false;

  if (params.has("hana-theme-appearance")) {
    dark = params.get("hana-theme-appearance") === "dark";
  } else {
    let snapshot = null;
    try {
      snapshot = hana?.theme?.getSnapshot?.() ?? null;
    } catch {
      snapshot = null;
    }
    const label = String(snapshot?.theme ?? "");
    dark = snapshot?.appearance === "dark" || /dark|midnight|contrast|深|夜/i.test(label);
    if (!snapshot?.appearance && (!label || label === "inherit")) {
      dark = Boolean(window.matchMedia?.("(prefers-color-scheme: dark)").matches);
    }
  }

  document.documentElement.classList.toggle("t-dark", dark);
  document.body.classList.toggle("t-dark", dark);
  return dark;
}
