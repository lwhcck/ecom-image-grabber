# 作业三 · 提交材料清单

**姓名：罗文涵　学号（工号）：2220232677**
**提交入口**：https://wj.qq.com/s2/28193831/730p/
**截止时间**：10 月 19 日（周一）晚 17:00

> 问卷原话：本考核请于 10月19号（周一）晚上5点前提交，考核中涉及的图片文件请同步保存在自己的电脑中，后续需要以文件的形式提交。

---

## 一、问卷 5 项对照（照着这个交）

| 题号 | 题目 | 你交什么 | 材料在哪 | 状态 |
|---|---|---|---|---|
| 01 | 工号 | `2220232677` | 手填 | — |
| 02 | 姓名 | `罗文涵` | 手填 | — |
| 03 | **插件截图** | `04_提交材料/截图/03_插件运行截图.png`（**真实扩展页** `chrome-extension://…/gallery.html` 截图，含 5 张图与下载反馈）<br>`03B_提取逻辑实测.png`（提取逻辑实测统计）<br>`03C_图片库_空状态.png`（图片库空状态）<br>`插件真机加载验证.json`（真机加载验证结果） | 已生成 | ✅ |
| 04 | **项目推送到 github 上的截图** | `04_提交材料/截图/04_推送到GitHub截图.png` | 已生成（本地 git 真实输出 + GitHub 页面预览） | ⏳ 推送后换成 GitHub 仓库页真实截图 |
| 05 | **域名地址** | `04_提交材料/域名地址.txt` | 已写好，推送并开启 Pages 后即为真实地址 | ⏳ |
| 06 | **使用 github pages 发布的官网静态页面截图** | `04_提交材料/截图/06_GitHubPages官网截图.png`<br>`06B_官网_手机375.png` | 已生成（官网真实页面全页截图） | ⏳ 建议换成线上地址栏截图 |

每题最多可传 9 个文件、单文件 ≤300MB，多传几张更充分。

---

## 二、这个文件夹里有什么

```
作业三/
├── plugin/                     ① 电商图片下载插件（Chrome Manifest V3）
│   ├── manifest.json
│   ├── content.js / content.css      右下角「获取图片」悬浮按钮 + 图片提取
│   ├── background.js                 Service Worker：转 PNG、开图片库、批量下载
│   ├── gallery.html / gallery.js / gallery.css   图片库页面
│   ├── icons/                        扩展图标
│   └── 安装与使用说明.md
├── site/                       ② 插件官方宣传网站源码（纯静态）
│   ├── index.html
│   ├── css/style.css
│   ├── js/main.js
│   └── assets/
├── docs/                       ③ GitHub Pages 发布目录（= site/ 的副本）
├── tools/                      构建与取证脚本
│   ├── sync-docs.ps1           把 site/ 同步到 docs/
│   ├── pack-plugin.ps1         打包插件为 assets/imagegrab-plugin.zip
│   ├── make-test-capture.js    生成取证页面（复用 content.js 真实逻辑）
│   ├── make_github_proof.py    生成 git 推送取证页
│   └── cdp_capture.py          基于 DevTools 协议的稳定截图工具
├── 02_开发过程/                三轮 Prompt、迭代记录、异常测试
├── 03_本地测试/                演示详情页 + 取证页面
├── 05_测试素材/                本地生成的演示图片
└── 04_提交材料/                截图、域名地址、取证页
```

> 为什么有 `site/` 和 `docs/` 两份？`site/` 是源码，`docs/` 是 GitHub Pages 的发布目录
> （GitHub 只能从仓库根目录或 `docs/` 发布）。改完 `site/` 后运行
> `pwsh -File tools/sync-docs.ps1` 即可同步。

---

## 三、插件怎么装（老师问起就按这个说）

1. 打开 Chrome，地址栏输入 `chrome://extensions` 回车
2. 打开右上角**开发者模式**
3. 点**加载已解压的扩展程序**，选择本文件夹下的 `plugin` 目录
4. 打开电商商品详情页（淘宝 / 天猫 / 京东 / 拼多多商家版），页面**右下角**出现「获取图片」悬浮按钮
5. 点按钮 → 自动滚动触发懒加载 → 扫描页面所有商品图 → 过滤图标与小于 100×100 的小图
6. 自动打开图片库新页面：网格展示缩略图 + 尺寸 + 序号，支持全选 / 反选 / 清空
7. 点「下载选中（PNG）」批量下载，文件名 `商品图_001.png`、`商品图_002.png` 这样的形式，序号补零

