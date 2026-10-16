(() => {
  function normalize(text) {
    return String(text || "").replace(/\s+/g, " ").trim().toLowerCase();
  }

  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const style = (el.ownerDocument?.defaultView || window).getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textOf(el) {
    return normalize(el?.innerText || el?.textContent || el?.value || "");
  }

  const CLICKABLE = "button, a, [role='button'], input[type='button'], input[type='submit']";

  // Pehla visible clickable element jiska text regex se match kare
  function findByText(regex) {
    return [...document.querySelectorAll(CLICKABLE)].find((el) => isVisible(el) && regex.test(textOf(el))) || null;
  }

  function isDisabled(el) {
    if (!el) return true;
    const cls = typeof el.className === "string" ? el.className : "";
    return !!(el.disabled || el.getAttribute("aria-disabled") === "true" || /\bdisabled\b/i.test(cls));
  }

  function pageText() {
    return normalize(document.body?.innerText || "");
  }

  // Document + saare shadow roots + same-origin iframes (payment widgets aksar inme hote hain)
  function allRoots(includeFrames = true) {
    const queue = [document];
    const out = [];
    while (queue.length) {
      const root = queue.shift();
      out.push(root);
      for (const el of root.querySelectorAll("*")) {
        if (el.shadowRoot) queue.push(el.shadowRoot);
        if (includeFrames && el.tagName === "IFRAME") {
          try {
            const d = el.contentDocument;
            if (d?.documentElement) queue.push(d);
          } catch { /* cross-origin */ }
        }
      }
    }
    return out;
  }

  function deepQueryAll(selector, includeFrames = true) {
    return allRoots(includeFrames).flatMap((r) => [...r.querySelectorAll(selector)]);
  }

  function findByTextDeep(regex, includeFrames = true) {
    return deepQueryAll(CLICKABLE, includeFrames).find((el) => isVisible(el) && regex.test(textOf(el))) || null;
  }

  // Cross-origin iframes (inke andar extension abhi nahi dekh sakta) — diagnosis ke liye
  function crossOriginFrames() {
    const hosts = [];
    for (const root of allRoots()) {
      for (const f of root.querySelectorAll("iframe")) {
        let accessible = false;
        try { accessible = !!f.contentDocument; } catch { }
        if (accessible) continue;
        try { hosts.push(new URL(f.src, location.href).host || "(no src)"); } catch { hosts.push("(bad src)"); }
      }
    }
    return [...new Set(hosts)];
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function waitFor(predicate, timeoutMs = 15000, intervalMs = 400) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const result = predicate();
      if (result) return result;
      await sleep(intervalMs);
    }
    return null;
  }

  globalThis.CromaDom = { normalize, isVisible, textOf, findByText, isDisabled, pageText, sleep, waitFor, allRoots, deepQueryAll, findByTextDeep, crossOriginFrames };
})();
