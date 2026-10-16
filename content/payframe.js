// Juspay payment iframe (payments.juspay.in) ke andar chalta hai.
// Har Juspay frame me inject hota hai:
//  - jis frame me payment options (Card/UPI/COD...) hain → method select + Place Order & Pay
//  - jis frame me sirf card fields hain (nested iframe) → sirf apne fields bharta hai
(async () => {
  if (globalThis.__cromaPayFrameLoaded) return;
  globalThis.__cromaPayFrameLoaded = true;

  const D = globalThis.CromaDom;
  const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => null);
  const report = (type, extra = {}) =>
    send({ type: "PAGE_RESULT", payload: { type, url: location.href, ...extra } });

  const res = await send({ type: "FRAME_HELLO" });
  if (!res?.run) return;

  // PayU page pe popup closer nahi chalate (payment panel band na ho jaaye)

  const card = res.card || null;
  const prefs = res.paymentMethods || [];
  const nbBank = D.normalize(res.netbankingBank || "");
  const emiBank = D.normalize(res.emiBank || "");
  const emiTenure = Number(res.emiTenure) || 0;
  const OWN = false; // sirf apna document (+ shadow DOM), nested iframes apna kaam khud karenge

  const METHODS = {
    cod: { label: "COD", rx: /^(cash on delivery|pay on delivery|cod)\b.{0,25}$/ },
    upi: { label: "UPI", rx: /^upi\b.{0,15}$/ },
    card: { label: "Credit/Debit Card", rx: /^(cards? \(credit ?\/ ?debit\)|credit ?\/ ?debit cards?|debit ?\/ ?credit cards?|credit cards?|debit cards?|cards?)$/ },
    emi: { label: "EMI", rx: /^(emi on cards?|emi|easy emi|cardless emi)$/ },
    netbanking: { label: "Netbanking", rx: /^net ?banking$/ }
  };
  const label = (k) => METHODS[k].label;
  const digits = (v) => String(v || "").replace(/\D/g, "");

  function findOption(rx) {
    let best = null;
    for (const el of D.deepQueryAll("li, div, span, p, a, button, label, h3, h4, [role='tab'], [role='button']", OWN)) {
      if (!D.isVisible(el)) continue;
      const t = D.textOf(el);
      if (t.length > 40 || !rx.test(t)) continue;
      if (!best || best.contains(el)) best = el;
    }
    return best;
  }

  const availableMethods = () => Object.keys(METHODS).filter((k) => findOption(METHODS[k].rx));

  function labelOf(el) {
    if (el.labels?.[0]) return el.labels[0].innerText.trim();
    let p = el.parentElement;
    for (let i = 0; i < 3 && p; i++, p = p.parentElement) {
      const lbl = p.querySelector("label");
      if (lbl?.innerText?.trim()) return lbl.innerText.trim();
    }
    return "";
  }

  function findInput(rx, autocomplete) {
    const inputs = D.deepQueryAll("input", OWN).filter((el) => D.isVisible(el) && !el.disabled && !el.readOnly);
    return (
      inputs.find((el) => el.getAttribute("autocomplete") === autocomplete) ||
      inputs.find((el) => {
        const hay = [el.placeholder, el.name, el.id, el.getAttribute("aria-label"), el.getAttribute("data-testid"), labelOf(el)]
          .join(" ").toLowerCase();
        return rx.test(hay);
      }) ||
      null
    );
  }

  const keyEvt = (win, type, ch) =>
    new win.KeyboardEvent(type, { key: ch, code: /\d/.test(ch) ? "Digit" + ch : "", bubbles: true, cancelable: true });

  // Browser ka asli "type" command: trusted beforeinput/input events, caret ke saath —
  // formatters (Juspay expiry "MM/YY") isko keyboard typing jaisa hi maante hain
  async function typeInto(el, text) {
    const doc = el.ownerDocument || document;
    el.focus();
    el.select?.();
    doc.execCommand("delete", false);
    let ok = true;
    for (const ch of String(text)) {
      // Har char se pehle caret end pe (formatter ne "/" daala ho to bhi)
      try { el.setSelectionRange(el.value.length, el.value.length); } catch { }
      if (!doc.execCommand("insertText", false, ch)) ok = false;
      await D.sleep(70);
    }
    if (!ok) await typeFallback(el, text);
    await D.sleep(150);
  }

  // Poora text ek baar me (jaise paste)
  async function insertWhole(el, text) {
    const doc = el.ownerDocument || document;
    el.focus();
    el.select?.();
    doc.execCommand("delete", false);
    doc.execCommand("insertText", false, String(text));
    await D.sleep(150);
  }

  // Purana tareeka (execCommand fail ho tab)
  async function typeFallback(el, text) {
    const win = el.ownerDocument?.defaultView || window;
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
    el.focus();
    setter.call(el, "");
    el.dispatchEvent(new win.Event("input", { bubbles: true }));
    for (const ch of String(text)) {
      el.dispatchEvent(keyEvt(win, "keydown", ch));
      setter.call(el, el.value + ch);
      el.dispatchEvent(new win.InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
      el.dispatchEvent(keyEvt(win, "keyup", ch));
      await D.sleep(45);
    }
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
  }

  // Poori value ek saath (kuch formatters isse hi maante hain)
  async function setAll(el, text) {
    const win = el.ownerDocument?.defaultView || window;
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value").set;
    el.focus();
    setter.call(el, String(text));
    el.dispatchEvent(new win.InputEvent("input", { bubbles: true, data: String(text), inputType: "insertFromPaste" }));
    el.dispatchEvent(new win.Event("change", { bubbles: true }));
    await D.sleep(150);
  }

  // Har tareeka try karo jab tak field me sahi digits na dikhen
  async function fillVerified(el, attempts, expectDigits) {
    for (const [mode, text] of attempts) {
      if (mode === "type") await typeInto(el, text);
      else if (mode === "keys") await typeFallback(el, text);
      else if (mode === "paste") await insertWhole(el, text);
      else await setAll(el, text);
      await D.sleep(250);
      if (digits(el.value) === expectDigits) {
        el.blur();
        return true;
      }
    }
    el.blur();
    return false;
  }

  const cardFields = () => ({
    num: findInput(/card ?(number|no)|cardnumber|card_number/, "cc-number"),
    exp: findInput(/mm ?\/ ?yy|expiry|exp_date|valid ?thru/, "cc-exp"),
    month: findInput(/\bmm\b|exp(iry)?_?month|card_exp_month/, "cc-exp-month"),
    year: findInput(/\byy(yy)?\b|exp(iry)?_?year|card_exp_year/, "cc-exp-year"),
    cvv: findInput(/cvv|cvc|security code|security_code/, "cc-csc"),
    name: findInput(/name on card|card ?holder|name_on_card/, "cc-name")
  });

  // Is document me jo card fields hain, sirf wahi bharo (ek baar)
  let filled = false;
  const fillProblems = [];
  async function fillOwnFields(timeoutMs) {
    if (!card || filled) return 0;
    const f = await D.waitFor(() => {
      const x = cardFields();
      return x.num || x.exp || x.month || x.cvv ? x : null;
    }, timeoutMs);
    if (!f) return 0;
    filled = true;
    let n = 0;
    const num = digits(card.number);
    const [mm, yy] = card.expiry.split("/");
    const cvv = digits(card.cvv);
    const bad = [];

    if (f.num) {
      n++;
      if (!(await fillVerified(f.num, [["type", num], ["set", num]], num))) bad.push("card number");
    }
    if (f.name && card.name) { await typeInto(f.name, card.name); f.name.blur(); n++; }

    // Ek hi expiry box (MM/YY) hai to use combined maano — chahe "month" regex se mila ho.
    // (Bug tha: combined box "month" samjha jaata tha, sirf "01" type hota tha → "01/")
    const separateYear = f.year && f.year !== f.month && f.year !== f.exp;
    const expBox = f.exp || (f.month && !separateYear ? f.month : null);

    if (expBox) {
      f.exp = expBox;
      n++;
      // Pehle sirf digits (field khud "/" lagata hai), phir dusre tareeke
      const ok = await fillVerified(f.exp, [
        // Sirf digits, "/" kabhi nahi — field khud lagata hai (jaise 0133 → 01/33)
        ["type", mm + yy],
        ["paste", mm + yy],
        ["keys", mm + yy],
        ["set", mm + yy]
      ], mm + yy);
      if (!ok) bad.push(`expiry (field me: "${f.exp.value}")`);
    } else if (f.month) {
      n++;
      if (!(await fillVerified(f.month, [["type", mm], ["set", mm]], mm))) bad.push("expiry month");
      if (f.year && f.year !== f.month) {
        const full = f.year.maxLength === 4 ? "20" + yy : yy;
        if (!(await fillVerified(f.year, [["type", full], ["set", full]], full))) bad.push("expiry year");
      }
    }

    if (f.cvv) {
      n++;
      if (!(await fillVerified(f.cvv, [["type", cvv], ["set", cvv]], cvv))) bad.push("cvv");
    }
    if (bad.length) fillProblems.push(...bad);
    return n;
  }

  // ---------- Kaunsa frame hai? ----------
  const hasMethods = await D.waitFor(() => (availableMethods().length ? true : null), 15000);

  if (!hasMethods) {
    // Ye sirf card-field wala nested frame hai (ya koi aur) → apne fields bharo, bas
    await fillOwnFields(20000);
    return;
  }

  // ---------- Method frame ----------
  // Offers popup aane aur band hone ka time do, phir card bharo
  await D.sleep(3000);
  const available = availableMethods();
  const pick = prefs.find((k) => available.includes(k)) || null;

  if (pick) {
    const opt = findOption(METHODS[pick].rx);
    const target = opt.closest("li, button, a, [role='tab'], [role='button']") || opt;
    target.scrollIntoView({ block: "center" });
    await D.sleep(300);
    target.click();
    await D.sleep(1200);
  }

  if (pick === "card" && card) {
    const n = await fillOwnFields(6000); // fields isi frame me ho to; nested frames khud bharenge

    const payBtn = await D.waitFor(() => {
      const b = D.findByTextDeep(/^(place order (&|and) pay|pay ?₹ ?[\d,.]+|proceed( to pay)?|pay now|pay|make payment|continue)$/, OWN);
      return b && !D.isDisabled(b) ? b : null;
    }, 12000);

    if (!payBtn) {
      if (!n && !D.deepQueryAll("iframe", OWN).length) {
        return report("CARD_FIELDS_NOT_FOUND", { frames: [location.host] });
      }
      return report("CARD_PAY_BUTTON_NOT_FOUND", { fillOk: n > 0 && !fillProblems.length, problems: fillProblems });
    }

    globalThis.CromaModal.stop(0, true); // OTP popup kabhi band na ho
    await report("CARD_SUBMITTING", { last4: digits(card.number).slice(-4) });
    payBtn.scrollIntoView({ block: "center" });
    await D.sleep(200);
    payBtn.click();

    const err = await D.waitFor(() => {
      const t = D.normalize(document.body?.innerText || "");
      const m = t.match(/.{0,30}(invalid card|card number is invalid|enter (a )?valid|card (has )?expired|declined|payment failed|transaction failed).{0,40}/);
      return m ? m[0] : null;
    }, 15000);
    if (err) report("CARD_ERROR", { message: err });
    return;
  }

  // ---------- EMI on Cards: bank → tenure → card details → Pay ----------
  if (pick === "emi" && emiBank) {
    const esc = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const bankRx = new RegExp("^" + esc(emiBank) + "( bank)?( ltd\\.?| limited)?$");

    const smallest = (rx, maxLen = 40) => {
      let best = null;
      for (const el of D.deepQueryAll("li, div, span, p, label, button, a, [role='button'], [role='radio']", OWN)) {
        if (!D.isVisible(el)) continue;
        const t = D.textOf(el);
        if (t.length > maxLen || !rx.test(t)) continue;
        if (!best || best.contains(el)) best = el;
      }
      return best;
    };

    // Row poora clickable hota hai (">" wala) → upar ka pointer wala element dabao
    const rowOf = (el) => {
      for (let p = el, i = 0; p && i < 5; p = p.parentElement, i++) {
        if (p.matches?.("li, label, button, a, [role='button'], [role='radio']")) return p;
        const cs = (p.ownerDocument.defaultView || window).getComputedStyle(p);
        if (cs.cursor === "pointer") return p;
      }
      return el;
    };

    const clickRow = async (el) => {
      const row = rowOf(el);
      row.scrollIntoView({ block: "center" });
      await D.sleep(300);
      row.click();
      const radio = row.querySelector?.("input[type='radio']");
      if (radio && !radio.checked) radio.click();
    };

    // 0) PayU: EMI ke andar "Credit Card EMI" category ho to pehle use kholo
    const cat = await D.waitFor(() => smallest(/^credit cards?( emi)?$/), 3000);
    if (cat && !smallest(bankRx)) {
      await clickRow(cat);
      await D.sleep(1200);
    }

    // 1) Bank
    const bankEl = await D.waitFor(() => smallest(bankRx), 8000);
    if (!bankEl) return report("EMI_STEP_NOT_FOUND", { step: `bank "${res.emiBank}"` });
    await clickRow(bankEl);
    await D.sleep(1500);

    // 2) Tenure — Croma pe plan aise likha hota hai: "₹16334.11 x 6 M | @16.00% p.a"
    //    ("x 16 M" galti se match na ho, isliye "x" ke turant baad number)
    if (emiTenure) {
      const tenRx = new RegExp("(x\\s*" + emiTenure + "\\s*(m|mo|months?)\\b)|(^" + emiTenure + "\\s*(months?|mo)\\b)");
      const tenEl = await D.waitFor(() => smallest(tenRx, 90), 8000);
      if (!tenEl) return report("EMI_STEP_NOT_FOUND", { step: `${emiTenure} M plan` });
      await clickRow(tenEl);
      await D.sleep(800);

      // 3) "Select this plan" button
      const selBtn = await D.waitFor(() => {
        const b = D.findByTextDeep(/^select (this )?plan$/, OWN);
        return b && !D.isDisabled(b) ? b : null;
      }, 3000);
      if (selBtn) {
        selBtn.scrollIntoView({ block: "center" });
        await D.sleep(300);
        selBtn.click();
      }

      // Card form khulne ka wait
      await D.waitFor(() => cardFields().num || D.deepQueryAll("iframe", OWN).length > 0, 8000);
      await D.sleep(800);
    } else {
      return report("EMI_STEP_NOT_FOUND", { step: "tenure (popup me mahine chuno)", soft: true });
    }

    // 3) Card details (agar is frame me hon; nested frame ho to wo khud bharega)
    const n = await fillOwnFields(5000);

    // 4) Pay
    const payBtn = await D.waitFor(() => {
      const b = D.findByTextDeep(/^(place order (&|and) pay|pay ?₹ ?[\d,.]+|proceed( to pay)?|pay now|pay|make payment|continue)$/, OWN);
      return b && !D.isDisabled(b) ? b : null;
    }, 15000);
    if (!payBtn) {
      return report("EMI_STEP_NOT_FOUND", {
        step: fillProblems.length ? `card details (${fillProblems.join(", ")})` : "Pay button",
        filled: n
      });
    }

    globalThis.CromaModal.stop(0, true); // OTP popup kabhi band na ho
    await report("EMI_SUBMITTING", { bank: res.emiBank, tenure: emiTenure, last4: card ? digits(card.number).slice(-4) : "" });
    payBtn.scrollIntoView({ block: "center" });
    await D.sleep(200);
    payBtn.click();
    return;
  }

  // ---------- Netbanking: bank select + Pay ----------
  if (pick === "netbanking" && nbBank) {
    const bankRx = new RegExp("^" + nbBank.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "( bank)?( ltd\\.?| limited)?$");

    // Bank ka naam jis sabse chhote element me exact likha ho (popular tile ya list row)
    const findBank = () => {
      let best = null;
      for (const el of D.deepQueryAll("li, div, span, p, label, button, a, [role='button'], [role='radio']", OWN)) {
        if (!D.isVisible(el)) continue;
        const t = D.textOf(el);
        if (t.length > 40 || !bankRx.test(t)) continue;
        if (!best || best.contains(el)) best = el;
      }
      return best;
    };

    let bankEl = await D.waitFor(findBank, 6000);

    // List me nahi dikha to Search box me naam type karo
    if (!bankEl) {
      const search = D.deepQueryAll("input", OWN).find(
        (el) => D.isVisible(el) && /search/i.test([el.placeholder, el.name, el.id, el.getAttribute("aria-label")].join(" "))
      );
      if (search) {
        await typeInto(search, res.netbankingBank);
        bankEl = await D.waitFor(findBank, 4000);
      }
    }

    if (!bankEl) return report("NETBANKING_BANK_NOT_FOUND", { bank: res.netbankingBank });

    const target =
      bankEl.closest("li, label, button, a, [role='button'], [role='radio']") ||
      bankEl.parentElement?.querySelector("input[type='radio']") ||
      bankEl;
    target.scrollIntoView({ block: "center" });
    await D.sleep(300);
    target.click();
    // Row me radio ho to use bhi tick karo
    const radio = (bankEl.closest("li, label, div") || bankEl).querySelector?.("input[type='radio']");
    if (radio && !radio.checked) radio.click();
    await D.sleep(1000);

    const payBtn = await D.waitFor(() => {
      const b = D.findByTextDeep(/^(place order (&|and) pay|pay ?₹ ?[\d,.]+|proceed( to pay)?|pay now|pay|make payment|continue)$/, OWN);
      return b && !D.isDisabled(b) ? b : null;
    }, 12000);
    if (!payBtn) return report("NETBANKING_PAY_NOT_FOUND", { bank: res.netbankingBank });

    globalThis.CromaModal.stop(0, true); // bank page / OTP popup kabhi band na ho
    await report("NETBANKING_SUBMITTING", { bank: res.netbankingBank });
    payBtn.scrollIntoView({ block: "center" });
    await D.sleep(200);
    payBtn.click();
    return;
  }

  report("PAYMENT_REACHED", {
    available: available.map(label),
    preferred: prefs.filter((k) => METHODS[k]).map(label),
    selected: pick ? label(pick) : null
  });
})();
