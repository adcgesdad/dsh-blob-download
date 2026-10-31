/**
 * dsh-blob-download —— 走 blob: 协议的下载工具
 *
 * 为什么需要它：
 *   迅雷「下载支持」等下载劫持类扩展通常会监听 chrome.downloads，把浏览器的
 *   下载 cancel 掉再转交给自己的客户端。但这类扩展在决策函数里往往明确排除
 *   了 blob: / data: 协议（迅雷 v4.1.5 的 bd() 第一条就是
 *   `if (vd.has(url.protocol)) return false`），因为 blob 无法可靠地交给
 *   外部下载器重下。于是在页面内 fetch -> Blob -> createObjectURL ->
 *   <a download>.click() 就能让文件老老实实走浏览器自己的下载管线。
 *
 * 为什么不用 dsh_browser_download：
 *   DSH 自带的 dsh_browser_download 走的是 provider 的原生下载通道，
 *   而桌面端（desktop shell）不支持它，会报
 *   `download is only available on the self-hosted browser`。
 *   本插件改走页面内 blob 方案，在桌面端同样可用。
 *
 * 一次只下一个：
 *   浏览器对连续/并发触发多个下载会弹「允许下载多个文件」确认框，未确认前
 *   后续下载会被挂起，看起来就像失败。所以这里串行排队，一个下完再下一个。
 */

import { existsSync, statSync, readdirSync } from 'node:fs'
import { join, basename } from 'node:path'
import { homedir } from 'node:os'

export const name = 'dsh-blob-download'

/* ───────────────────────── 配置 ───────────────────────── */

const DEFAULTS = {
  downloadDir: '',
  timeoutMs: 120000,
}

/**
 * 把配置和默认值合并。
 * @param {Record<string, unknown>} config
 */
function loadConfig(config) {
  const c = config && typeof config === 'object' ? config : {}
  return {
    downloadDir: typeof c.downloadDir === 'string' && c.downloadDir.trim() ? c.downloadDir.trim() : DEFAULTS.downloadDir,
    timeoutMs: Number.isFinite(c.timeoutMs) && c.timeoutMs > 0 ? Number(c.timeoutMs) : DEFAULTS.timeoutMs,
  }
}

/* ───────────────────────── 工具函数 ───────────────────────── */

/** 默认下载目录：优先 XDG_DOWNLOAD_DIR，其次本地化的 Downloads / 下载 / 下載。 */
function defaultDownloadDir() {
  const xdg = process.env.XDG_DOWNLOAD_DIR
  if (xdg && existsSync(xdg)) return xdg
  for (const n of ['Downloads', '下载', '下載']) {
    const p = join(homedir(), n)
    if (existsSync(p)) return p
  }
  return join(homedir(), 'Downloads')
}

/**
 * 从 URL 猜一个文件名。查不到就用「download + 时间戳」。
 * @param {string} url
 */
function guessFileName(url) {
  try {
    const u = new URL(url)
    const last = u.pathname.split('/').filter(Boolean).pop()
    if (last) {
      const decoded = decodeURIComponent(last)
      if (decoded) return decoded
    }
  } catch {
    /* 解析失败就走兜底 */
  }
  return `download-${Date.now()}`
}

/** 文件名消毒：去掉 Windows 不允许的字符，避免路径穿越。 */
function sanitizeFileName(raw) {
  let n = String(raw ?? '').trim()
  n = n.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
  n = n.replace(/^\.+/, '')
  if (!n) n = `download-${Date.now()}`
  // 保留扩展名截断超长名
  if (n.length > 180) {
    const dot = n.lastIndexOf('.')
    if (dot > 0) n = n.slice(0, 180) + n.slice(dot)
    else n = n.slice(0, 180)
  }
  return n
}

/**
 * 在目标目录里挑一个不冲突的文件名（Windows 允许 (1) (2) 这种后缀）。
 * `a.txt` -> `a (1).txt` -> `a (2).txt`
 * @param {string} dir
 * @param {string} fileName
 */
