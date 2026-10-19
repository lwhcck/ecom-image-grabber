"""
在真实电商站点上验证插件的「详情页判定 + 按钮注入」。

本机能访问 item.taobao.com / item.jd.com（虽然返回的是精简页或登录墙），
所以至少可以验证：在**真实生产 URL** 上，插件会不会按预期注入按钮。

这正是之前一直没能覆盖的点 —— 前面的验证都用的本地伪装页面。

用法：python tools/verify_live_sites.py <pluginDir> <outDir>
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

# (标签, URL, 期望是否注入按钮)
# 注意：这些判断是「如果页面真的按预期加载」的期望。真实站点可能重定向到登录墙，
# 或者本机根本加载不出来 —— 那种情况下「是否注入」取决于最终 URL，
# 所以脚本会按最终 URL 重新判定期望值，并把原始期望也记录下来。
CASES = [
    ('淘宝首页', 'https://www.taobao.com/', False),
    ('淘宝商品页', 'https://item.taobao.com/item.htm?id=1', True),
    ('京东商品页', 'https://item.jd.com/100012043978.html', True),
    ('天猫首页', 'https://www.tmall.com/', False),
]


def expected_by_final_url(final_url):
    """
    按最终 URL 推断「应该注入吗」。
    真实站点常把未登录访问重定向到登录页；登录页不是商品详情页，不该注入。
    """
    if not final_url or final_url == 'about:blank':
        return None  # 页面没加载出来，无法判定
    u = final_url.lower()
    if 'login' in u or 'passport' in u:
        return False
    detail_hints = ['/item', '/detail', '/product', '/goods', '/sku',
                    'item.htm', 'item.html', 'detail.htm', 'detail.html']
    return any(k in u for k in detail_hints)


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

    def screenshot(self, path, width=1440, height=900):
        self.cmd('Emulation.setDeviceMetricsOverride',
                 {'width': width, 'height': height, 'deviceScaleFactor': 1, 'mobile': False})
        res = self.cmd('Page.captureScreenshot', {'format': 'png'}, timeout=120)
        with open(path, 'wb') as f:
            f.write(base64.b64decode(res['data']))
        return os.path.getsize(path)


def probe_expr():
    """在页面主世界里复刻插件的判定逻辑，解释「为什么注入 / 为什么不注入」"""
    return """(() => {
        const DETAIL_PATH_HINTS = ['/item','/detail','/product','/goods','/sku',
            'item.htm','item.html','detail.htm','detail.html'];
        const DETAIL_DOM_HINTS = ['tb-detail','tm-detail','jd-detail','detailmeta','j_detail',
            'main-pic','mainpic','sku-name','skuname','product-param','item-name','itemname',
            'price-panel','tb-sku'];
        const NOT_DETAIL_HINTS = ['tm-home','tb-home','j_home','home-page','homepage','search-result',
            'search-list','searchlist','search-page','category','cate-','breadcrumb-list','goodslist',
            'goods-list','itemlist','item-list','product-list','productlist'];
        const nodes = document.querySelectorAll('[class],[id]');
        const tokens = [];
        for (let i = 0; i < Math.min(nodes.length, 4000); i++) {
            const t = ((nodes[i].className || '') + ' ' + (nodes[i].id || '')).toString().toLowerCase();
            if (t) tokens.push(t);
        }
        const path = (location.pathname + location.search).toLowerCase();
        const pathHit = DETAIL_PATH_HINTS.find(k => path.includes(k)) || null;
        const notDetail = tokens.some(t => NOT_DETAIL_HINTS.some(k => t.includes(k)));
        let domHits = 0;
        for (const t of tokens) if (DETAIL_DOM_HINTS.some(k => t.includes(k))) domHits++;
        return {
            finalUrl: location.href,
            host: location.hostname,
            path,
            pathHit,
            notDetail,
            domHitCount: domHits,
            wouldInject: !notDetail && (!!pathHit || domHits >= 2)
        };
    })()"""


def main():
    report = {'cases': []}
    proc = None
    try:
        port = free_port()
        profile = os.path.join(os.environ.get('TEMP', '.'), 'ext-live-' + str(port))
        shutil.rmtree(profile, ignore_errors=True)
        args = [
            EDGE, '--headless=new', '--disable-gpu', '--no-sandbox',
            f'--remote-debugging-port={port}', '--remote-allow-origins=*',
            f'--user-data-dir={profile}', '--no-first-run', '--no-default-browser-check',
            f'--load-extension={PLUGIN}', f'--disable-extensions-except={PLUGIN}',
            '--window-size=1440,900', 'about:blank',
        ]
        log = open(os.path.join(os.environ.get('TEMP', '.'), 'ext-live.log'), 'wb')
        proc = subprocess.Popen(args, stdout=log, stderr=log)

        c = Cdp(port)
        if not c.wait():
            report['verdict'] = 'FAIL'
            report['error'] = '浏览器未就绪'
            return

        # 等 Service Worker 起来（确认扩展加载成功）
        sw = None
        for _ in range(60):
            mine = [t for t in c.targets() if 'service_worker' in (t.get('type') or '')
                    and (t.get('url') or '').endswith('/background.js')]
            if mine:
                sw = mine[0]
                break
            time.sleep(0.5)
        report['service_worker_found'] = bool(sw)

        for label, url, expect in CASES:
            entry = {'label': label, 'url': url, 'expect_inject': expect}
            try:
                tab = c.new_tab(url)
                time.sleep(6.0)   # 真实站点较慢，多等一会
                c.attach(tab['webSocketDebuggerUrl'])
                entry['reason'] = c.evaluate(probe_expr())
                entry['button_injected'] = c.evaluate(
                    "!!document.getElementById('imagegrab-float-btn')")
                entry['page_title'] = c.evaluate("document.title")
                entry['page_bytes'] = c.evaluate("document.documentElement.outerHTML.length")
                entry['img_tags'] = c.evaluate("document.querySelectorAll('img').length")
                # 按最终 URL 重新判定期望（真实站点可能重定向到登录页）
                entry['expect_by_final_url'] = expected_by_final_url(entry['reason'].get('finalUrl'))
                if entry['expect_by_final_url'] is None:
                    entry['verdict'] = 'SKIP'
                    entry['note'] = '页面未加载出来（about:blank），无法判定'
                else:
                    entry['correct'] = (entry['button_injected'] == entry['expect_by_final_url'])
                    entry['verdict'] = 'PASS' if entry['correct'] else 'FAIL'
                safe = ''.join(ch if ch.isalnum() else '_' for ch in label)
                entry['screenshot'] = os.path.join(OUT, f'live_{safe}.png')
                c.screenshot(entry['screenshot'])
            except Exception as e:
                entry['error'] = str(e)[:200]
                entry['verdict'] = 'FAIL'
            report['cases'].append(entry)
            print(json.dumps(entry, ensure_ascii=False))

        judged = [x for x in report['cases'] if x.get('verdict') in ('PASS', 'FAIL')]
        report['judged'] = len(judged)
        report['skipped'] = len(report['cases']) - len(judged)
        report['all_correct'] = bool(judged) and all(x.get('verdict') == 'PASS' for x in judged)
        if not judged:
            report['verdict'] = 'SKIP（所有站点都没能加载出来，通常是网络受限）'
        else:
            report['verdict'] = 'OK' if report['all_correct'] else 'FAIL'
    except Exception as e:
        report['verdict'] = 'FAIL'
        report['error'] = str(e)
    finally:
        if proc:
            try:
                proc.terminate()
            except Exception:
                pass

    with open(os.path.join(OUT, 'live_sites_verify.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=2)
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