**本地验证**：双击 `03_本地测试/演示商品详情页.html` 可以看模拟详情页；
`03_本地测试/插件取证/capture.html` 会直接调用插件本体的提取函数跑一遍并显示统计结果。

**实测数据**（`03_本地测试/插件取证/capture.html`）：

| 指标 | 结果 |
|---|---|
| 候选图片 URL（去重前） | 22 |
| 去重后候选 | 6 |
| 通过尺寸校验 | 5 |
| 被过滤的小图 | 1（`demo_img_small_20.png`，20×20） |

---

## 四、还需要你本人做的一步：推送到 GitHub

推送需要你的 GitHub 登录态（或 Personal Access Token），我这边没有凭据，无法代做。
本地的 git 仓库**已经建好并提交完成**，只差推送：

```
仓库位置：C:\Users\lenovo\Desktop\实习\作业三
分支：main
提交：3 次（首次 e333a26 建立插件与官网，末次 09f770d 更新说明）
远程：https://github.com/lwhcck/ecom-image-grabber.git  （已 add，尚未 push）
文件：62 个
```

### 路线 A：命令行（推荐，一条命令）

```powershell
cd "C:\Users\lenovo\Desktop\实习\作业三"
git push -u origin main
```

推送时会弹窗要求登录 GitHub（浏览器授权，或粘贴 **Personal Access Token**）。
⚠️ 现在 GitHub 不支持用账号密码推送，必须用 Token 或浏览器授权。
Token 生成：GitHub → 头像 → `Settings` → `Developer settings` →
`Personal access tokens` → `Fine-grained tokens` → 生成时权限勾 **Contents: Read and write**、
**Pages: Read and write**。

### 路线 B：GitHub 网页上传（不想折腾 Token 就用这个）

1. 在 github.com 新建仓库 `ecom-image-grabber`（**Public**，不要勾初始化 README）
2. 仓库页 → `Add file` → `Upload files`
3. 把 `plugin/`、`site/`、`docs/`、`README.md`、`.gitignore` 拖进去
4. 提交

### 推送后开启 GitHub Pages

仓库页 → `Settings` → 左侧 `Pages` → Source 选 **Deploy from a branch** →
分支 `main`、目录 **`/docs`** → `Save`。

等 1–2 分钟，官网地址：

```
https://lwhcck.github.io/ecom-image-grabber/
```

> 如果仓库名直接叫 `lwhcck.github.io`，地址则是 `https://lwhcck.github.io/`。

### 推送完成后要替换的两张图

1. 打开 `https://github.com/lwhcck/ecom-image-grabber`，
   截图（能看到仓库名、文件列表、提交记录）→ 覆盖 `04_提交材料/截图/04_推送到GitHub截图.png`
2. 打开线上官网地址，**把地址栏一起截进去** → 覆盖 `04_提交材料/截图/06_GitHubPages官网截图.png`

最后把域名填进 `04_提交材料/域名地址.txt`，并在问卷第 05 题填写。

---

## 五、提交前自检

推送之前先跑一次自检，把「离线就能发现的问题」一次性查完（漏文件、链接断了、
权限申请过多、构建产物过期等）：

```powershell
cd "C:\Users\lenovo\Desktop\实习\作业三"
npm test                       # 7 项 Service Worker 回归测试
npm run preflight              # 检查作业三 + 作业四，共 89 项
npm run verify-ext             # 把插件真正加载进浏览器验证（见第六节）
```

自检逐项输出 PASS/FAIL 并汇总失败项。当前状态：**89 项全部通过**。

> 自检里有两条硬约定，都是从真实踩坑里总结出来的：
> ① 不申请 `tabs` 权限（复用图片库标签页只按 id 查自己创建的那个）；
> ② `background.js` 用了 ESM 语法时，manifest 必须声明 `type: module`。

---

## 六、插件真机加载验证

`tools/verify_extension.py` 会把 `plugin/` **真正加载进 Chromium 内核浏览器**
（本机用 Edge，headless=new），再用 DevTools 协议把插件从头到尾跑一遍：

| 分组 | 检查项 | 结果 |
|---|---|---|
| A | 扩展能否加载、Service Worker 是否启动 | 能，`chrome-extension://…/background.js` |
| A | Service Worker 启动期异常 | 无 |
| B | `chrome.runtime` / API 真实可用性 | 13 个 API 逐个探测通过 |
| B | 浏览器看到的权限 | `activeTab`、`scripting`、`downloads`、`storage` |
| B | manifest 的 `background.type` | `module`（缺它会直接语法错误） |
| C | OffscreenCanvas 转 PNG / createImageBitmap 解码 / storage 读写 | 全部通过 |
| D | 图片库扩展页渲染（空状态 / 演示模式） | 正常，演示模式 5 张卡片 |
| E | **商品详情页注入按钮**（伪装成 `item.taobao.com/item.htm`） | 注入成功，`position:fixed`、右下角、文字「获取图片」 |
| E | **点按钮提取 → 自动打开图片库** | 提示「已打开图片库，共 5 张图片」，图片库 5 张、数据来自真实提取 |
| E | **非详情页（首页）不注入** | 按钮不存在 ✓ |

