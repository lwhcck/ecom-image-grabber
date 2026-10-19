"""
在 Edge 里加载插件，并检查 edge://extensions 页面上的「错误」信息。

用途：确认插件在 Edge 上不仅能加载，而且没有警告/错误（例如 minimum_chrome_version
被 Edge 判为不兼容、权限被拒等）。

用法：python tools/check_edge_extensions_page.py <pluginDir> <outDir>
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

    def targets(self):
        return requests.get(f'http://127.0.0.1:{self.port}/json/list', timeout=5).json()

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

    def evaluate(self, expr, timeout=90):
        res = self.cmd('Runtime.evaluate',
                       {'expression': expr, 'awaitPromise': True, 'returnByValue': True},
                       timeout=timeout)
        if 'exceptionDetails' in res:
            return {'__error__': json.dumps(res['exceptionDetails'], ensure_ascii=False)[:250]}
        return res.get('result', {}).get('value')

    def screenshot(self, path, width=1400, height=1000):
        self.cmd('Emulation.setDeviceMetricsOverride',
                 {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': False})
        res = self.cmd('Page.captureScreenshot', {'format': 'png'}, timeout=90)
        with open(path, 'wb') as f:
            f.write(base64.b64decode(res['data']))
        return os.path.getsize(path)


def deep_text(expr):
    """在 shadow DOM 里递归取文本（edge://extensions 用了大量 Web Component）"""
    return """(() => {
        const out = [];
        const walk = (root) => {
            if (!root) return;
            const els = root.querySelectorAll('*');
            for (const el of els) {
                if (el.shadowRoot) walk(el.shadowRoot);
            }
            const txt = (root.textContent || '').trim();
            if (txt) out.push(txt);
        };
        walk(document);
        return out.join('\\n').slice(0, 20000);
    })()"""


def main():
    report = {}
    port = free_port()
    profile = os.path.join(os.environ.get('TEMP', '.'), 'edge-ext-page-' + str(port))
    shutil.rmtree(profile, ignore_errors=True)
    args = [
        EDGE, '--headless=new', '--disable-gpu', '--no-sandbox',
        f'--remote-debugging-port={port}', '--remote-allow-origins=*',
        f'--user-data-dir={profile}', '--no-first-run', '--no-default-browser-check',
        f'--load-extension={PLUGIN}', f'--disable-extensions-except={PLUGIN}',
        '--window-size=1400,1000', 'about:blank',
    ]
    log = open(os.path.join(os.environ.get('TEMP', '.'), 'edge-ext-page.log'), 'wb')
    proc = subprocess.Popen(args, stdout=log, stderr=log)
    try:
        c = Cdp(port)
        if not c.wait():
            report['verdict'] = 'FAIL'
            report['error'] = 'Edge 未就绪'
            return

        ver = requests.get(f'http://127.0.0.1:{port}/json/version', timeout=5).json()
        report['browser'] = ver.get('Browser')

        # 扩展的 Service Worker 是否起来
        sw = None
        for _ in range(60):
            mine = [t for t in c.targets() if 'service_worker' in (t.get('type') or '')
                    and (t.get('url') or '').endswith('/background.js')]
            if mine:
                sw = mine[0]
                break
            time.sleep(0.5)
        report['service_worker_running'] = bool(sw)

        # 打开 edge://extensions，抓页面文本，找错误/警告
        tab = c.new_tab('edge://extensions/')
        time.sleep(3.0)
        c.attach(tab['webSocketDebuggerUrl'])
        report['page_url'] = c.evaluate('location.href')
        text = c.evaluate(deep_text(None))
        report['page_text_len'] = len(text) if isinstance(text, str) else 0
        if isinstance(text, str):
            low = text.lower()
            report['mentions_extension_name'] = ('imagegrab' in low) or ('图提取' in text)
            report['mentions_error'] = ('错误' in text) or ('error' in low)
            report['mentions_warning'] = ('警告' in text) or ('warning' in low)
            report['mentions_removed'] = ('已移除' in text) or ('removed' in low)
            # 截取可能的错误片段
            snippets = []
            for kw in ['错误', '警告', '不兼容', 'incompatible', '无法', 'failed']:
                idx = text.find(kw)
                if idx >= 0:
                    snippets.append(text[max(0, idx - 120): idx + 200].replace('\n', ' '))
            report['snippets'] = snippets[:5]
            report['page_text_head'] = text[:800]
        report['screenshot'] = os.path.join(OUT, 'edge_extensions_page.png')
        c.screenshot(report['screenshot'])

        report['verdict'] = 'OK'

    except Exception as e:
        report['verdict'] = 'FAIL'
        report['error'] = str(e)
    finally:
        try:
            proc.terminate()
        except Exception:
            pass
        try:
            log.close()
        except Exception:
            pass

    with open(os.path.join(OUT, 'edge_extensions_check.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
