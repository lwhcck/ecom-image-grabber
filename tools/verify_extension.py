"""
把插件真正加载进 Chromium 内核浏览器，用 DevTools 协议验证它到底能不能工作。

这一步补的是「mock chrome API 的单元测试测不出来」的缺口。曾经真的因此漏掉一个致命 bug：
background.js 用了 ESM 语法但 manifest 没声明 type: module，导致 Service Worker 从未启动，
而 mock 测试全绿。

覆盖：
  A. 扩展能否加载、Service Worker 是否启动、启动期有无异常
  B. chrome.* API 在真实环境下是否可用、权限是否如设计
  C. 真实行为：OffscreenCanvas 转 PNG、createImageBitmap 解码、storage 读写
  D. 图片库扩展页能否渲染（空状态 / 演示模式）
  E. content.js 能否在「商品详情页」真的注入按钮，并跑通「提取 → 打开图片库」链路

用法：
  python tools/verify_extension.py <pluginDir> <outDir> [fakeShopDir]

  fakeShopDir 由 tools/make-fake-shop-page.js 生成；传了它就额外做 E 项验证
  （脚本内部会起静态服务并用 host-resolver 把 item.taobao.com 指到本地）。
"""
import base64
import functools
import http.server
import json
import os
import shutil
import socket
import socketserver
import subprocess
import sys
import threading
import time

import requests
import websocket

PLUGIN = os.path.abspath(sys.argv[1])
OUT = os.path.abspath(sys.argv[2])
FAKE_SHOP = os.path.abspath(sys.argv[3]) if len(sys.argv) > 3 else None
os.makedirs(OUT, exist_ok=True)

EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
CHROME = r'C:\Program Files\Google\Chrome\Application\chrome.exe'


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


def pick_browser():
    """挑一个能以 headless 方式启动的 Chromium 内核浏览器（Chrome 在本机缺 VC++ 运行库）"""
    for exe in (EDGE, CHROME):
        if not os.path.exists(exe):
            continue
        p = free_port()
        prof = os.path.join(os.environ.get('TEMP', '.'), 'browser-probe-' + str(p))
        shutil.rmtree(prof, ignore_errors=True)
        args = [exe, '--headless=new', '--disable-gpu', '--no-sandbox',
                f'--remote-debugging-port={p}', f'--user-data-dir={prof}', 'about:blank']
        log = open(os.path.join(os.environ.get('TEMP', '.'), 'browser-probe.log'), 'wb')
        try:
            proc = subprocess.Popen(args, stdout=log, stderr=log)
            for _ in range(40):
                if proc.poll() is not None:
                    break
                try:
                    requests.get(f'http://127.0.0.1:{p}/json/version', timeout=2).json()
                    proc.terminate()
                    return exe
                except Exception:
                    time.sleep(0.4)
            proc.terminate()
        except Exception:
            pass
        finally:
            try:
                log.close()
            except Exception:
                pass
    raise RuntimeError('Chrome 与 Edge 都无法以 headless 方式启动')