function uniqueName(dir, fileName) {
  const dot = fileName.lastIndexOf('.')
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName
  const ext = dot > 0 ? fileName.slice(dot) : ''
  let candidate = fileName
  let i = 1
  while (existsSync(join(dir, candidate))) {
    candidate = `${stem} (${i})${ext}`
    i += 1
    if (i > 9999) break
  }
  return candidate
}

/**
 * 在目录里找「刚写出来的那个文件」：按修改时间倒序，取最近 N 秒内、
 * 大小与预期相符的那个。
 * @param {string} dir
 * @param {number} expectedSize
 * @param {number} sinceMs  只考虑这个时间点之后修改过的
 */
function findWrittenFile(dir, expectedSize, sinceMs) {
  let entries
  try {
    entries = readdirSync(dir)
  } catch {
    return undefined
  }
  const hits = []
  for (const e of entries) {
    const p = join(dir, e)
    try {
      const st = statSync(p)
      if (!st.isFile()) continue
      if (st.mtimeMs + 2000 < sinceMs) continue
      if (expectedSize > 0 && st.size !== expectedSize) continue
      hits.push({ path: p, size: st.size, mtimeMs: st.mtimeMs })
    } catch {
      /* 读不到就跳过 */
    }
  }
  hits.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return hits[0]
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ───────────────────────── 页面脚本 ───────────────────────── */

/**
 * 在页面里执行的那段脚本。
 *
 * 要点：
 *  - 用 fetch 取字节，保留原始 Content-Type
 *  - 拼 Blob 后 createObjectURL，再点一个隐藏 <a download>
 *  - 返回预期的字节数与 blob URL，宿主据此判断是否真的下到了

 * @param {string} url
 * @param {string} fileName
 */
function pageScript(url, fileName) {
  return `(async () => {
  try {
    const res = await fetch(${JSON.stringify(url)}, { credentials: 'include' });
    if (!res.ok) {
      return { ok: false, error: 'HTTP ' + res.status + ' ' + res.statusText, status: res.status };
    }
    const buf = await res.arrayBuffer();
    const type = res.headers.get('content-type') || 'application/octet-stream';
    const blob = new Blob([buf], { type });
    const blobUrl = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = ${JSON.stringify(fileName)};
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      try { a.remove(); URL.revokeObjectURL(blobUrl); } catch (e) {}
    }, 60000);
    return { ok: true, bytes: buf.byteLength, type, blobUrl };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
})()`
}

/* ───────────────────────── 插件入口 ───────────────────────── */

const TOOL_DESCRIPTION = `下载一个 URL 到本地文件，走页面内的 blob: 协议。
迅雷等下载扩展通常不拦截 blob: 协议（它们只处理 http/https 的下载事件），
所以这个工具下出来的文件会老老实实走浏览器自己的下载管线，不会弹迅雷的
「新建下载任务」窗口。适合在用户装着迅雷「下载支持」扩展时下载文件。
一次只下一个：多个下载会触发浏览器的「下载多个文件」确认，所以本工具串行排队。`

export function apply(root, config = {}) {
  const live = loadConfig(config)

  root.inject(['tools'], (ctx) => {
    // 串行队列：一次只放行一个下载
    let chain = Promise.resolve()

    ctx.tools.register({
      name: 'blob_download',
      description: TOOL_DESCRIPTION,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要下载的 URL（http/https）。',
          },
          fileName: {
            type: 'string',
            description: '保存的文件名。不传就从 URL 末段推断。',
          },
          saveDir: {
            type: 'string',
            description: '保存目录（绝对路径）。不传用配置里的 downloadDir，再没有就用系统下载目录。',
          },
          waitSeconds: {
            type: 'number',
            description: '等待文件落盘的秒数，默认 30。文件多的话可以调大。',
          },
        },
        required: ['url'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['ok', 'message'],
          properties: {
            ok: { type: 'boolean' },
            message: { type: 'string' },
            path: { type: 'string' },
            bytes: { type: 'number' },
            fileName: { type: 'string' },
            verified: { type: 'boolean' },
          },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.message ?? '') }],
      },
      execute: async (args, exec) => {
        const rawUrl = String(args?.url ?? '').trim()
        if (!rawUrl) {
          return { ok: false, message: '没有收到 url。' }
        }

        let parsed
        try {
          parsed = new URL(rawUrl)
        } catch {
          return { ok: false, message: `URL 解析失败：${rawUrl}` }
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { ok: false, message: `只支持 http/https，收到的是 ${parsed.protocol}` }
        }

        const browser = ctx.get('browser')
        if (browser === undefined) {
          return { ok: false, message: 'browser 服务不可用：dsh-builtin-browser 没有装上或没有启用。' }
        }

        const dir = (typeof args?.saveDir === 'string' && args.saveDir.trim())
          ? args.saveDir.trim()
          : (live.downloadDir || defaultDownloadDir())
        const desired = sanitizeFileName(args?.fileName || guessFileName(rawUrl))
        const finalName = uniqueName(dir, desired)
        const finalPath = join(dir, finalName)
        const waitMs = Number.isFinite(args?.waitSeconds) && args.waitSeconds > 0
          ? Math.min(Math.max(args.waitSeconds, 5), 300) * 1000
          : 30000

        // 排队：上一个下载结束（无论成败）才轮到这一个
        const run = async () => {
          let session
          try {
            session = await browser.open('blob-download')
          } catch (e) {
            return { ok: false, message: `打开浏览器会话失败：${e?.message ?? e}` }
          }

          try {
            // 用页面内 fetch 取字节，需要真正的 origin 上下文。
            // about:blank 的 origin 是 null，跨域会被 CORS 挡下，
            // 所以先把会话导航到这个 URL 所属 origin 的根路径：
            // 同站资源此时是同源 fetch（不受 CORS 限制），跨站资源才依赖对方 CORS。
            // 注意：不能直接 openUrl 目标文件——那会先触发一次真正的浏览器下载，
            // 正好喂给迅雷，绕了半天等于没绕。
            const origin = parsed.origin + '/'
            await browser.openUrl(session, { url: origin, newTab: false })
          } catch (e) {
            return { ok: false, message: `导航到 ${parsed.origin} 失败：${e?.message ?? e}` }
          }

          let result
          try {
            result = await browser.execute(session, { script: pageScript(rawUrl, finalName) })
          } catch (e) {
            return { ok: false, message: `页面脚本执行失败：${e?.message ?? e}` }
          }

          // BrowserExecuteResult = { ok: true, value } | { ok: false, exception }
          if (!result || result.ok !== true) {
            const why = result && result.exception ? result.exception : '页面脚本执行没有返回结果'
            return { ok: false, message: `下载未触发：${why}` }
          }
          const value = result.value
          if (!value || value.ok !== true) {
            const why = value && value.error ? value.error : JSON.stringify(value ?? null)
            return { ok: false, message: `下载未触发：${why}` }
          }

          const expected = Number(value.bytes) || 0
          const since = Date.now()
          const deadline = since + Math.min(waitMs, live.timeoutMs)
          let found
          while (Date.now() < deadline) {
            await sleep(700)
            found = findWrittenFile(dir, expected, since)
            if (found) break
          }

          if (!found) {
            return {
              ok: false,
              message:
                `已触发 blob 下载（${expected} 字节），但在 ${Math.round((Date.now() - since) / 1000)} 秒内` +
                `没有在 ${dir} 里看到对应的文件。\n` +
                `可能原因：浏览器弹了「允许下载多个文件」的确认框还没点、下载被安全策略拦下、或目标目录不对。\n` +
                `提示：检查浏览器窗口有没有待确认的下载提示。`,
              bytes: expected,
              fileName: finalName,
              verified: false,
            }
          }

          return {
            ok: true,
            message: `已下载 ${found.size} 字节到 ${found.path}`,
            path: found.path,
            bytes: found.size,
            fileName: basename(found.path),
            verified: true,
          }
        }

        const queued = chain.then(run, run)
        chain = queued.catch(() => {})
        return queued
      },
    })
  })
}
