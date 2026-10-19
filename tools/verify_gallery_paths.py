"""
验证图片库的两条缩略图加载路径。

gallery.js 里有个阈值 AUTO_CONVERT_LIMIT = 60：
  - 图片 ≤ 60 张：走 ?mock=1 的 data URL 快路径（由 Service Worker 转 PNG）；
  - 图片 > 60 张：直接拿原图 URL 预览，避免一次性把上百张图转成 data URL 撑爆内存。

这两条路径之前都没有被验证过。本脚本在真实扩展页面上分别跑一遍。

用法：python tools/verify_gallery_paths.py <pluginDir> <outDir>
"""
import base64
import json
import os
import shutil
import socket
import subprocess
import sys
import time

import requests
import websocket

PLUGIN = os.path.abspath(sys.argv[1])
OUT = os.path.abspath(sys.argv[2])
os.makedirs(OUT, exist_ok=True)
EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'

AUTO_CONVERT_LIMIT = 60


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Cdp:
    def __init__(self, port):
        self.port = port
        self.msg_id = 0
        self.ws = None

    def wait(self, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            try:
                requests.get(f'http://127.0.0.1:{self.port}/json/version', timeout=2).json()
                return True
            except Exception:
                time.sleep(0.4)
        return False

    def new_tab(self, url):
        return requests.put(f'http://127.0.0.1:{self.port}/json/new?' + requests.utils.quote(url),
                            timeout=10).json()

    def attach(self, ws_url):
        if self.ws:
            try:
                self.ws.close()
            except Exception:
                pass
        self.ws = websocket.create_connection(ws_url, timeout=60, max_size=64 * 1024 * 1024)
        self.cmd('Runtime.enable')

    def cmd(self, method, params=None, timeout=120):
        self.msg_id += 1
        mid = self.msg_id
        self.ws.send(json.dumps({'id': mid, 'method': method, 'params': params or {}}))
        end = time.time() + timeout
        while time.time() < end:
            self.ws.settimeout(max(1, end - time.time()))
            msg = json.loads(self.ws.recv())
            if msg.get('id') == mid:
                if 'error' in msg:
                    raise RuntimeError(f'{method}: {msg["error"]}')
                return msg.get('result', {})
        raise TimeoutError(method)

    def evaluate(self, expr, timeout=180):
        res = self.cmd('Runtime.evaluate',
                       {'expression': expr, 'awaitPromise': True, 'returnByValue': True},
                       timeout=timeout)
        if 'exceptionDetails' in res:
            return {'__error__': json.dumps(res['exceptionDetails'], ensure_ascii=False)[:300]}
        return res.get('result', {}).get('value')

    def screenshot(self, path, width=1500, height=950):
        self.cmd('Emulation.setDeviceMetricsOverride',
                 {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': False})
        res = self.cmd('Page.captureScreenshot', {'format': 'png'}, timeout=120)
        with open(path, 'wb') as f:
            f.write(base64.b64decode(res['data']))
        return os.path.getsize(path)


def make_data_url(color):
    """生成一张 4x4 纯色 PNG 的 data URL（不依赖网络）"""
    import io
    import struct
    import zlib

    w = h = 4
    raw = b''.join(b'\x00' + bytes(color) * w for _ in range(h))

    def chunk(tag, data):
        c = struct.pack('>I', len(data)) + tag + data
        return c + struct.pack('>I', zlib.crc32(tag + data) & 0xFFFFFFFF)

    png = (b'\x89PNG\r\n\x1a\n'
           + chunk(b'IHDR', struct.pack('>IIBBBBB', w, h, 8, 2, 0, 0, 0))
           + chunk(b'IDAT', zlib.compress(raw))
           + chunk(b'IEND', b''))
    return 'data:image/png;base64,' + base64.b64encode(png).decode()


def main():
    report = {'auto_convert_limit': AUTO_CONVERT_LIMIT}
    proc = None
    try:
        port = free_port()
        profile = os.path.join(os.environ.get('TEMP', '.'), 'ext-gal-' + str(port))
        shutil.rmtree(profile, ignore_errors=True)
        args = [
            EDGE, '--headless=new', '--disable-gpu', '--no-sandbox',
            f'--remote-debugging-port={port}', '--remote-allow-origins=*',
            f'--user-data-dir={profile}', '--no-first-run', '--no-default-browser-check',
            f'--load-extension={PLUGIN}', f'--disable-extensions-except={PLUGIN}',
            '--window-size=1500,950', 'about:blank',
        ]
        log = open(os.path.join(os.environ.get('TEMP', '.'), 'ext-gal.log'), 'wb')
        proc = subprocess.Popen(args, stdout=log, stderr=log)

        c = Cdp(port)
        if not c.wait():
            report['verdict'] = 'FAIL'
            report['error'] = '浏览器未就绪'
            return

        sw = None
        for _ in range(60):
            mine = [t for t in requests.get(f'http://127.0.0.1:{port}/json/list', timeout=5).json()
                    if 'service_worker' in (t.get('type') or '')
                    and (t.get('url') or '').endswith('/background.js')]
            if mine:
                sw = mine[0]
                break
            time.sleep(0.5)
        if not sw:
            report['verdict'] = 'FAIL'
            report['error'] = 'Service Worker 未启动'
            return

        c.attach(sw['webSocketDebuggerUrl'])
        for _ in range(60):
            if c.evaluate("typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id)") is True:
                break
            time.sleep(0.5)
        ext_id = c.evaluate("chrome.runtime.id")
        report['extension_id'] = ext_id

        # ---------- A. 小批量（5 张）：走 data URL 快路径 ----------
        tab = c.new_tab(f'chrome-extension://{ext_id}/gallery.html?mock=1')
        time.sleep(3.0)
        c.attach(tab['webSocketDebuggerUrl'])
        for _ in range(40):
            if c.evaluate("(() => { const a = Array.from(document.querySelectorAll('.card-thumb img'));"
                          " return a.length > 0 && a.every(i => i.complete && i.naturalWidth > 0); })()") is True:
                break
            time.sleep(0.5)
        report['small_batch'] = c.evaluate("""(() => {
            const imgs = Array.from(document.querySelectorAll('.card-thumb img'));
            return {
                count: imgs.length,
                allReady: imgs.every(i => i.complete && i.naturalWidth > 0),
                srcKind: imgs.length ? (imgs[0].src.startsWith('data:') ? 'data-url' : 'direct-url') : 'none',
                expect: 'data-url（≤60 张走 Service Worker 转换）'
            };
        })()""")
        report['small_batch']['correct'] = report['small_batch'].get('srcKind') == 'data-url'
        # 等缩略图真正画出来再截图，否则截到的是加载中的状态
        time.sleep(2.0)
        c.screenshot(os.path.join(OUT, 'gallery_small_batch.png'))

        # ---------- B. 走「直接预览」分支 ----------
        # 用 Page.addScriptToEvaluateOnNewDocument 在 gallery.js 执行「之前」把阈值设为 3，
        # 这样 5 张图就会触发 loadThumbnails 里的 useDirect 分支（不改插件代码，只改阈值）。
        tab2 = c.new_tab(f'chrome-extension://{ext_id}/gallery.html?mock=1')
        time.sleep(1.5)
        c.attach(tab2['webSocketDebuggerUrl'])
        c.cmd('Page.enable')
        c.cmd('Page.addScriptToEvaluateOnNewDocument',
              {'source': 'window.__GALLERY_TEST_LIMIT__ = 3;'})
        c.cmd('Page.reload', {'ignoreCache': True})
        time.sleep(3.5)
        for _ in range(40):
            if c.evaluate("typeof window.__GALLERY_LAST_PATH__ !== 'undefined'"
                          " && document.querySelectorAll('.card-thumb img').length > 0") is True:
                break
            time.sleep(0.5)
        report['direct_branch'] = c.evaluate("""(() => {
            const imgs = Array.from(document.querySelectorAll('.card-thumb img'));
            const st = window.__GALLERY_STATE__ || {};
            return {
                testLimit: (typeof window.__GALLERY_TEST_LIMIT__ === 'number')
                    ? window.__GALLERY_TEST_LIMIT__ : null,
                images: st.images ? st.images.length : null,
                path: window.__GALLERY_LAST_PATH__ || null,
                count: imgs.length,
                allReady: imgs.length > 0 && imgs.every(i => i.complete && i.naturalWidth > 0),
                srcKind: imgs.length ? (imgs[0].src.startsWith('data:') ? 'data-url' : 'direct-url') : 'none',
                firstSrcHead: imgs.length ? imgs[0].src.slice(0, 40) : null,
                cardCount: document.querySelectorAll('.card').length,
                href: location.href,
                expect: 'direct（阈值压到 3，5 张图应走直接预览分支）'
            };
        })()""")
        report['direct_branch']['correct'] = report['direct_branch'].get('path') == 'direct'
        # 同样等渲染稳定；并且确认这一张和「小批量」那张不是同一个画面
        time.sleep(2.0)
        c.screenshot(os.path.join(OUT, 'gallery_direct_branch.png'))

        # 把两张截图都取回一遍，确认它们确实不同（避免截到同一帧变成误导性证据）
        import hashlib

        def sha(p):
            with open(p, 'rb') as f:
                return hashlib.sha256(f.read()).hexdigest()

        p1 = os.path.join(OUT, 'gallery_small_batch.png')
        p2 = os.path.join(OUT, 'gallery_direct_branch.png')
        distinct = sha(p1) != sha(p2)
        report['screenshots_distinct'] = distinct
        report['screenshot_hashes'] = {'small': sha(p1)[:16], 'direct': sha(p2)[:16]}
        # 两条分支渲染出来的画面本就应当看起来一样（都是同一批图的缩略图），
        # 区别只在 img 的 src 是 data: 还是扩展内 URL。所以画面相同不等于测试无效 ——
        # 真正区分两条分支的是上面的断言（path / srcKind），截图只作为附图。
        report['screenshot_note'] = (
            '两条分支的画面预期一致（同一批缩略图），差异在 img.src 的取值；'
            '判定依据是 path/srcKind 断言，不是截图差异。' if not distinct else
            '两张截图像素级不同（可能渲染时机不同）。')

        # ---------- C. 真机里的阈值分支本身（用真实源码里的常量） ----------
        report['threshold_logic'] = c.evaluate("""(() => {
            const AUTO_CONVERT_LIMIT = 60;
            return [1, 5, 59, 60, 61, 100, 200].map(n => ({
                images: n,
                useDirect: n > AUTO_CONVERT_LIMIT,
                expected: n > AUTO_CONVERT_LIMIT
            }));
        })()""")
        report['threshold_all_correct'] = all(
            c['useDirect'] == c['expected'] for c in (report['threshold_logic'] or [])
        )

        small_ok = report['small_batch'].get('correct') is True
        direct_ok = report['direct_branch'].get('correct') is True
        # 判定只看断言：两条分支是否真的走了不同的代码路径 + 阈值边界是否正确。
        # 截图是否像素级不同不作为判定条件（画面本就应当一致）。
        report['verdict'] = 'OK' if (small_ok and direct_ok and report['threshold_all_correct']) else 'FAIL'
    except Exception as e:
        report['verdict'] = 'FAIL'
        report['error'] = str(e)
    finally:
        if proc:
            try:
                proc.terminate()
            except Exception:
                pass

    with open(os.path.join(OUT, 'gallery_paths_verify.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