class StaticServer:
    """把伪装的电商详情页目录挂到本地端口上"""

    def __init__(self, directory):
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
        handler.log_message = lambda *a, **k: None
        self.httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
        self.port = self.httpd.server_address[1]
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()

    def stop(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:
            pass


class Browser:
    def __init__(self, extra_args=None):
        self.browser = pick_browser()
        self.port = free_port()
        self.profile = os.path.join(os.environ.get('TEMP', '.'), 'ext-verify-' + str(self.port))
        shutil.rmtree(self.profile, ignore_errors=True)
        self.msg_id = 0
        self.ws = None
        self.events = []
        args = [
            self.browser,
            '--headless=new',
            '--disable-gpu',
            '--no-sandbox',
            f'--remote-debugging-port={self.port}',
            '--remote-allow-origins=*',
            f'--user-data-dir={self.profile}',
            '--no-first-run',
            '--no-default-browser-check',
            f'--load-extension={PLUGIN}',
            f'--disable-extensions-except={PLUGIN}',
            '--window-size=1280,900',
        ] + (extra_args or []) + ['about:blank']
        self.log = open(os.path.join(os.environ.get('TEMP', '.'), 'ext-verify.log'), 'wb')
        self.proc = subprocess.Popen(args, stdout=self.log, stderr=self.log)

    def wait_ready(self, timeout=60):
        deadline = time.time() + timeout
        while time.time() < deadline:
            if self.proc.poll() is not None:
                raise RuntimeError('浏览器提前退出，退出码 ' + str(self.proc.returncode))
            try:
                requests.get(f'http://127.0.0.1:{self.port}/json/version', timeout=2).json()
                return True
            except Exception:
                time.sleep(0.5)
        return False

    def targets(self):
        return requests.get(f'http://127.0.0.1:{self.port}/json/list', timeout=5).json()

    def new_tab(self, url):
        return requests.put(f'http://127.0.0.1:{self.port}/json/new?' + requests.utils.quote(url),
                            timeout=5).json()

    def attach(self, ws_url):
        if self.ws:
            try:
                self.ws.close()
            except Exception:
                pass
        self.ws = websocket.create_connection(ws_url, timeout=60, max_size=64 * 1024 * 1024)
        self.events = []
        self.cmd('Runtime.enable')
        try:
            self.cmd('Log.enable')
        except Exception:
            pass

    def cmd(self, method, params=None, timeout=90):
        self.msg_id += 1
        mid = self.msg_id
        self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params or {}}))
        deadline = time.time() + timeout
        while time.time() < deadline:
            self.ws.settimeout(max(1, deadline - time.time()))
            msg = json.loads(self.ws.recv())
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise RuntimeError(f'{method}: {msg["error"]}')
                return msg.get('result', {})
            if 'method' in msg:
                self.events.append(msg)
        raise TimeoutError(method)

    def evaluate(self, expr, timeout=90):
        res = self.cmd('Runtime.evaluate',
                       {'expression': expr, 'awaitPromise': True, 'returnByValue': True},
                       timeout=timeout)
        if 'exceptionDetails' in res:
            return {'__error__': json.dumps(res['exceptionDetails'], ensure_ascii=False)[:300]}
        return res.get('result', {}).get('value')

    def screenshot(self, path, width=None, height=None):
        if width and height:
            self.cmd('Emulation.setDeviceMetricsOverride',
                     {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': False})
        res = self.cmd('Page.captureScreenshot', {'format': 'png'}, timeout=120)
        with open(path, 'wb') as f:
            f.write(base64.b64decode(res['data']))
        return os.path.getsize(path)

    def close(self):
        try:
            if self.ws:
                self.ws.close()
        except Exception:
            pass
        try:
            self.proc.terminate()
        except Exception:
            pass
        try:
            self.log.close()
        except Exception:
            pass


def main():
    report = {'plugin_dir': PLUGIN}
    server = None
    b = None
    try:
        extra = []
        if FAKE_SHOP:
            server = StaticServer(FAKE_SHOP)
            # 关键：把 item.taobao.com 解析到本地，让 content.js 认为自己在真实电商域名下
            extra.append('--host-resolver-rules=MAP item.taobao.com 127.0.0.1')
            report['fake_shop'] = {
                'dir': FAKE_SHOP,
                'local_port': server.port,
                # 用 /item.htm 路径，贴近真实淘宝详情页地址（item.taobao.com/item.htm?id=…）
                'url': f'http://item.taobao.com:{server.port}/item.htm',
                'home_url': f'http://item.taobao.com:{server.port}/home.html'
            }

        b = Browser(extra_args=extra)
        report['browser'] = b.browser
        report['browser_ready'] = b.wait_ready()

        # ---------- A. Service Worker ----------
        sw = None
        for _ in range(60):
            workers = [t for t in b.targets() if 'service_worker' in (t.get('type') or '')]
            mine = [t for t in workers if (t.get('url') or '').endswith('/background.js')]
            if mine:
                sw = mine
                break
            time.sleep(0.5)
        report['all_targets'] = [{'type': t.get('type'), 'url': (t.get('url') or '')[:120]}
                                 for t in b.targets()]
        report['service_worker_found'] = bool(sw)
        if not sw:
            report['verdict'] = 'FAIL：没发现本插件的 Service Worker'
            return
        report['service_worker_url'] = sw[0]['url']

        b.attach(sw[0]['webSocketDebuggerUrl'])
        ready = False
        for _ in range(60):
            if b.evaluate("typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id)") is True:
                ready = True
                break
            time.sleep(0.5)
        report['runtime_ready'] = ready
        time.sleep(1.0)

        errors = []
        for e in b.events:
            if e.get('method') == 'Runtime.exceptionThrown':
                d = e['params']['exceptionDetails']
                errors.append((d.get('exception') or {}).get('description') or d.get('text'))
            if e.get('method') == 'Log.entryAdded':
                en = e['params']['entry']
                if en.get('level') == 'error':
                    errors.append(en.get('text', ''))
        report['service_worker_startup_errors'] = errors
        report['service_worker_clean'] = len(errors) == 0

        report['worker_globals'] = b.evaluate("""(() => ({
            hasChrome: typeof chrome !== 'undefined',
            extensionId: (chrome.runtime && chrome.runtime.id) || null
        }))()""")
        ext_id = (report['worker_globals'] or {}).get('extensionId')

        # ---------- B. 权限与 API ----------
        report['manifest_as_seen_by_browser'] = b.evaluate("""(() => {
            const m = chrome.runtime.getManifest();
            return { name: m.name, version: m.version, manifest_version: m.manifest_version,
                     permissions: m.permissions || [], host_permissions: m.host_permissions || [],
                     sw_type: (m.background || {}).type || null };
        })()""")
        report['api_probe'] = b.evaluate("""(() => {
            const chk = (path) => { try { let o = chrome;
                for (const p of path.split('.')) { if (o == null) return false; o = o[p]; }
                return o !== undefined && o !== null; } catch (e) { return 'throw'; } };
            const out = {};
            ['runtime.id','runtime.getURL','runtime.sendMessage','runtime.onMessage',
             'storage.local.get','storage.local.set','downloads.download',
             'tabs.create','tabs.get','tabs.update','action.onClicked',
             'scripting.executeScript'].forEach(a => { out[a] = chk(a); });
            return out;
        })()""")

        # ---------- C. 真实行为 ----------
        report['behavior'] = b.evaluate("""(async () => {
            const res = {};
            try {
                const cv = new OffscreenCanvas(2, 2);
                cv.getContext('2d').fillRect(0, 0, 2, 2);
                const blob = await cv.convertToBlob({ type: 'image/png' });
                res.offscreenCanvasPng = { ok: blob.type === 'image/png', type: blob.type, size: blob.size };
            } catch (e) { res.offscreenCanvasPng = { ok: false, error: String(e) }; }
            try {
                const cv = new OffscreenCanvas(4, 4);
                cv.getContext('2d').fillRect(0, 0, 4, 4);
                const bmp = await createImageBitmap(await cv.convertToBlob({ type: 'image/png' }));
                res.createImageBitmap = { ok: bmp.width === 4 && bmp.height === 4 };
            } catch (e) { res.createImageBitmap = { ok: false, error: String(e) }; }
            try {
                await chrome.storage.local.set({ __verify__: { n: 7 } });
                const got = await chrome.storage.local.get('__verify__');
                res.storageRoundTrip = { ok: !!(got && got.__verify__ && got.__verify__.n === 7) };
                await chrome.storage.local.remove('__verify__');
            } catch (e) { res.storageRoundTrip = { ok: false, error: String(e) }; }
            return res;
        })()""")

        # ---------- D. 图片库扩展页 ----------
        try:
            t = b.new_tab(f'chrome-extension://{ext_id}/gallery.html')
            time.sleep(2.5)
            b.attach(t['webSocketDebuggerUrl'])
            report['gallery_empty'] = b.evaluate("""(() => ({
                title: document.title,
                emptyStateShown: !document.getElementById('empty').hidden,
                total: (document.getElementById('stat-total') || {}).textContent || '',
                hasDownloadBtn: !!document.getElementById('btn-download')
            }))()""")
            b.screenshot(os.path.join(OUT, 'extension_gallery_empty.png'), 1500, 900)

            t2 = b.new_tab(f'chrome-extension://{ext_id}/gallery.html?mock=1')
            time.sleep(3.0)
            b.attach(t2['webSocketDebuggerUrl'])
            for _ in range(40):
                if b.evaluate("(() => { const a = Array.from(document.querySelectorAll('.card-thumb img'));"
                              " return a.length > 0 && a.every(i => i.complete && i.naturalWidth > 0); })()") is True:
                    break
                time.sleep(0.5)
            report['gallery_mock'] = b.evaluate("""(() => ({
                cards: document.querySelectorAll('.card').length,
                selected: (document.getElementById('stat-selected') || {}).textContent || '',
                thumbsReady: Array.from(document.querySelectorAll('.card-thumb img'))
                                .every(i => i.complete && i.naturalWidth > 0)
            }))()""")
            b.evaluate("document.getElementById('btn-download').click()")
            time.sleep(1.5)
            b.screenshot(os.path.join(OUT, 'extension_gallery_mock.png'), 1500, 900)
        except Exception as e:
            report['gallery_page'] = {'error': str(e)[:200]}

        # ---------- E. content.js 真机注入 ----------
        if FAKE_SHOP:
            try:
                url = report['fake_shop']['url']

                # 反例：非详情页（首页）不应该注入按钮
                home_url = report['fake_shop']['home_url']
                th = b.new_tab(home_url)
                time.sleep(4.5)
                b.attach(th['webSocketDebuggerUrl'])
                report['content_script_home_page'] = b.evaluate("""(() => ({
                    host: location.hostname,
                    title: document.title,
                    buttonInjected: !!document.getElementById('imagegrab-float-btn'),
                    expected: '不应注入'
                }))()""")
                # 用扩展自己的逻辑解释为什么（在页面主世界里重新执行一遍判定）
                report['content_script_home_page_reason'] = b.evaluate("""(() => {
                    const DETAIL_URL_PATTERNS = [/^item\\.taobao\\.com$/i];
                    const DETAIL_PATH_HINTS = ['/item','/detail','/product','/goods','/sku','item.htm','item.html','detail.htm'];
                    const DETAIL_DOM_HINTS = ['tb-detail','tm-detail','jd-detail','detailmeta','j_detail',
                        'main-pic','mainpic','sku-name','skuname','product-param','item-name','itemname','price-panel','tb-sku'];
                    const NOT_DETAIL_HINTS = ['tm-home','tb-home','j_home','home-page','homepage',
                        'search-result','search-list','searchlist','search-page','category','cate-',
                        'breadcrumb-list','goodslist','goods-list','itemlist','item-list','product-list','productlist'];
                    const nodes = document.querySelectorAll('[class],[id]');
                    const tokens = [];
                    for (let i = 0; i < Math.min(nodes.length, 4000); i++) {
                        const t = ((nodes[i].className || '') + ' ' + (nodes[i].id || '')).toString().toLowerCase();
                        if (t) tokens.push(t);
                    }
                    const notDetail = tokens.some(t => NOT_DETAIL_HINTS.some(k => t.includes(k)));
                    const hostHit = DETAIL_URL_PATTERNS.some(re => re.test(location.hostname));
                    const path = (location.pathname + location.search).toLowerCase();
                    const pathHit = DETAIL_PATH_HINTS.find(k => path.includes(k)) || null;
                    const domHits = tokens.filter(t => DETAIL_DOM_HINTS.some(k => t.includes(k))).slice(0, 5);
                    return { path, notDetail, hostHit, pathHit, domHitCount: domHits.length, domHits,
                             wouldInject: !notDetail && (hostHit || pathHit || domHits.length >= 2) };
                })()""")
                b.screenshot(os.path.join(OUT, 'content_script_home_no_button.png'), 1280, 900)

                # 正例：商品详情页应当注入按钮
                t = b.new_tab(url)
                time.sleep(4.5)
                b.attach(t['webSocketDebuggerUrl'])
                report['content_script'] = b.evaluate("""(() => {
                    const btn = document.getElementById('imagegrab-float-btn');
                    const cs = btn ? getComputedStyle(btn) : null;
                    const r = btn ? btn.getBoundingClientRect() : null;
                    return {
                        host: location.hostname,
                        title: document.title,
                        buttonInjected: !!btn,
                        buttonText: btn ? (btn.innerText || '').trim() : '',
                        buttonVisible: !!(cs && cs.display !== 'none' && r && r.width > 0 && r.height > 0),
                        position: cs ? cs.position : '',
                        bottomRight: !!(r && r.right > innerWidth * 0.6 && r.bottom > innerHeight * 0.6),
                        inViewport: !!(r && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1)
                    };
                })()""")
                b.screenshot(os.path.join(OUT, 'content_script_button.png'), 1280, 900)

                # 点按钮 → 等提取完成 → 看提示
                report['content_script_extract'] = b.evaluate("""(async () => {
                    const btn = document.getElementById('imagegrab-float-btn');
                    if (!btn) return { clicked: false };
                    btn.click();
                    for (let i = 0; i < 150; i++) {
                        await new Promise(r => setTimeout(r, 400));
                        const tip = document.getElementById('imagegrab-tip');
                        const txt = tip ? (tip.innerText || '').trim() : '';
                        if (txt.includes('已打开图片库') || txt.includes('没有找到') || txt.includes('失败')) {
                            return { clicked: true, tip: txt };
                        }
                    }
                    const tip = document.getElementById('imagegrab-tip');
                    return { clicked: true, tip: (tip ? tip.innerText : '').trim(), timeout: true };
                })()""", timeout=180)

                time.sleep(2.5)
                # 提取完应当自动打开图片库标签页，并带上真实提取结果
                gallery = [t for t in b.targets() if '/gallery.html' in (t.get('url') or '')]
                report['gallery_opened_after_extract'] = len(gallery) > 0
                if gallery:
                    b.attach(gallery[0]['webSocketDebuggerUrl'])
                    time.sleep(2.0)
                    report['gallery_after_extract'] = b.evaluate("""(() => ({
                        url: location.href.includes('mock=1') ? 'mock' : 'real',
                        cards: document.querySelectorAll('.card').length,
                        total: (document.getElementById('stat-total') || {}).textContent || '',
                        sourceLine: (document.getElementById('source-line') || {}).textContent || ''
                    }))()""")
                    b.screenshot(os.path.join(OUT, 'gallery_from_real_extract.png'), 1500, 900)
            except Exception as e:
                report['content_script'] = {'error': str(e)[:300]}

        report['verdict'] = 'OK'
    except Exception as e:
        report.setdefault('verdict', 'FAIL')
        report['error'] = str(e)
    finally:
        if b:
            b.close()
        if server:
            server.stop()

    with open(os.path.join(OUT, 'extension_verify.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
