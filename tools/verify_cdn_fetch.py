"""
验证「商品图托管在 CDN 域名上时，插件能不能抓到」。

背景：商品详情页在 item.taobao.com，但图片实际在 img.alicdn.com 这类 CDN 上。
Service Worker 的 fetch 要受扩展 host_permissions 约束，如果 CDN 域名不在权限里，
抓图就会失败。本脚本把本地图片服务伪装成 CDN 域名来验证这一点。

用法：python tools/verify_cdn_fetch.py <pluginDir> <outDir> <imageDir>
"""
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
IMAGE_DIR = os.path.abspath(sys.argv[3])
os.makedirs(OUT, exist_ok=True)

EDGE = r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe'
# 用真实的淘宝图片 CDN 域名做映射，验证 host_permissions 覆盖是否到位
CDN_HOST = 'img.alicdn.com'

# 需要验证的域名：前者应成功（在权限内），后者应失败（不在权限内，作为对照）
CASES = [
    ('img.alicdn.com', True, '在 host_permissions 内（*.alicdn.com）'),
    ('not-allowed.example.com', False, '不在 host_permissions 内（对照组）'),
]


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


def main():
    report = {}
    server = Server(IMAGE_DIR)
    proc = None
    try:
        port = free_port()
        profile = os.path.join(os.environ.get('TEMP', '.'), 'ext-cdn-' + str(port))
        shutil.rmtree(profile, ignore_errors=True)
        rules = 'MAP ' + ' '.join(f'{h} 127.0.0.1,' for h, _, _ in CASES).rstrip(',')
        args = [
            EDGE, '--headless=new', '--disable-gpu', '--no-sandbox',
            f'--remote-debugging-port={port}', '--remote-allow-origins=*',
            f'--user-data-dir={profile}', '--no-first-run', '--no-default-browser-check',
            f'--load-extension={PLUGIN}', f'--disable-extensions-except={PLUGIN}',
            f'--host-resolver-rules={rules}',
            'about:blank',
        ]
        log = open(os.path.join(os.environ.get('TEMP', '.'), 'ext-cdn.log'), 'wb')
        proc = subprocess.Popen(args, stdout=log, stderr=log)

        end = time.time() + 60
        while time.time() < end:
            try:
                requests.get(f'http://127.0.0.1:{port}/json/version', timeout=2).json()
                break
            except Exception:
                time.sleep(0.4)

        ws = None
        sw = None
        for _ in range(60):
            targets = requests.get(f'http://127.0.0.1:{port}/json/list', timeout=5).json()
            mine = [t for t in targets if 'service_worker' in (t.get('type') or '')
                    and (t.get('url') or '').endswith('/background.js')]
            if mine:
                sw = mine[0]
                break
            time.sleep(0.5)
        if not sw:
            report['error'] = 'Service Worker 未启动'
            return

        ws = websocket.create_connection(sw['webSocketDebuggerUrl'], timeout=60,
                                         max_size=32 * 1024 * 1024)
        mid = 0

        def cmd(method, params=None, timeout=60):
            nonlocal mid
            mid += 1
            cur = mid
            ws.send(json.dumps({'id': cur, 'method': method, 'params': params or {}}))
            deadline = time.time() + timeout
            while time.time() < deadline:
                ws.settimeout(max(1, deadline - time.time()))
                msg = json.loads(ws.recv())
                if msg.get('id') == cur:
                    return msg.get('result', {})
            raise TimeoutError(method)

        cmd('Runtime.enable')
        for _ in range(60):
            r = cmd('Runtime.evaluate', {'expression':
                     "typeof chrome !== 'undefined' && !!(chrome.runtime && chrome.runtime.id)",
                     'returnByValue': True})
            if r.get('result', {}).get('value') is True:
                break
            time.sleep(0.5)

        # 在 Service Worker 里真的 fetch 这些 URL，看跨域策略是否放行
        results = []
        for host, should_pass, why in CASES:
            url = f'http://{host}:{server.port}/demo_img_01.png'
            expr = """(async () => {
                try {
                    const r = await fetch(%s, { credentials: 'omit', referrerPolicy: 'no-referrer' });
                    const b = await r.blob();
                    return { ok: r.ok, status: r.status, bytes: b.size, type: b.type };
                } catch (e) { return { ok: false, error: String(e) }; }
            })()""" % json.dumps(url)
            res = cmd('Runtime.evaluate', {'expression': expr, 'awaitPromise': True,
                                           'returnByValue': True}, timeout=60)
            val = res.get('result', {}).get('value') or {}
            results.append({'url': url, 'host': host, 'should_pass': should_pass,
                            'reason': why, 'result': val,
                            'verdict': ('PASS' if (val.get('ok') is True) == should_pass else 'FAIL')})

        report['cases'] = results
        report['all_pass'] = all(r['verdict'] == 'PASS' for r in results)
        report['verdict'] = 'OK' if report['all_pass'] else 'FAIL'
    except Exception as e:
        report['verdict'] = 'FAIL'
        report['error'] = str(e)
    finally:
        if proc:
            try:
                proc.terminate()
            except Exception:
                pass
        server.stop()

    with open(os.path.join(OUT, 'cdn_fetch_verify.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
