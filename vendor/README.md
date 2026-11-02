# vendor/hana-app-sdk

本机宿主导出的 App SDK 快照，是 `package.json` 里 `@hana/app-sdk` 的 `file:` 依赖真身。

```
hana-app-sdk.tgz         @hana/app-sdk 打包产物（dist 的 tar 包）
source-manifest.json     宿主打包时写的账：packedVersion + 各源文件 sha256
```

只用得上 `@hana/app-sdk` 一个包：服务端入口只要 `defineApp`（包内 `./server`），浏览器侧只要
`./ui` 那份 bundle。`@hana/plugin-sdk`、`@hana/plugin-protocol`、`@hana/plugin-components`
是给「借用宿主组件、自己写 React 设置页」的 App 用的，苔室没引，所以同目录下没有它们的 tgz。
`source-manifest.json` 保持宿主原样，作为来源证据。

## 上下游

```
宿主 artifacts/server/<版本>/skills2set/hana-app-creator/assets/sdk
        │  pnpm run sync:sdk        scripts/vendor/sdk.mjs
        ▼
vendor/hana-app-sdk/  ──file:──▶  node_modules/@hana/app-sdk
        │                                │  pnpm run derive
        │                                ▼
        └────────────────────▶  app/sdk/ + app/ui/assets/ 里的浏览器侧副本
                                 （gitignore，不入库，装包时随 app/ 一起进包）
```

三个约束：

- 快照换内容后，`pnpm install` 不会自己重解析（它按 specifier 路径判有效性，不读 tarball）。
  要按包名点名：`pnpm update @hana/app-sdk && pnpm install`。跑 `sync:sdk` 会检查锁文件并提示。
- `scripts/derive.mjs` 会核对依赖树里的版本与 `packedVersion` 相等，不等就拒绝展开，
  免得装出来的包带着上一个大版本的 SDK。
- 这两份文件都不要手改。要换版本走 `sync:sdk`，要改内容走上游。
