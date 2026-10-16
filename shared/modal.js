// Offers / promo popups auto-closer — Croma page aur Juspay iframe dono me chalta hai
(() => {
  if (globalThis.CromaModal) return;
  const D = globalThis.CromaDom;

  // ---------- Popup / modal auto-closer (har step pe) ----------
  const MODAL_SEL = [
    "[role='dialog']", "[aria-modal='true']",
    "[class*='modal' i]", "[class*='popup' i]", "[class*='dialog' i]", "[class*='overlay' i]"
  ].join(",");
  const CLOSE_TEXT = /^(×|✕|✖|x|close|no thanks|not now|maybe later|skip|dismiss)$/;
  const CLOSE_CLASS = /(^|[\s_-])close([\s_-]|$)|closeicon|close-?btn|btn-?close|modal-?close|close-?button|close-?icon/i;
  // OTP safety text se nahi: Pay click pe closer force-stop hota hai, aur iframe wale popup skip hote hain.
  // (Croma offers popup me "OTP page" likha hota hai, isliye text check se wo skip ho jaata tha)
  // Login popup tabhi maano jab usme mobile/text input ho (offers list me "login" word aane se skip na ho)
  const LOGIN_RX = /enter (your )?mobile number|login|sign ?in/;
  // Flow ke zaroori popups
  const FLOW_RX = /added to (your )?cart|go to cart|view cart|out of stock|proceed to payment|place order (&|and) pay/;

  function shouldKeep(modal) {
    const t = D.textOf(modal);
    if (FLOW_RX.test(t)) return true;
    if (modal.querySelector("iframe")) return true; // bank / payment iframe wala popup kabhi nahi
    if (LOGIN_RX.test(t) && modal.querySelector("input[type='tel'], input[type='text'], input[type='number'], input:not([type])")) return true;
    return false;
  }

  // Jaane-pehchane close buttons (Croma offers popup: button.paymentOffer-closeButton-hotfix)
  const KNOWN_CLOSE = [
    ".paymentOffer-closeButton-hotfix",
    "[class*='closeButton' i]",
    "[class*='close-button' i]",
    "[class*='CloseButton' i]",
    "button[aria-label*='close' i]"
  ].join(",");

  let killerTimer = null;
  const stuckCount = new WeakMap();

  function classOf(el) {
    return typeof el.className === "string" ? el.className : el.className?.baseVal || "";
  }

  function clickEl(el) {
    const target = el.closest("button, [role='button'], a") || el;
    if (typeof target.click === "function") target.click();
    else target.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  }

  function findCloseBtn(root) {
    const known = [...root.querySelectorAll(KNOWN_CLOSE)].find((el) => D.isVisible(el));
    if (known) return known;
    const els = root.querySelectorAll("button, [role='button'], a, span, div, i, svg, img");
    for (const el of els) {
      if (!D.isVisible(el)) continue;
      const aria = D.normalize(el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt") || "");
      if (/close|dismiss/.test(aria)) return el;
      if (CLOSE_CLASS.test(classOf(el))) return el;
      if (el.children.length === 0 && CLOSE_TEXT.test(D.textOf(el))) return el;
    }
    return null;
  }

  function isFloating(el) {
    for (let p = el, i = 0; p && i < 6; p = p.parentElement, i++) {
      const pos = (p.ownerDocument.defaultView || window).getComputedStyle(p).position;
      if (pos === "fixed" || pos === "absolute") return true;
    }
    return false;
  }

  function closeModalsOnce() {
    const modals = [...document.querySelectorAll(MODAL_SEL)].filter(
      (el) => D.isVisible(el) && isFloating(el) && D.textOf(el).length > 0
    );
    for (const modal of modals) {
      if (shouldKeep(modal)) continue;
      const btn = findCloseBtn(modal) || (modal.parentElement && findCloseBtn(modal.parentElement));
      if (btn) {
        clickEl(btn);
        return true;
      }
      // Close button nahi mila to 3 tries ke baad Escape dabao
      const n = (stuckCount.get(modal) || 0) + 1;
      stuckCount.set(modal, n);
      if (n >= 3) {
        // MUI dialog Escape apne element pe sunta hai, document pe nahi
        const esc = () => new KeyboardEvent("keydown", { key: "Escape", code: "Escape", keyCode: 27, bubbles: true });
        modal.dispatchEvent(esc());
        document.dispatchEvent(esc());
        stuckCount.set(modal, 0);
      }
    }
    return false;
  }

  function startModalKiller() {
    if (killerTimer) return;
    killerTimer = setInterval(() => {
      try { closeModalsOnce(); } catch { }
    }, 800);
  }

  // Payment page pe popup der se aata hai → closer kam se kam is time tak chalega
  let holdUntilTs = 0;
  let stopTimer = null;

  function holdUntil(ts) {
    holdUntilTs = Math.max(holdUntilTs, ts);
    startModalKiller();
  }

  // force = true sirf Pay click pe (OTP popup kabhi band na ho)
  function stopModalKiller(afterMs = 0, force = false) {
    clearTimeout(stopTimer);
    const delay = force ? 0 : Math.max(afterMs, holdUntilTs - Date.now(), 0);
    if (force) holdUntilTs = 0;
    stopTimer = setTimeout(() => {
      clearInterval(killerTimer);
      killerTimer = null;
    }, delay);
  }

  // Background bolega kab band karna hai (pay click / final result)
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg?.type === "STOP_MODAL_KILLER") stopModalKiller(Number(msg.afterMs) || 0, !!msg.force);
  });

  globalThis.CromaModal = { start: startModalKiller, stop: stopModalKiller, holdUntil };
})();
