"""
通用的「等待页面真正渲染完成后再截图」工具（CDP 驱动 Edge）。

用途：作业三 / 作业四的取证截图。相比 `edge --screenshot --virtual-time-budget`，
这里可以显式等待某个条件（例如所有缩略图 naturalWidth>0）成立后再截图，结果稳定可复现。

用法：
  python cdp_capture.py <jobs.json>

jobs.json 结构：
[
  {
    "url": "http://127.0.0.1:8901/gallery-mock.html",
    "out": "…/03_插件运行截图.png",
    "width": 1500, "height": 900,
    "fullPage": true,
    "waitFor": "Array.from(document.querySelectorAll('.card-thumb img')).length>0 && Array.from(document.querySelectorAll('.card-thumb img')).every(i=>i.complete && i.naturalWidth>0)",
    "evalAfter": "document.getElementById('btn-download').click()",
    "extraWaitMs": 1500,
    "title": "图片库"
  }
]
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

EDGE_DEFAULT = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'


def free_port():
    s = socket.socket()
    s.bind(('127.0.0.1', 0))
    port = s.getsockname()[1]
    s.close()
    return port


class Browser:
    def __init__(self, edge):
        self.port = free_port()
        self.profile = os.path.join(os.environ.get('TEMP', '.'), 'edge-cap-' + str(self.port))
        shutil.rmtree(self.profile, ignore_errors=True)
        args = [
            edge, '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
            '--disable-extensions', '--remote-allow-origins=*',
            f'--remote-debugging-port={self.port}',
            f'--user-data-dir={self.profile}',
            '--window-size=1600,1000', 'about:blank',
        ]
        self.log = open(os.path.join(os.environ.get('TEMP', '.'), 'edge-cap.log'), 'wb')
        self.proc = subprocess.Popen(args, stdout=self.log, stderr=self.log)
        self.msg_id = 0
        self.ws = None
        for _ in range(80):
            if self.proc.poll() is not None:
                raise RuntimeError('Edge 提前退出，退出码 ' + str(self.proc.returncode))
            try:
                targets = requests.get(f'http://127.0.0.1:{self.port}/json', timeout=2).json()
                pages = [t for t in targets if t.get('type') == 'page']
                if not pages:
                    requests.put(f'http://127.0.0.1:{self.port}/json/new?about:blank', timeout=3)
                    time.sleep(0.4)
                    continue
                self.ws = websocket.create_connection(pages[0]['webSocketDebuggerUrl'],
                                                      timeout=60, max_size=300 * 1024 * 1024)
                break
            except Exception:
                time.sleep(0.5)
        if self.ws is None:
            raise RuntimeError('无法连接 Edge 调试端口')
        self.cmd('Page.enable')
        self.cmd('Runtime.enable')

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
                    raise RuntimeError(f'{method} 失败: {msg["error"]}')
                return msg.get('result', {})
        raise TimeoutError(method)

    def evaluate(self, expr, timeout=90):
        res = self.cmd('Runtime.evaluate',
                       {'expression': expr, 'awaitPromise': True, 'returnByValue': True},
                       timeout=timeout)
        if 'exceptionDetails' in res:
            raise RuntimeError('JS 异常: ' + json.dumps(res['exceptionDetails'], ensure_ascii=False)[:300])
        return res.get('result', {}).get('value')

    def viewport(self, w, h, mobile=False):
        self.cmd('Emulation.setDeviceMetricsOverride',
                 {'width': w, 'height': h, 'deviceScaleFactor': 1, 'mobile': mobile})

    def shot(self, path, full_page=False):
        params = {'format': 'png', 'captureBeyondViewport': bool(full_page)}
        if full_page:
            metrics = self.cmd('Page.getLayoutMetrics')
            size = metrics.get('cssContentSize') or metrics.get('contentSize')
            params['clip'] = {'x': 0, 'y': 0, 'width': size['width'], 'height': size['height'], 'scale': 1}
        res = self.cmd('Page.captureScreenshot', params, timeout=180)
        with open(path, 'wb') as f:
            f.write(base64.b64decode(res['data']))
        return os.path.getsize(path)

    def close(self):
        try:
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
    jobs_path = sys.argv[1]
    edge = sys.argv[2] if len(sys.argv) > 2 else EDGE_DEFAULT
    jobs = json.load(open(jobs_path, encoding='utf-8-sig'))

    b = Browser(edge)
    report = []
    try:
        for job in jobs:
            b.viewport(job.get('width', 1440), job.get('height', 900), job.get('mobile', False))
            b.cmd('Page.navigate', {'url': job['url']})
            time.sleep(job.get('loadWaitMs', 1500) / 1000.0)

            wait_for = job.get('waitFor')
            ok = True
            if wait_for:
                deadline = time.time() + job.get('waitTimeoutMs', 30000) / 1000.0
                ok = False
                while time.time() < deadline:
                    try:
                        if b.evaluate(wait_for):
                            ok = True
                            break
                    except Exception:
                        pass
                    time.sleep(0.4)

            if job.get('evalAfter'):
                b.evaluate(job['evalAfter'])
            if job.get('extraWaitMs'):
                time.sleep(job['extraWaitMs'] / 1000.0)

            out = job['out']
            os.makedirs(os.path.dirname(out), exist_ok=True)
            size = b.shot(out, job.get('fullPage', False))
            title = b.evaluate('document.title')
            report.append({'title': job.get('title', ''), 'out': out, 'bytes': size,
                           'wait_ok': ok, 'page_title': title})
            print(f"  [{'OK ' if ok else 'WARN'}] {job.get('title','')} → {out} ({size} bytes)  页面标题={title}")
    finally:
        b.close()

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
