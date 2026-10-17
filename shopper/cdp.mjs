// A minimal Chrome DevTools Protocol client for the Chromium that runs on the home machine (built-in WebSocket only).
// The browser keeps its own profile, so the store login and the Cloudflare clearance stay between orders.

export class Browser {
  static async connect(port = 9222) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    const pages = targets.filter((t) => t.type === 'page');
    // One tab only, so a person who opens the remote view sees the same page as the shopper.
    for (const extra of pages.slice(1)) await fetch(`http://127.0.0.1:${port}/json/close/${extra.id}`);
    const page = pages[0] ?? await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
    const b = new Browser(page.webSocketDebuggerUrl);
    await b.ready;
    await b.send('Page.enable');
    return b;
  }

  constructor(wsUrl) {
    this.id = 0;
    this.pending = new Map();
    this.ws = new WebSocket(wsUrl);
    this.ws.onmessage = (e) => {
      const m = JSON.parse(e.data);
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (m.error) p.reject(new Error(`${p.method}: ${m.error.message}`));
      else p.resolve(m.result);
    };
    this.ready = new Promise((resolve, reject) => { this.ws.onopen = resolve; this.ws.onerror = reject; });
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject, method });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.delete(id)) reject(new Error(`${method}: timeout`)); }, 60_000);
    });
  }

  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await this.settle();
  }

  // Wait for the page to load and stop changing (SPA pages keep loading after the load event).
  async settle(ms = 1500) {
    for (let i = 0; i < 20; i++) {
      await sleep(500);
      if ((await this.eval('document.readyState').catch(() => 'loading')) === 'complete') break;
    }
    await sleep(ms);
  }

  title() { return this.eval('document.title'); }
  url() { return this.eval('location.href'); }

  // Visible interactive elements get a number (data-shop-i), plus the visible text of the page.
  snapshot(maxText = 6000) {
    return this.eval(`(() => {
      const cardOf = (el) => {
        for (let p = el.parentElement, n = 0; p && n < 6; p = p.parentElement, n++) if (p.getBoundingClientRect().width > 2) return p;
        return null;
      };
      const sel = 'a[href],button,input,select,textarea,[role=button],[role=link],[role=tab],[role=checkbox],[role=option],[onclick],[tabindex]:not([tabindex="-1"])';
      document.querySelectorAll('[data-shop-i]').forEach((e) => e.removeAttribute('data-shop-i'));
      const out = [];
      for (const el of document.querySelectorAll(sel)) {
        let r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        // Product buttons (add to cart, +/-) show only when the mouse is over the card: number them by the card's place.
        // (Not the closed search suggestions, which hold the same buttons.)
        const hover = r.width < 2 && el.tagName === 'BUTTON' && el.getAttribute('aria-label') && !el.closest('[class*=auto-complete], [class*=autocomplete], [role=listbox]') ? cardOf(el) : null;
        if (hover) r = hover.getBoundingClientRect();
        else if (r.width < 2 || r.height < 2 || st.visibility === 'hidden' || st.display === 'none') continue;
        if (el.disabled || r.bottom < -400 || r.top > innerHeight + 1600 || el.closest('nav')) continue; // nav: the long category menus
        const i = out.length;
        el.setAttribute('data-shop-i', i);
        const label = (el.getAttribute('aria-label') || el.innerText || el.value || el.getAttribute('placeholder') || el.title || el.alt || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
        const type = el.tagName.toLowerCase() + (el.type && el.tagName === 'INPUT' ? ':' + el.type : '');
        out.push('[' + i + '] ' + type + ' "' + label + '"' + (r.top > innerHeight ? ' (below)' : ''));
        if (out.length >= 220) break;
      }
      const main = document.querySelector('main, [role=main], #main_content') ?? document.body;
      const text = main.innerText.replace(/\\n{2,}/g, '\\n').slice(0, ${maxText});
      return 'URL: ' + location.href + '\\nTITLE: ' + document.title + '\\n\\nELEMENTS:\\n' + out.join('\\n') + '\\n\\nPAGE TEXT:\\n' + text;
    })()`);
  }

  // Facts about one numbered element, for the payment guard.
  describe(i) {
    return this.eval(`(() => {
      const el = document.querySelector('[data-shop-i="${Number(i)}"]');
      if (!el) return null;
      return { text: (el.innerText || el.value || el.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim().slice(0, 120),
        name: el.name || '', id: el.id || '', autocomplete: el.getAttribute('autocomplete') || '', type: el.type || '' };
    })()`);
  }

  async center(i) {
    const at = (hoverFirst) => this.eval(`(() => {
      const el = document.querySelector('[data-shop-i="${Number(i)}"]');
      if (!el) return null;
      let box = el;
      if (${hoverFirst}) while (box.getBoundingClientRect().width < 2 && box.parentElement) box = box.parentElement;
      box.scrollIntoView({ block: 'center' });
      const r = box.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2, hidden: el.getBoundingClientRect().width < 2 };
    })()`);
    let box = await at(false);
    if (!box) throw new Error(`no element ${i}; take a new snapshot`);
    if (box.hidden) {
      // Move the mouse over its card, so the button appears.
      const card = await at(true);
      await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: card.x, y: card.y });
      await sleep(600);
      box = await at(false);
    }
    return box;
  }

  async click(i) {
    const { x, y, hidden } = await this.center(i);
    if (hidden) {
      // Still hidden after the hover: the page's own click handler.
      await this.eval(`document.querySelector('[data-shop-i="${Number(i)}"]').click()`);
      return this.settle(1200);
    }
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 });
    }
    await this.settle(1200);
  }

  async type(i, text, enter = false) {
    await this.click(i);
    await this.eval(`(() => { const el = document.querySelector('[data-shop-i="${Number(i)}"]'); if (el && 'value' in el) el.select?.(); })()`);
    await this.send('Input.insertText', { text });
    if (enter) {
      for (const type of ['keyDown', 'keyUp']) {
        await this.send('Input.dispatchKeyEvent', { type, key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: type === 'keyDown' ? '\r' : undefined });
      }
    }
    await this.settle(1500);
  }

  async scroll(down = true) {
    await this.eval(`scrollBy(0, ${down ? 1 : -1} * innerHeight * 0.8)`);
    await sleep(800);
  }

  close() { this.ws.close(); }
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
