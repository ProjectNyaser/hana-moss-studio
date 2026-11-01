// 宿主把主题当成一份 CSS 交过来：面 URL 上带着 hana-css / hana-theme-appearance，
// 但不会替页面把这份 CSS 插进文档。不自己加载，--bg、--sidebar-bg 这些就全是空的，
// 页面只能落到 hana-theme.css 里的本地兜底色。
//
// 这段必须是非 module 的同步脚本，而且放在样式表之前跑：先让 :root 上有变量，
// 首帧才不会是兜底配色。
(function () {
  var params = new URLSearchParams(location.search);
  var css = params.get("hana-css");

  if (css) {
    var link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = css;
    link.dataset.hanaTheme = "host";
    document.head.appendChild(link);
  }

  if (params.get("hana-theme-appearance") === "dark") {
    document.documentElement.classList.add("t-dark");
  }
})();