```powershell
npm run verify-ext
```

产出（都在 `04_提交材料/截图/`）：

- `08_详情页_按钮已注入.png`、`08B_首页_不注入按钮.png`、`08C_真实提取后的图片库.png`
- `04_提交材料/截图/03_插件运行截图.png`（真实扩展页 `gallery.html?mock=1`）
- `插件真机加载验证.json`（全部断言与原始结果）

> **为什么必须做这一步**：单元测试里的 `chrome.*` 是 mock 出来的，测不出「插件在真实浏览器里
> 根本没启动」这类问题。这个脚本抓出过两个致命 bug —— Service Worker 缺 `type: module` 起不来、
> 以及首页也被判成详情页并注入按钮。

## 六·2、批量下载落盘验证

`chrome.downloads.download` 对 URL 的 scheme 有限制，而 Service Worker 里拿不到 `blob:` URL，
插件是先把 PNG 转成 data URL 再下载的 —— 这条路径必须实测，否则可能出现
「界面提示下载完成、磁盘上什么都没有」。

```powershell
npm run verify-download
```

实测结果（`04_提交材料/截图/download_verify.json`）：

| 检查项 | 结果 |
|---|---|
| 下载调用返回 | `okCount: 3`，`failCount: 0` |
| 下载记录状态 | 3 条全部 `state: complete`、`error: null`、`mime: image/png` |
| 文件真的落盘 | 是，`商品图_001.png`、`商品图_002.png`、`商品图_003.png` |
| 文件是有效 PNG | 是，Pillow 校验通过：`800×800`、`900×1200`、`1000×1000` |
| 透明度保留 | 是，`mode=RGBA` |
| 序号补零 | 是，`_001`/`_002`/`_003` |

> 顺带发现：**`--download-directory` 在 headless 下会被忽略**，文件实际落在系统默认下载目录。
> 所以脚本改成以 `chrome.downloads.search()` 返回的 `filename` 为准，而不是假定目录。

## 六·3、CDN 抓图权限验证

商品详情页在 `item.taobao.com`，但**商品图实际托管在 CDN 上**（`img.alicdn.com` 之类）。
Service Worker 的 `fetch` 受扩展 `host_permissions` 约束，CDN 域名不在权限里就会抓图失败。
所以 manifest 里除了平台站点，还补了四个图片 CDN 域名。

```powershell
npm run verify-cdn
```

实测（`04_提交材料/截图/cdn_fetch_verify.json`），用真实 CDN 域名映射到本地做双向验证：

| 域名 | 是否在权限内 | 结果 | 判定 |
|---|---|---|---|
| `img.alicdn.com`（映射到本地） | 是 | `200`，`image/png`，6821 字节 | PASS（能抓到） |
| `not-allowed.example.com`（对照组） | 否 | `TypeError: Failed to fetch` | PASS（被正确拦下） |

第二行是关键的对照：它证明「能抓到」是因为权限配置正确，而不是碰巧。

## 六·4、真实站点验证

本机能访问 `www.taobao.com` / `www.tmall.com` / `item.taobao.com` / `item.jd.com`，
所以把插件加载进浏览器后直接在**真实生产站点**上跑了一遍详情页判定：

```powershell
npm run verify-live      # 需要能访问上面这些站点
```

实测（`04_提交材料/截图/真实站点验证.json`，截图 `live_*.png`）：

| 站点 | 最终 URL | 页面规模 | 按钮 | 判定 |
|---|---|---|---|---|
| 淘宝首页 | `www.taobao.com/` | 843 KB / 181 张图 | **不注入** | PASS |
| 天猫首页 | `www.tmall.com/` | 818 KB / 174 张图 | **不注入** | PASS |
| 淘宝商品页 | 被重定向到 `login.taobao.com` | 257 KB | 不注入 | PASS（登录页本来就不该注入） |
| 京东商品页 | 被重定向到 `pc-frequent-pro.pf.jd.com`（403 风控） | 92 KB | 不注入 | PASS |

**这两个首页的验证很有价值**：它们是真实生产页面（几十万字节、上百张图），
插件正确判断出「不是详情页」—— 这直接证明了第六·1 节修掉的那个
「首页也注入按钮」的 bug 在真实站点上确实已经不复现。

