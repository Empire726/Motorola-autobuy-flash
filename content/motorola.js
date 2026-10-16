// motorola.in — Product → Add to cart → Go to checkout → Shopping Bag (quantity) → Checkout (details) → Pay securely → PayU
(() => {
  if (globalThis.__motoWatcherLoaded) return;
  globalThis.__motoWatcherLoaded = true;

  const D = globalThis.CromaDom;
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const report = (type, extra = {}) =>
    send({ type: "PAGE_RESULT", payload: { type, url: location.href, ...extra } });

  let cfg = {};

  const RX = {
    unavailable: /out of stock|sold out|notify me|coming soon|currently unavailable|not available/,
    bagOos: /out of stock|sold out|currently unavailable|not available|no longer available/,
    bagEmpty: /your (shopping )?bag is empty|your cart is empty|cart is empty|bag is empty/,
    blocked: /access denied|you don't have permission to access|too many requests/,
    login: /^(sign in|log ?in) to continue|enter (your )?otp|verify (with )?otp/
  };

  const isBlocked = () => RX.blocked.test(D.normalize(document.title)) || RX.blocked.test(D.pageText());

  // ---------- Page pehchano ----------
  const addToCartBtn = () => D.findByText(/^add to cart$/);
  const goCheckoutBtn = () => D.findByText(/^go to checkout$/);
  const bagCheckoutBtn = () => D.findByText(/^checkout$/);
  const paySecurelyBtn = () => D.findByText(/^pay securely/);

  function pageType() {
    const t = D.pageText();
    if (paySecurelyBtn() || (/contact information/.test(t) && /shipping information/.test(t))) return "CHECKOUT";
    if (/shopping bag/.test(t) && (bagCheckoutBtn() || RX.bagEmpty.test(t) || RX.bagOos.test(t))) return "BAG";
    if (RX.bagEmpty.test(t) && /shopping bag/.test(t)) return "BAG";
    if (addToCartBtn() || (/\/p(\?|$)/.test(location.pathname + location.search.slice(0, 1)) && RX.unavailable.test(t))) return "PRODUCT";
    return null;
  }

  function getTitle() {
    const h = document.querySelector("h1");
    const t = h?.innerText?.trim() || document.title.replace(/\s*[|-]\s*motorola.*$/i, "").trim();
    return t || "Motorola product";
  }

  // ---------- Typing (React/VTEX inputs) ----------
  async function typeInto(el, text) {
    const doc = el.ownerDocument || document;
    el.focus();
    el.select?.();
    doc.execCommand("delete", false);
    let ok = true;
    for (const ch of String(text)) {
      try { el.setSelectionRange(el.value.length, el.value.length); } catch { }
      if (!doc.execCommand("insertText", false, ch)) ok = false;
      await D.sleep(25);
    }
    if (!ok || D.normalize(el.value) !== D.normalize(text)) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
      setter.call(el, String(text));
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.blur();
    await D.sleep(120);
  }

  function selectOption(sel, text) {
    const want = D.normalize(text);
    const opt = [...sel.options].find((o) => D.normalize(o.textContent) === want) ||
      [...sel.options].find((o) => D.normalize(o.textContent).startsWith(want));
    if (!opt) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value").set;
    setter.call(sel, opt.value);
    sel.dispatchEvent(new Event("input", { bubbles: true }));
    sel.dispatchEvent(new Event("change", { bubbles: true }));
    return true;
  }

  function labelOf(el) {
    if (el.labels?.[0]) return D.textOf(el.labels[0]);
    const aria = el.getAttribute("aria-label") || el.getAttribute("placeholder") || "";
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const lbl = p.querySelector("label, legend, span, p");
      if (lbl && lbl !== el && D.textOf(lbl)) return D.textOf(lbl);
    }
    return D.normalize(aria || el.name || el.id || "");
  }

  function findField(rx) {
    const els = [...document.querySelectorAll("input, select, textarea")].filter(
      (el) => D.isVisible(el) && !el.disabled && !/^(hidden|checkbox|radio|button|submit)$/i.test(el.type)
    );
    return els.find((el) => rx.test(labelOf(el))) ||
      els.find((el) => rx.test(D.normalize([el.name, el.id, el.placeholder, el.getAttribute("autocomplete")].join(" ")))) ||
      null;
  }

  // ---------- STEP 1: Product page ----------
  async function productFlow() {
    if (isBlocked()) return report("BLOCKED");
    const found = await D.waitFor(() => {
      const b = addToCartBtn();
      if (b && !D.isDisabled(b)) return { kind: "BTN", btn: b };
      if (RX.unavailable.test(D.pageText())) return { kind: "UNAVAILABLE" };
      return null;
    }, 20000);
    const title = getTitle();

    if (!found) {
      if (isBlocked()) return report("BLOCKED");
      if (addToCartBtn()) return report("PRODUCT_UNAVAILABLE", { title, reason: "Add to cart disabled" });
      return report("PRODUCT_TIMEOUT", { title });
    }
    if (found.kind === "UNAVAILABLE") {
      const b = await D.waitFor(() => {
        const x = addToCartBtn();
        return x && !D.isDisabled(x) ? x : null;
      }, 2000);
      if (!b) {
        const m = D.pageText().match(RX.unavailable);
        return report("PRODUCT_UNAVAILABLE", { title, reason: m ? m[0] : "Unavailable" });
      }
      found.btn = b;
    }

    found.btn.scrollIntoView({ block: "center" });
    await D.sleep(400);
    found.btn.click();

    // Mini-cart popup: "Go to checkout"
    const go = await D.waitFor(() => goCheckoutBtn(), 10000);
    if (go) {
      await report("PRODUCT_ADDED", { title, confirmed: true, selfNav: true });
      await D.sleep(300);
      go.click();
      return;
    }
    report("PRODUCT_ADDED", { title, confirmed: false });
  }

  // ---------- STEP 2: Shopping Bag (quantity) ----------
  const plusBtn = () =>
    [...document.querySelectorAll("button, [role='button'], span, a")].find((el) => {
      if (!D.isVisible(el)) return false;
      const t = D.textOf(el);
      const a = D.normalize(el.getAttribute("aria-label") || el.getAttribute("title") || "");
      return t === "+" || /increase|increment|plus|add one/.test(a);
    }) || null;

  const minusBtn = () =>
    [...document.querySelectorAll("button, [role='button'], span, a")].find((el) => {
      if (!D.isVisible(el)) return false;
      const t = D.textOf(el);
      const a = D.normalize(el.getAttribute("aria-label") || el.getAttribute("title") || "");
      return t === "−" || t === "-" || /decrease|decrement|minus|remove one/.test(a);
    }) || null;

  function readQty() {
    const p = plusBtn();
    if (!p) return null;
    let box = p.parentElement;
    for (let i = 0; i < 3 && box; i++, box = box.parentElement) {
      const inp = box.querySelector("input");
      if (inp && /^\d+$/.test(inp.value.trim())) return Number(inp.value.trim());
      const m = D.textOf(box).replace(/[+−-]/g, " ").match(/^\s*(\d{1,2})\s*$/);
      if (m) return Number(m[1]);
    }
    return null;
  }

  async function setQuantity(target) {
    for (let i = 0; i < 12; i++) {
      const q = readQty();
      if (q == null) return { ok: false, qty: null };
      if (q === target) return { ok: true, qty: q };
      const btn = q < target ? plusBtn() : minusBtn();
      if (!btn || D.isDisabled(btn)) return { ok: false, qty: q };
      btn.click();
      // Bag update hone ka wait (qty badle tab tak)
      await D.waitFor(() => {
        const n = readQty();
        return n != null && n !== q ? true : null;
      }, 4000, 200);
      await D.sleep(500);
    }
    const q = readQty();
    return { ok: q === target, qty: q };
  }

  async function bagFlow() {
    if (isBlocked()) return report("BLOCKED");
    const pick = () => {
      const t = D.pageText();
      if (RX.bagEmpty.test(t)) return { kind: "EMPTY" };
      if (RX.bagOos.test(t)) return { kind: "OOS" };
      const b = bagCheckoutBtn();
      if (b) return { kind: "BTN", btn: b };
      return null;
    };
    let s = await D.waitFor(pick, 20000);
    if (!s) return report(isBlocked() ? "BLOCKED" : "CART_TIMEOUT", { cartPage: true });
    if (s.kind === "BTN") {
      await D.sleep(1500);
      s = pick() || s;
    }
    if (s.kind === "EMPTY") return report("CART_EMPTY", { cartPage: true });
    if (s.kind === "OOS") return report("CART_OOS", { cartPage: true });

    // Quantity
    const want = Math.max(1, Math.min(10, Number(cfg.quantity) || 1));
    const q = await setQuantity(want);
    if (!q.ok && want > 1) {
      // Max limit / button nahi mila — jitni hui utni se aage badho, alert me batao
      report("QTY_NOTE", { want, got: q.qty });
    }
    // Quantity badhane ke baad OOS aaya?
    if (RX.bagOos.test(D.pageText())) return report("CART_OOS", { cartPage: true, reason: "quantity ke baad out of stock" });

    const btn = bagCheckoutBtn();
    if (!btn || D.isDisabled(btn)) return report("CART_OOS", { cartPage: true, reason: "Checkout disabled" });

    await report("CHECKOUT_CLICKING", { cartPage: true });
    btn.scrollIntoView({ block: "center" });
    await D.sleep(300);
    btn.click();

    const r = await D.waitFor(() => (pageType() === "CHECKOUT" ? "CHECKOUT" : null), 25000);
    if (r) return checkoutFlow();
    report("CHECKOUT_STUCK");
  }

  // ---------- STEP 3: Checkout (Contact + Shipping) ----------
  const FIELDS = [
    { key: "email", rx: /^e-?mail/ },
    { key: "firstName", rx: /^first name/ },
    { key: "lastName", rx: /^last name/ },
    { key: "phone", rx: /^(phone|mobile)/ },
    { key: "pincode", rx: /^pin ?code|^postal|^zip/ },
    { key: "address1", rx: /^address ?(1|line 1)\b/ },
    { key: "address2", rx: /^address ?(2|line 2)\b/ },
    { key: "state", rx: /^state/ },
    { key: "city", rx: /^city/ },
    { key: "fullName", rx: /^full name/ }
  ];

  async function fillProfile() {
    const pr = { ...(cfg.profile || {}) };
    pr.fullName = pr.fullName || [pr.firstName, pr.lastName].filter(Boolean).join(" ");
    // Pincode pehle (city/state khud bhar sakta hai)
    const order = ["email", "firstName", "lastName", "phone", "pincode", "address1", "address2", "state", "city", "fullName"];
    for (const key of order) {
      const val = pr[key];
      if (!val) continue;
      const f = FIELDS.find((x) => x.key === key);
      const el = findField(f.rx);
      if (!el) continue;
      if (el.tagName === "SELECT") {
        if (!el.value || /select/i.test(el.options[el.selectedIndex]?.textContent || "")) selectOption(el, val);
      } else if (!String(el.value || "").trim()) {
        await typeInto(el, val);
        if (key === "pincode") await D.sleep(1500); // city/state auto-fill ka wait
      }
    }
  }

  function emptyRequired() {
    const out = [];
    for (const el of document.querySelectorAll("input, select, textarea")) {
      if (!D.isVisible(el) || el.disabled || /^(hidden|checkbox|radio|button|submit|search)$/i.test(el.type)) continue;
      const lbl = labelOf(el);
      if (/gst|address 2|optional/.test(lbl)) continue;
      const req = el.required || el.getAttribute("aria-required") === "true" || /\*/.test(lbl);
      if (req && !String(el.value || "").trim()) out.push(lbl.replace(/\*/g, "").trim() || "field");
    }
    return out;
  }

  function tickConsent() {
    for (const cb of document.querySelectorAll("input[type='checkbox']")) {
      const box = cb.closest("label, div, p") || cb.parentElement;
      const t = D.textOf(box || cb);
      if (!/i have read and i agree|consent|privacy policy|terms/.test(t)) continue;
      if (/news ?letter/.test(t)) continue;
      if (!cb.checked) {
        (cb.labels?.[0] || cb).click();
        if (!cb.checked) cb.click();
      }
      return cb.checked;
    }
    return null;
  }

  async function checkoutFlow() {
    if (isBlocked()) return report("BLOCKED");
    await D.waitFor(() => paySecurelyBtn() || findField(/^e-?mail/), 15000);
    await D.sleep(1000); // saved details load hone do

    await fillProfile();
    await D.sleep(800);

    // Shipping method / payment method (pehle se select na ho to pehla option)
    const prepaid = D.findByText(/^prepaid/) || [...document.querySelectorAll("label, div, span")].find((el) => D.isVisible(el) && /^prepaid/.test(D.textOf(el)) && D.textOf(el).length < 40);
    if (prepaid) prepaid.click();

    const missing = emptyRequired();
    if (missing.length) return report("ADDRESS_INCOMPLETE", { fields: missing.slice(0, 6) });

    const consent = tickConsent();
    await D.sleep(500);

    const btn = await D.waitFor(() => {
      const b = paySecurelyBtn();
      return b && !D.isDisabled(b) ? b : null;
    }, 8000);
    if (!btn) {
      return report("ADDRESS_INCOMPLETE", {
        fields: [consent === false ? "consent checkbox tick nahi hua" : "Pay securely disabled hai"]
      });
    }

    await report("SHIPPING_CLICKING");
    btn.scrollIntoView({ block: "center" });
    await D.sleep(300);
    btn.click();

    // PayU pe redirect — wahan payframe.js kaam karega
    const r = await D.waitFor(() => {
      const t = D.pageText();
      if (/please (enter|select|fill)|is required|invalid (pin|mobile|phone|email)/.test(t)) return "ERR";
      return null;
    }, 12000);
    if (r === "ERR") {
      const m = D.pageText().match(/.{0,40}(please (enter|select|fill)|is required|invalid (pin|mobile|phone|email)).{0,40}/);
      report("ADDRESS_ERROR", { message: m?.[0] || "Form error" });
    }
  }

  async function main() {
    const res = await send({ type: "HELLO" });
    if (!res?.run) return;
    cfg = res;
    try {
      const type = await D.waitFor(pageType, 20000);
      if (!type) return report(isBlocked() ? "BLOCKED" : res.phase === "PRODUCT" ? "PRODUCT_TIMEOUT" : "CART_TIMEOUT");
      if (type === "PRODUCT") {
        if (res.phase !== "PRODUCT") return report("CART_EMPTY"); // galti se product pe aa gaye
        return productFlow();
      }
      if (type === "BAG") return bagFlow();
      if (type === "CHECKOUT") return checkoutFlow();
    } catch (err) {
      report("ERROR", { message: err?.message || String(err) });
    }
  }

  main();
})();
