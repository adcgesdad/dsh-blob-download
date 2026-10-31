# dsh-blob-download

给 [DeepSeek Harness](https://github.com/deepseek-ai) 用的下载工具插件：在 DSH 浏览器里用 `blob:` 方案下载文件，绕过迅雷等下载扩展的劫持。

Download files inside the DSH browser through a `blob:` URL, so download-hijacking extensions (Thunder/迅雷 等) never see a `chrome.downloads` event.

## 解决什么问题

迅雷「下载支持」扩展（`popomkonnjgcdagdhgcpcekbdeoibglc`）会监听
`chrome.downloads`，把浏览器的下载 `cancel` 掉，再经 nativeMessaging 交给
迅雷客户端建任务——于是你在 DSH 里让 agent 下个文件，弹出来的却是迅雷的
「新建下载任务」窗口。

但这类扩展在决策函数里通常明确排除了 `blob:` / `data:` 协议，因为 blob 无法
可靠地交给外部下载器重下。迅雷 v4.1.5 的 `bd()` 第一条就是：

```js
if (vd.has(new URL(url).protocol)) return false;
// vd = Set(["blob:", "data:", "chrome-extension:", "file:"])
```

所以在页面内走一遍 `fetch → Blob → createObjectURL → <a download>.click()`
就能让文件老老实实走浏览器自己的下载管线，不触发扩展。

## 为什么不用 `dsh_browser_download`

DSH 自带的 `dsh_browser_download` 走 provider 的原生下载通道，而**桌面端
（desktop shell）不支持它**：

```
browser: download is only available on the self-hosted browser
```

本插件改走页面内 blob 方案，桌面端同样可用。

## 安装

插件要求 DSH **0.2.1-rc.5 或更高**，并且 profile 里装了
[`dsh-builtin-browser`](https://github.com/wqty123/dsh-browser)（浏览器工具
`dsh_browser_*` 的来源，插件要用它的 `browser` 服务）。

**方式一：插件页安装（推荐）**

Web 侧边栏 → **插件** → 安装，填包名 `dsh-blob-download`（或本仓库的 git
地址）。装完重启 DSH。

**方式二：手动**

```bash
cd ~/.dsh/profiles/desktop      # 或 profiles/web
pnpm add dsh-blob-download
```

然后在同一个 `package.json` 里把包名追加进 bundle 列表：

```json
{
  "dependencies": { "dsh-blob-download": "^0.1.0" },
  "dsh": { "profile": { "bundles": ["dsh-builtin-browser", "dsh-blob-download"] } }
}
```

重启 DSH 生效。

**方式三：本地源码**

```bash
git clone https://github.com/adcgesdad/dsh-blob-download.git ~/.dsh/plugin-src/dsh-blob-download
cd ~/.dsh/profiles/desktop
pnpm add link:~/.dsh/plugin-src/dsh-blob-download
```

同样把 `dsh-blob-download` 追加进 `dsh.profile.bundles`，重启。

## 工具：`blob_download`

| 参数 | 必填 | 说明 |
|---|---|---|
| `url` | 是 | 要下载的 URL（http/https） |
| `fileName` | 否 | 保存的文件名，不传就从 URL 末段推断 |
| `saveDir` | 否 | 保存目录（绝对路径），不传用配置或系统下载目录 |
| `waitSeconds` | 否 | 等待落盘的秒数，默认 30，上限 300 |

返回：

```ts
{ ok: boolean, message: string, path?: string, bytes?: number, fileName?: string, verified?: boolean }
```

`verified: true` 表示宿主真的在目标目录里看到了大小相符的新文件，不只是
「点了一下下载链接」。

## 行为细节

- **一次只下一个**：浏览器对并发触发多个下载会弹「允许下载多个文件」确认框，
  未确认前后续下载被挂起，看起来就像失败。插件内部串行排队，一个下完（无论
  成败）才轮到下一个。
- **先落目录再下**：下载前会把会话导航到目标 URL 的 origin 根路径，让页面内
  `fetch` 是同源请求（同站资源不受 CORS 限制）。注意不能直接 `openUrl` 目标
  文件——那会先触发一次真正的浏览器下载，正好喂给迅雷。
- **文件名消毒**：去掉 Windows 不允许的字符和路径穿越段；重名自动加 ` (1)`
  后缀。
- **会删空目录**：不会。插件只读目录，不清理也不移动文件。

## 配置

`cordis.patch.yml` 里可改：

```yaml
- insert:
    - id: blob-download
      name: 'dsh-blob-download'
      config:
        downloadDir: ''      # 默认目标目录，留空用系统下载目录
        timeoutMs: 120000    # 单次等待上限（毫秒）
```

## 已知限制

- 只支持 http/https。`file:`、`data:` 等协议会被拒绝。
- 依赖页面能 `fetch` 到目标 URL。有反爬或需要特殊 header 的站点可能取不到字节。
- 目标站点若禁止跨源读取（没给 CORS 头）且文件不在同站，`fetch` 会失败。
- 需要 `browser` 服务在场：没装 `dsh-builtin-browser` 时工具会直接报错。

## 许可

[MIT](LICENSE)