**没能验证的（如实说明）**：

- 真实商品详情页**看不到**（未登录被重定向到登录墙 / 风控页），
  因此「真实详情页上的 DOM 选择器、懒加载属性名、防盗链行为」仍是未验证的；
- 也因此**没能验证真实商品图能否被正确提取**。

## 六·5、真实图片 URL 上的过滤规则验证

从上面抓到的真实页面 HTML 里提取出 38 条真实图片 URL（域名 `img.alicdn.com`、`gw.alicdn.com`），
用它们检验插件的过滤规则：

```powershell
npm test        # 含 tools/real-urls.test.mjs
```

| 检验项 | 结果 |
|---|---|
| 38 条真实 CDN 图片 URL 是否被关键词黑名单误杀 | 否，0 条被误杀 |
| 真实图片 CDN 域名是否都在 `host_permissions` 内 | 是，两个域名都覆盖 |
| `_50x50.jpg` 这类小尺寸标记是否被 URL 规则拦掉 | 是 |
| 含 `logo` / `icon` 的 URL 是否被拦掉 | 是 |

**必须说清的局限**：这 38 条样本全部来自**首页**（是首页装饰图，不是商品图），
所以它证明的是「真实 CDN 域名可用、真实 URL 不会被误杀」，
**不能**证明「真实商品图不会被误判」。另外首页大图都是 1040×384、604×64 这类规格，
「尺寸过滤」这一条在这些样本上没被覆盖 —— 那条由真机加载里的 `new Image()` 真实尺寸探测负责。

## 六·6、测试与验证一览

| 命令 | 覆盖 | 当前结果 |
|---|---|---|
| `npm test` | Service Worker 回归 + 真实 URL 过滤规则 | **10 项全过** |
| `npm run audit` | 文档里的路径 / 脚本 / 截图引用是否都存在 | ✓ 全部可对应 |
| `npm run preflight` | 两份作业的提交前自检 | **91 项全过** |
| `npm run verify-ext` | 真机加载：SW、API、行为、图片库、content.js 注入与排除 | OK |
| `npm run verify-download` | 批量下载真实落盘成 PNG（文件名 `商品图_001.png`） | OK |
| `npm run verify-cdn` | CDN 域名抓图权限（含反例对照） | OK |
| `npm run verify-live` | 真实站点详情页判定 | OK（4/4） |
| `npm run verify-gallery` | 图片库两条缩略图加载分支（含 60 张阈值边界） | OK |

作业四侧：`npm test` **34 项全过**（含会话密钥轮换、伪造签名、过期会话等安全边界）。

### 图片库缩略图的两条分支

`gallery.js` 里有个阈值 `AUTO_CONVERT_LIMIT = 60`：≤60 张时请 Service Worker 把图转成 PNG
data URL 再预览（保证「预览所见 = 下载所得」）；>60 张时直接拿原图 URL 预览，避免一次性
转上百张图把内存撑爆。两条分支都已在真实扩展页面上验证：

| 场景 | 实际走的分支 | 缩略图 | 判定 |
|---|---|---|---|
| 5 张图（默认阈值） | `data-url` | 全部就绪 | PASS |
| 5 张图（把阈值压到 3） | `direct`，`src` 为 `direct-url` | 全部就绪 | PASS |
| 阈值边界 1/5/59/60/61/100/200 | 59、60 走 data-url；61 起走 direct | — | PASS |

> 测试方式是「只改阈值、不改代码」：用 CDP 的 `Page.addScriptToEvaluateOnNewDocument`
> 在 `gallery.js` 执行前写入 `window.__GALLERY_TEST_LIMIT__`，因此验证的仍是真实源码里的分支判断。
>
> **注意**：两条分支渲染出来的画面本来就一样（同一批图的缩略图），区别只在 `img.src`
> 是 `data:` 还是扩展内 `chrome-extension://` URL。所以判定依据是 `path` / `srcKind`
> 这两个断言，**不是**截图像素差异 —— 这一点我在脚本里也写明了，避免用截图冒充证据。

---

## 六、问卷各题怎么填

```
01 工号：2220232677
02 姓名：罗文涵
03 插件截图：上传 03_插件运行截图.png（可加传 03B_提取逻辑实测.png）
04 项目推送到 github 上的截图：上传 04_推送到GitHub截图.png
05 域名地址：https://lwhcck.github.io/ecom-image-grabber/
06 使用 github pages 发布的官网静态页面截图：上传 06_GitHubPages官网截图.png
```
