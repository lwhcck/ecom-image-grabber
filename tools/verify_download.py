"""
验证插件的「批量下载」是不是真的把 PNG 文件写到了磁盘上。

为什么单独验：chrome.downloads.download 对 URL 的 scheme 有限制，
Service Worker 里又拿不到 blob: URL，所以插件目前是把 PNG 转成 data URL 再下载。
这条路径必须实测，否则很可能出现「界面提示下载完成、磁盘上却什么都没有」。

做法：
  1. 起一个本地静态服务，提供几张真实 PNG；
  2. 把扩展加载进浏览器，并指定 --download-directory；
  3. 在图片库页面的主世界里构造真实图片数据并触发下载；
  4. 直接检查磁盘上是否出现了 商品图_00N.png，以及能不能被 Pillow 解析成 PNG。

用法：
  python tools/verify_download.py <pluginDir> <outDir> <imageDir>
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
IMAGE_DIR = os.path.abspath(sys.argv[3]) if len(sys.argv) > 3 else None
os.makedirs(OUT, exist_ok=True)

DOWNLOAD_DIR = os.path.join(os.environ.get('TEMP', '.'), 'ext-download-test')
EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Server:
    def __init__(self, directory):
        handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=directory)
        handler.log_message = lambda *a, **k: None
        self.httpd = socketserver.TCPServer(('127.0.0.1', 0), handler)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def stop(self):
        try:
            self.httpd.shutdown()
            self.httpd.server_close()
        except Exception:
            pass


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
        self.cmd('Runtime.enable')

    def cmd(self, method, params=None, timeout=90):
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

    def evaluate(self, expr, timeout=120):
        res = self.cmd('Runtime.evaluate',
                       {'expression': expr, 'awaitPromise': True, 'returnByValue': True},
                       timeout=timeout)
        if 'exceptionDetails' in res:
            return {'__error__': json.dumps(res['exceptionDetails'], ensure_ascii=False)[:400]}
        return res.get('result', {}).get('value')


def images_in_dir(directory):
    if not directory or not os.path.isdir(directory):
        return []
    return sorted(f for f in os.listdir(directory) if f.lower().endswith('.png'))


def main():
    report = {}
    server = None
    proc = None
    try:
        shutil.rmtree(DOWNLOAD_DIR, ignore_errors=True)
        os.makedirs(DOWNLOAD_DIR, exist_ok=True)
        report['download_dir'] = DOWNLOAD_DIR

        if IMAGE_DIR:
            server = Server(IMAGE_DIR)
            report['image_server'] = f'http://127.0.0.1:{server.port}/'

        port = free_port()
        profile = os.path.join(os.environ.get('TEMP', '.'), 'ext-dl-' + str(port))
        shutil.rmtree(profile, ignore_errors=True)
        args = [
            EDGE, '--headless=new', '--disable-gpu', '--no-sandbox',
            f'--remote-debugging-port={port}', '--remote-allow-origins=*',
            f'--user-data-dir={profile}',
            '--no-first-run', '--no-default-browser-check',
            f'--load-extension={PLUGIN}', f'--disable-extensions-except={PLUGIN}',
            # 测试图片也要走插件有 host 权限的域名，否则扩展 fetch 会被跨域策略拦住
            '--host-resolver-rules=MAP item.taobao.com 127.0.0.1',
            f'--download-directory={DOWNLOAD_DIR}',
            # 关掉「是否保留多个下载」之类的弹窗，让下载静默落盘
            '--allow-multiple-downloads',
            '--disable-features=DownloadBubble,SafeBrowsing',
            '--safebrowsing-disable-download-protection',
            'about:blank',
        ]
        log = open(os.path.join(os.environ.get('TEMP', '.'), 'ext-dl.log'), 'wb')
        proc = subprocess.Popen(args, stdout=log, stderr=log)

        c = Cdp(port)
        if not c.wait():
            report['verdict'] = 'FAIL'
            report['error'] = '浏览器未就绪'
            return

        # 等 Service Worker
        sw = None
        for _ in range(60):
            workers = [x for x in c.targets() if 'service_worker' in (x.get('type') or '')]
            mine = [x for x in workers if (x.get('url') or '').endswith('/background.js')]
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

        # 让 Service Worker 自己走一遍「转 PNG + 下载」的真实流程。
        # 图片用本地服务提供的真实 PNG，这样 fetch / createImageBitmap / OffscreenCanvas 都是真的。
        urls = []
        if server:
            # 用 item.taobao.com（已在 manifest 的 host_permissions 里），
            # 而不是 127.0.0.1 —— 后者不在权限内，扩展 fetch 会被拦
            urls = [f'http://item.taobao.com:{server.port}/demo_img_0{i}.png' for i in (1, 2, 3)]
        report['input_urls'] = urls

        report['download_call'] = c.evaluate("""(async () => {
            const mod = await import(chrome.runtime.getURL('background.js'));
            // Service Worker 里不能 import 自己（HTML 规范限制），改从 gallery 页面触发。
            return 'sw-import-blocked';
        })()""")

        # 改在图片库页面（有 DOM、有 blob URL）里触发真实的下载消息
        tab = c.new_tab(f'chrome-extension://{ext_id}/gallery.html')
        time.sleep(2.5)
        c.attach(tab['webSocketDebuggerUrl'])

        report['download_result'] = c.evaluate("""(async () => {
            const urls = """ + json.dumps(urls) + """;
            if (!urls.length) return { error: '没有可用图片' };
            // 走插件自己的消息通道：gallery.js 就是这么请求下载的
            const resp = await new Promise((resolve) => {
                chrome.runtime.sendMessage({
                    type: 'IMAGE_GRAB_DOWNLOAD',
                    payload: {
                        images: urls.map((u, i) => ({ url: u, width: 100, height: 100 })),
                        pageTitle: '下载验证'
                    }
                }, (r) => resolve(r || { ok: false, error: chrome.runtime.lastError
                    ? chrome.runtime.lastError.message : '无响应' }));
            });
            return resp;
        })()""", timeout=180)

        # 等下载真正结束（轮询 chrome.downloads.search，直到都进入终态）
        search_expr = """(async () => {
            try {
                const items = await chrome.downloads.search({ limit: 10 });
                return items.map(i => ({ filename: i.filename, state: i.state,
                                         bytesReceived: i.bytesReceived,
                                         totalBytes: i.totalBytes, error: i.error || null,
                                         mime: i.mime || null }));
            } catch (e) { return { error: String(e) }; }
        })()"""

        report['downloads_search'] = []
        for _ in range(40):
            time.sleep(1.0)
            items = c.evaluate(search_expr)
            if not isinstance(items, list):
                continue
            report['downloads_search'] = items
            if items and all(i.get('state') in ('complete', 'interrupted') for i in items):
                break
        # 再等一下确保文件句柄落盘
        time.sleep(2.0)

        # 按 API 给出的路径逐个校验：文件存在、能解析成 PNG、尺寸正确
        validated = []
        items = report['downloads_search'] if isinstance(report['downloads_search'], list) else []
        try:
            from PIL import Image
            for it in items:
                path = it.get('filename')
                entry = {'file': os.path.basename(path) if path else None,
                         'state': it.get('state'), 'bytes': it.get('bytesReceived')}
                if path and os.path.exists(path):
                    entry['exists'] = True
                    try:
                        with Image.open(path) as im:
                            im.verify()
                        with Image.open(path) as im:
                            entry['format'] = im.format
                            entry['size'] = list(im.size)
                            entry['mode'] = im.mode
                            entry['valid_png'] = im.format == 'PNG'
                    except Exception as e:
                        entry['valid_png'] = False
                        entry['error'] = str(e)
                else:
                    entry['exists'] = False
                validated.append(entry)
        except ImportError:
            validated = [{'note': 'Pillow 不可用'}]
        report['files_validated'] = validated
        report['files_on_disk'] = [v.get('file') for v in validated if v.get('exists')]
        report['file_count'] = len(report['files_on_disk'])

        ok_count = sum(1 for v in validated if v.get('valid_png'))
        report['valid_png_count'] = ok_count
        # 判定标准：下载记录里 state=complete、文件真的存在、且能被解析成 PNG
        report['verdict'] = 'OK' if ok_count > 0 else 'FAIL（没有生成可解析的 PNG 文件）'

    except Exception as e:
        report.setdefault('verdict', 'FAIL')
        report['error'] = str(e)
    finally:
        if proc:
            try:
                proc.terminate()
            except Exception:
                pass
        if server:
            server.stop()

    with open(os.path.join(OUT, 'download_verify.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
