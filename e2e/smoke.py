"""Browser smoke test. Start the server first (mock provider), then: python3 e2e/smoke.py http://127.0.0.1:3111"""
import sys, time
from playwright.sync_api import sync_playwright
base = sys.argv[1] if len(sys.argv) > 1 else 'http://127.0.0.1:3111'
email = f'smoke{int(time.time())}@x.com'
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(viewport={'width': 390, 'height': 780}); errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    pg.goto(base); pg.fill('input[type=email]', email); pg.click('text=New here'); pg.fill('input[type=password]', 'password123'); pg.click('button.primary')
    pg.wait_for_selector('textarea')
    pg.fill('textarea', 'Hello Naru'); pg.keyboard.press('Enter'); pg.wait_for_selector('.actions', timeout=15000)   # reply finished (Copy button shown)
    assert 'Hello Naru' in pg.inner_text('.thread')
    pg.check('.long input'); pg.fill('textarea', 'Write a detailed guide about tea'); pg.click('button.send'); pg.wait_for_selector('text=Summary', timeout=15000)
    pg.reload(); pg.wait_for_selector('textarea'); pg.click('button.menu'); pg.click('text=Hello Naru'); pg.wait_for_selector('.st-code')   # history survives a reload
    pg.fill('input[type=search]', 'zzzz'); pg.wait_for_selector('text=No chats match')
    assert pg.evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'horizontal scroll'
    assert not errs, errs
    pg.context.clear_cookies(); pg.goto(base); pg.wait_for_selector('text=Sign in to keep chatting')   # signed out -> auth screen
    print('SMOKE OK'); b.close()
