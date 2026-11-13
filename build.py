#!/usr/bin/env python3
"""Builds the one-page app from src/.

  web/index.html    the iPad app and the web app (reads handwriting with your own API key, saves files on the device)
  web/sw.js         keeps the web app working offline once it has been opened
  dist/claude.html  the version that runs inside Claude (reads handwriting through your Claude account)

Usage: python3 build.py
"""
import hashlib
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, 'src')
PARTS = {'MATH': 'math.js', 'FONT': 'font.js', 'FIT': 'sketchfit.js', 'SOLID': 'solidfit.js', 'SHAPE': 'inkshape.js', 'DATA': 'datafit.js', 'APP': 'app.js'}


def read(name):
    with open(os.path.join(SRC, name), encoding='utf-8') as f:
        return f.read()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, 'w', encoding='utf-8') as f:
        f.write(text)


page = read('shell.html')
for key, name in PARTS.items():
    code = read(name)
    assert '</script' not in code, f'{name} must not contain a closing script tag'
    page = page.replace('/*@@%s@@*/' % key, code)

write(os.path.join(ROOT, 'dist', 'claude.html'), page)

# outside Claude: a home-screen app with its own icon, working offline
HEAD = '''<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="icons/icon-180.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="default">
<meta name="apple-mobile-web-app-title" content="Math Notes">
<meta name="theme-color" content="#f3f5f4">
<script>window.LMN_STANDALONE = true;</script>
'''
SW = '''<script>if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js');</script>
'''
web = page.replace('<title>', HEAD + '<title>', 1).replace('</body>', SW + '</body>', 1)
write(os.path.join(ROOT, 'web', 'index.html'), web)

version = hashlib.sha1(web.encode('utf-8')).hexdigest()[:10]
write(os.path.join(ROOT, 'web', 'sw.js'), read('sw.js').replace('@@VERSION@@', version))
print(f'web/index.html  {len(web):,} bytes  (version {version})')
print(f'dist/claude.html  {len(page):,} bytes')
