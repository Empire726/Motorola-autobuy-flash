const KEY = "motoTask";
const CART_URL = "https://www.motorola.in/checkout/#/cart";
const MIN_INTERVAL = 3;
const BLOCK_BACKOFF_MS = 60000;
const STALE_MS = 90000;

const DEFAULTS = {
  enabled: false,
  interval: 10,
  productUrls: [],
  botToken: "",
  chatId: "",
  queueIndex: 0,
  phase: null,            // PRODUCT | CART | CHECKOUT
  activeTabId: null,
  pendingAction: null,    // "product" | "cart"
  nextActionAt: null,
  lastActivity: 0,
  productAttempts: 0,
  cartAttempts: 0,
  productTitle: "",
  paymentMethods: [],        // ["cod","upi","card","emi","netbanking"] priority order
  retryOnMissingMethod: false,
  netbankingBank: "",
  emiBank: "",
  emiTenure: 0,
  quantity: 1,
  profile: {},
  cartUrl: "",
  paymentAttempts: 0,
  alarmSeconds: 15,
  scheduledAt: null,
  lastTabId: null,
  lastStatus: "Ready",
  lastChecked: 0
};

let timer = null;

// Saare state changes ek-ek karke chalein (race conditions se bachne ke liye)
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

async function getTask() {
  const d = await chrome.storage.local.get(KEY);
  return { ...DEFAULTS, ...(d[KEY] || {}) };
}

async function patch(p) {
  const next = { ...(await getTask()), ...p };
  await chrome.storage.local.set({ [KEY]: next });
  return next;
}

const status = (msg, extra = {}) => patch({ lastStatus: msg, lastChecked: Date.now(), ...extra });

function intervalMs(t) {
  const s = Math.max(MIN_INTERVAL, Number(t.interval) || DEFAULTS.interval);
  return s * 1000 + Math.floor(Math.random() * 1500); // thoda jitter
}

async function notify(t, text) {
  if (!t.botToken || !t.chatId) return;
  try {
    const res = await fetch(`https://api.telegram.org/bot${t.botToken}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: t.chatId, text })
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) console.warn("Telegram failed:", data.description || res.status);
  } catch (e) {
    console.warn("Telegram error:", e); // Telegram fail ho to flow nahi rukna chahiye
  }
}

// ---------- Alarm (offscreen document me sound) ----------
let offscreenReady = null;
async function ensureOffscreen() {
  const has = chrome.offscreen.hasDocument ? await chrome.offscreen.hasDocument().catch(() => false) : false;
  if (has) return;
  offscreenReady = offscreenReady || chrome.offscreen.createDocument({
    url: "offscreen.html",
    reasons: ["AUDIO_PLAYBACK"],
    justification: "Stock / payment alert alarm"
  }).catch(() => {}).finally(() => { offscreenReady = null; });
  await offscreenReady;
}

async function playAlarm(seconds) {
  try {
    await ensureOffscreen();
    const t = await getTask();
    await chrome.runtime.sendMessage({ target: "offscreen", type: "PLAY_ALARM", seconds: seconds || t.alarmSeconds });
  } catch (e) {
    console.warn("Alarm failed:", e);
  }
}

async function stopAlarm() {
  try { await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP_ALARM" }); } catch { }
}

// ---------- Card details ----------
// Default: chrome.storage.session (sirf memory me, Chrome band = card delete).
// "persist" on ho tabhi disk (storage.local) pe.
const CARD_KEY = "motoCard";

async function getCard() {
  const s = (await chrome.storage.session.get(CARD_KEY))[CARD_KEY];
  if (s) return s;
  return (await chrome.storage.local.get(CARD_KEY))[CARD_KEY] || null;
}

async function saveCard(card, persist) {
  await chrome.storage.session.set({ [CARD_KEY]: card });
  if (persist) await chrome.storage.local.set({ [CARD_KEY]: card });
  else await chrome.storage.local.remove(CARD_KEY);
}

async function clearCard() {
  await chrome.storage.session.remove(CARD_KEY);
  await chrome.storage.local.remove(CARD_KEY);
}

function validateCard(c = {}) {
  const number = String(c.number || "").replace(/\D/g, "");
  const cvv = String(c.cvv || "").replace(/\D/g, "");
  const m = String(c.expiry || "").trim().match(/^(\d{1,2})\s*\/\s*(\d{2}|\d{4})$/);
  if (number.length < 12 || number.length > 19) return { error: "Card number galat hai" };
  if (!m || +m[1] < 1 || +m[1] > 12) return { error: "Expiry MM/YY format me daalo (jaise 08/29)" };
  if (cvv.length < 3 || cvv.length > 4) return { error: "CVV 3-4 digit ka hona chahiye" };
  const expiry = `${m[1].padStart(2, "0")}/${m[2].slice(-2)}`;
  return { card: { number, expiry, cvv, name: String(c.name || "").trim() } };
}

// Ek hi tab reuse karo, naye tabs mat kholo
// Same page dobara chahiye to HARD refresh (Ctrl+Shift+R jaisa) — purana cache nahi dikhega.
// Dusre page pe jaana ho to URL me ek naya "_cb" param, taaki browser cached copy na de.
function samePage(a, b) {
  try {
    const x = new URL(a), y = new URL(b);
    x.searchParams.delete("_cb"); y.searchParams.delete("_cb");
    return x.origin === y.origin && x.pathname.replace(/\/$/, "") === y.pathname.replace(/\/$/, "") &&
      x.search === y.search && x.hash === y.hash;
  } catch { return false; }
}

function cacheBust(url) {
  try {
    const u = new URL(url);
    u.searchParams.set("_cb", Date.now().toString(36));
    return u.toString();
  } catch { return url; }
}

async function openUrl(url) {
  const t = await getTask();
  if (t.activeTabId != null) {
    try {
      const tab = await chrome.tabs.get(t.activeTabId);
      if (samePage(tab.url || tab.pendingUrl || "", url)) {
        await chrome.tabs.reload(t.activeTabId, { bypassCache: true });
      } else {
        await chrome.tabs.update(t.activeTabId, { url: cacheBust(url) });
      }
      return;
    } catch { /* tab band ho chuka */ }
  }
  const tab = await chrome.tabs.create({ url: cacheBust(url), active: true });
  await patch({ activeTabId: tab.id });
}

async function goProduct() {
  const t = await getTask();
  const urls = t.productUrls;
  if (!urls.length) return finish("No product URLs configured");
  const i = t.queueIndex % urls.length;
  await status(`[${i + 1}/${urls.length}] Product page check... (try #${t.productAttempts + 1})`, {
    phase: "PRODUCT",
    lastActivity: Date.now()
  });
  await openUrl(urls[i]);
}

async function goCart() {
  const t = await getTask();
  await status(`🛒 Cart check... (try #${t.cartAttempts + 1})`, { phase: "CART", lastActivity: Date.now() });
  await openUrl(t.cartUrl || CART_URL);
}

async function schedule(action, ms, msg, extra = {}) {
  clearTimeout(timer);
  await status(msg, { pendingAction: action, nextActionAt: Date.now() + ms, ...extra });
  timer = setTimeout(() => serial(runPending), ms);
}

async function runPending() {
  clearTimeout(timer);
  timer = null;
  const t = await getTask();
  if (!t.enabled || !t.pendingAction) return;
  const action = t.pendingAction;
  await patch({ pendingAction: null, nextActionAt: null });
  return action === "cart" ? goCart() : goProduct();
}

async function finish(reason, { focus = false } = {}) {
  clearTimeout(timer);
  timer = null;
  const t = await getTask();
  await status(reason, { enabled: false, phase: null, pendingAction: null, nextActionAt: null, activeTabId: null, lastTabId: t.activeTabId });
  await chrome.alarms.clear("watchdog");
  if (focus) playAlarm();
  if (t.activeTabId != null) {
    // Payment page pe 5s aur popups band karo, phir user ke liye chhod do
    chrome.tabs.sendMessage(t.activeTabId, { type: "STOP_MODAL_KILLER", afterMs: /PAYMENT PAGE/.test(reason) ? 5000 : 0 }).catch(() => {});
  }
  if (focus && t.activeTabId != null) {
    try {
      const tab = await chrome.tabs.update(t.activeTabId, { active: true });
      await chrome.windows.update(tab.windowId, { focused: true });
    } catch { }
  }
}

async function handleResult(p, tabId) {
  const t = await getTask();

  // Pay click ke baad PayU pe hi card error aaya (task tab tak finish ho chuka hota hai)
  if (p.type === "CARD_ERROR" && tabId != null && tabId === t.lastTabId) {
    await notify(t, `❌ CARD ERROR — PayU ne card reject kiya\n\n${p.message || ""}\nJaldi manually check karo!\n${p.url}`);
    await status(`❌ Card error: ${p.message || ""}`);
    return playAlarm();
  }

  if (!t.enabled || t.activeTabId !== tabId) return;
  await patch(p.cartPage && p.url ? { lastActivity: Date.now(), cartUrl: p.url } : { lastActivity: Date.now() });

  const title = p.title || t.productTitle || "Motorola product";
  const n = Math.max(1, t.productUrls.length);
  const ms = intervalMs(t);
  const secs = Math.round(ms / 1000);
  const phaseAction = t.phase === "PRODUCT" ? "product" : "cart";

  switch (p.type) {
    // ----- Product page -----
    case "PRODUCT_UNAVAILABLE":
      // Agle product pe jao (1 URL ho to wahi reload hoga)
      return schedule("product", ms, `⏳ ${p.reason || "Unavailable"}: ${title}\nReload in ${secs}s`, {
        queueIndex: (t.queueIndex + 1) % n,
        productAttempts: t.productAttempts + 1,
        productTitle: title
      });

    case "PRODUCT_TIMEOUT":
      return schedule("product", ms, `⚠️ Add to Cart button/status nahi mila: ${title}\nRetry in ${secs}s`, {
        productAttempts: t.productAttempts + 1
      });

    case "PRODUCT_ADDED":
      await patch({ productTitle: title, cartAttempts: 0 });
      await notify(t, `🟢 IN STOCK — cart me add ho gaya\n\n${title}\n${p.url}`);
      if (p.selfNav) {
        // Page khud "Go to checkout" daba ke bag pe ja raha hai
        return status(`🛒 Add ho gaya, Shopping Bag khul raha hai... ${title}`, { phase: "CART", lastActivity: Date.now() });
      }
      return goCart();

    case "QTY_NOTE":
      await notify(t, `ℹ️ Quantity ${p.want} nahi ho payi, ${p.got ?? "?"} pe hi checkout kar rahe hain\n\n${title}`);
      return status(`ℹ️ Quantity ${p.want} chahiye thi, ${p.got ?? "?"} hi hui (limit?) — aage badh rahe`);

    // ----- Cart page -----
    case "CART_EMPTY":
      return schedule("product", 2000, "🛒 Cart empty mila, product dobara add karenge...");

    case "CART_OOS": {
      // Add karne ke turant baad cart purana "out of stock" dikha sakta hai →
      // pehli 2 baar jaldi (2s) hard refresh, uske baad normal interval
      const quick = t.cartAttempts < 2;
      const wait = quick ? 2000 : ms;
      return schedule("cart", wait, `🔴 Cart: OUT OF STOCK — ${title}\nHard refresh in ${Math.round(wait / 1000)}s (try #${t.cartAttempts + 1})`, {
        cartAttempts: t.cartAttempts + 1
      });
    }

    case "CART_TIMEOUT":
      return schedule("cart", ms, `⚠️ Cart page load/Checkout button nahi mila. Retry in ${secs}s`, {
        cartAttempts: t.cartAttempts + 1
      });

    case "CHECKOUT_CLICKING":
      return status(`➡️ Cart me stock hai! Checkout click kar rahe... ${title}`, { phase: "CHECKOUT" });

    case "CHECKOUT_STUCK":
      return schedule("cart", ms, `⚠️ Checkout click ke baad page aage nahi badha. Cart retry in ${secs}s`);

    // ----- Shipping page -----
    case "SHIPPING_CLICKING":
      return status(`📦 Address bhara hua hai, Proceed To Payment click kar rahe... ${title}`);

    case "ADDRESS_INCOMPLETE": {
      const fields = (p.fields || []).join(", ");
      await notify(t, `🟡 STOCK AVAILABLE — address adhoora hai!\n\n${title}\nKhaali: ${fields}\nJaldi bharo aur Proceed To Payment dabao.\n${p.url}`);
      return finish(`🟡 Address adhoora: ${fields}\nKhud bharo aur Proceed To Payment dabao`, { focus: true });
    }

    case "ADDRESS_ERROR":
      await notify(t, `🟡 STOCK AVAILABLE — shipping form me error\n\n${title}\n${p.message || ""}\nJaldi theek karo.\n${p.url}`);
      return finish(`🟡 Shipping form error: ${p.message || ""}\nKhud theek karo`, { focus: true });

    case "SHIPPING_STUCK":
      await notify(t, `🟡 STOCK AVAILABLE — Proceed To Payment ke baad page aage nahi badha\n\n${title}\nManually check karo.\n${p.url}`);
      return finish("🟡 Proceed To Payment pe atka — manually check karo", { focus: true });

    // ----- Final states -----
    case "PAYMENT_REACHED": {
      const frames = (p.frames || []).join(", ");
      const avail = (p.available || []).join(", ") || `detect nahi hua${frames ? ` (iframe: ${frames})` : " (koi iframe nahi mila)"}`;
      const wanted = (p.preferred || []).join(", ");

      // Koi preferred method set nahi, ya mil gaya → success
      if (!wanted || p.selected) {
        const line = p.selected ? `💳 ${p.selected} AVAILABLE (select kar diya)` : `Methods: ${avail}`;
        await notify(t, `✅ AVAILABLE! PAYMENT PAGE REACHED\n\n${title}\n${line}\nAvailable: ${avail}\nJaldi payment complete karo!\n${p.url}`);
        return finish(`✅ PAYMENT PAGE REACHED\n${line}\n${title}`, { focus: true });
      }

      // Preferred method (jaise COD) nahi mila
      if (t.retryOnMissingMethod) {
        if (t.paymentAttempts === 0) {
          await notify(t, `🟠 Stock hai lekin ${wanted} abhi nahi hai\n\n${title}\nAvailable: ${avail}\nRetry kar rahe hain, ${wanted} aate hi bataenge.`);
        }
        return schedule("cart", ms, `🟠 ${wanted} nahi mila (available: ${avail})\nCart se retry in ${secs}s (try #${t.paymentAttempts + 1})`, {
          paymentAttempts: t.paymentAttempts + 1
        });
      }
      await notify(t, `🟠 STOCK AVAILABLE — lekin ${wanted} NAHI hai\n\n${title}\nAvailable: ${avail}\nChaho to inme se pay kar lo.\n${p.url}`);
      return finish(`🟠 Payment page pe ${wanted} nahi hai\nAvailable: ${avail}`, { focus: true });
    }

    // ----- Card auto-pay -----
    case "CARD_SUBMITTING":
      chrome.tabs.sendMessage(tabId, { type: "STOP_MODAL_KILLER", afterMs: 0, force: true }).catch(() => {});
      await notify(t, `🚨 CARD SE PAY DABA DIYA (****${p.last4 || ""})\n\n${title}\nJALDI laptop kholo aur OTP daalo! (~2-3 min)\n${p.url}`);
      return finish(`🚨 Place Order & Pay daba diya — JALDI OTP daalo!\n${title}`, { focus: true });

    case "CARD_FIELDS_NOT_FOUND": {
      const fr = (p.frames || []).join(", ");
      await notify(t, `🟡 STOCK AVAILABLE — payment page pe hain, card fields nahi mile\n\n${title}\nManually card bharo aur pay karo.\n${p.url}`);
      return finish(`🟡 Card fields nahi mile — manually bharo${fr ? `\n(iframes: ${fr})` : ""}`, { focus: true });
    }

    // ----- EMI auto-pay -----
    case "EMI_SUBMITTING":
      chrome.tabs.sendMessage(tabId, { type: "STOP_MODAL_KILLER", afterMs: 0, force: true }).catch(() => {});
      await notify(t, `🚨 EMI SE PAY DABA DIYA (${p.bank}, ${p.tenure} months${p.last4 ? `, ****${p.last4}` : ""})\n\n${title}\nJALDI laptop kholo aur OTP daalo!\n${p.url}`);
      return finish(`🚨 EMI (${p.bank}, ${p.tenure}m) — Pay daba diya, JALDI OTP daalo!\n${title}`, { focus: true });

    case "EMI_STEP_NOT_FOUND":
      await notify(t, `🟡 STOCK AVAILABLE — EMI me "${p.step}" nahi mila / atka\n\n${title}\nManually EMI complete karo.\n${p.url}`);
      return finish(`🟡 EMI: "${p.step}" pe atka — manually complete karo`, { focus: true });

    // ----- Netbanking auto-pay -----
    case "NETBANKING_SUBMITTING":
      chrome.tabs.sendMessage(tabId, { type: "STOP_MODAL_KILLER", afterMs: 0, force: true }).catch(() => {});
      await notify(t, `🚨 NETBANKING SE PAY DABA DIYA (${p.bank || ""})\n\n${title}\nJALDI laptop kholo aur bank me login / OTP karo!\n${p.url}`);
      return finish(`🚨 Netbanking (${p.bank || ""}) — Pay daba diya, JALDI bank login karo!\n${title}`, { focus: true });

    case "NETBANKING_BANK_NOT_FOUND":
      await notify(t, `🟡 STOCK AVAILABLE — Netbanking me "${p.bank}" bank nahi mila\n\n${title}\nManually bank chuno aur pay karo.\n${p.url}`);
      return finish(`🟡 Netbanking me "${p.bank}" nahi mila — manually chuno (naam check karo)`, { focus: true });

    case "NETBANKING_PAY_NOT_FOUND":
      await notify(t, `🟡 STOCK AVAILABLE — ${p.bank} select kiya par Pay button enable nahi hua\n\n${title}\nManually pay karo.\n${p.url}`);
      return finish(`🟡 ${p.bank} select kiya, Pay button nahi mila — manually pay karo`, { focus: true });

    case "CARD_PAY_BUTTON_NOT_FOUND":
      await notify(t, `🟡 STOCK AVAILABLE — card bhar diya par "Place Order & Pay" enable nahi hua\n\n${title}\nCard details check karke khud pay karo.\n${p.url}`);
      return finish(`🟡 Card bhara${p.problems?.length ? ` (sahi nahi bhara: ${p.problems.join(", ")})` : ""}, Pay button enable nahi hua — manually check karo`, { focus: true });

    case "LOGIN_REQUIRED":
      await notify(t, `🔐 LOGIN REQUIRED\n\n${title}\nmotorola.in pe login karo, phir Start dobara dabao.`);
      return finish("🔐 LOGIN REQUIRED — login karke Start dobara dabao", { focus: true });

    // ----- Errors -----
    case "BLOCKED":
      return schedule(phaseAction, BLOCK_BACKOFF_MS, "🚫 Motorola ne block kiya (Access Denied). 60s baad retry. Interval badhao.");

    case "ERROR":
      return schedule(phaseAction, ms, `ERROR: ${p.message || "Unknown"}\nRetry in ${secs}s`);
  }
}

// Service worker so jaaye ya page atak jaaye to recover karo
async function watchdog() {
  const t = await getTask();
  if (!t.enabled) return chrome.alarms.clear("watchdog");
  const now = Date.now();
  if (t.pendingAction) {
    if (now > (t.nextActionAt || 0) + 5000) return runPending(); // timer kho gaya tha
    return;
  }
  if (now - (t.lastActivity || 0) > STALE_MS) {
    await status("🐕 Watchdog: page atka hua tha, recover kar rahe...");
    return t.phase === "PRODUCT" ? goProduct() : goCart();
  }
}

const PAYMENT_KEYS = ["cod", "upi", "card", "emi", "netbanking"];

const PROFILE_KEYS = ["email", "firstName", "lastName", "phone", "pincode", "address1", "address2", "state", "city"];
function sanitizeProfile(pr = {}) {
  const out = {};
  for (const k of PROFILE_KEYS) out[k] = String(pr?.[k] || "").trim().slice(0, 120);
  return out;
}

function sanitizeSettings(s = {}) {
  const productUrls = (Array.isArray(s.productUrls) ? s.productUrls : [])
    .map((u) => String(u).trim())
    .filter((u) => /^https:\/\/(www\.)?motorola\.in\//i.test(u));
  return {
    productUrls,
    interval: Math.max(MIN_INTERVAL, Number(s.interval) || DEFAULTS.interval),
    botToken: String(s.botToken || "").trim(),
    chatId: String(s.chatId || "").trim(),
    paymentMethods: (Array.isArray(s.paymentMethods) ? s.paymentMethods : []).filter((m) => PAYMENT_KEYS.includes(m)),
    retryOnMissingMethod: !!s.retryOnMissingMethod,
    netbankingBank: String(s.netbankingBank || "").trim().slice(0, 60),
    emiBank: String(s.emiBank || "").trim().slice(0, 60),
    emiTenure: [3, 6, 9, 12, 18, 24].includes(Number(s.emiTenure)) ? Number(s.emiTenure) : 0,
    quantity: Math.max(1, Math.min(10, Number(s.quantity) || 1)),
    profile: sanitizeProfile(s.profile),
    alarmSeconds: Math.min(300, Math.max(1, Number(s.alarmSeconds) || DEFAULTS.alarmSeconds))
  };
}

async function startRun(s) {
  clearTimeout(timer);
  await patch({
    ...s,
    enabled: true,
    scheduledAt: null,
    queueIndex: 0,
    productAttempts: 0,
    cartAttempts: 0,
    paymentAttempts: 0,
    phase: "PRODUCT",
    pendingAction: null,
    nextActionAt: null,
    activeTabId: null,
    productTitle: "",
    cartUrl: ""
  });
  chrome.alarms.create("watchdog", { periodInMinutes: 0.5 });
  await goProduct();
  return { ok: true };
}

// ---------- Scheduled start ----------
// chrome.alarms second-level accurate nahi hota, isliye:
//  "schedWake"  → 20s pehle worker jagata hai, phir setTimeout se exact second pe start
//  "schedStart" → exact time pe backup (agar upar wala miss ho)
const WAKE_BEFORE_MS = 20000;
let schedTimer = null;

async function scheduleStart(s, at) {
  await cancelSchedule();
  await patch({ ...s, scheduledAt: at });
  if (at - Date.now() > WAKE_BEFORE_MS + 1000) chrome.alarms.create("schedWake", { when: at - WAKE_BEFORE_MS });
  chrome.alarms.create("schedStart", { when: at });
  armExactTimer(at);
  await status(`⏰ Scheduled: ${new Date(at).toLocaleString("en-IN", { hour12: true })} pe apne aap Start hoga`);
  return { ok: true };
}

function armExactTimer(at) {
  clearTimeout(schedTimer);
  const ms = at - Date.now();
  if (ms <= 30000) schedTimer = setTimeout(() => serial(fireScheduled), Math.max(0, ms));
}

async function fireScheduled() {
  clearTimeout(schedTimer);
  schedTimer = null;
  const t = await getTask();
  if (!t.scheduledAt) return; // cancel ho chuka / pehle hi chal gaya
  await chrome.alarms.clear("schedWake");
  await chrome.alarms.clear("schedStart");
  if (t.enabled) return patch({ scheduledAt: null }); // already chal raha hai
  await notify(t, "⏰ Scheduled time aa gaya — Motorola watcher START ho gaya");
  return startRun(sanitizeSettings(t));
}

async function cancelSchedule() {
  clearTimeout(schedTimer);
  schedTimer = null;
  await chrome.alarms.clear("schedWake");
  await chrome.alarms.clear("schedStart");
  await patch({ scheduledAt: null });
}

async function onMessage(msg, sender) {
  switch (msg?.type) {
    case "HELLO": {
      const t = await getTask();
      const run = t.enabled && sender.tab?.id != null && t.activeTabId === sender.tab.id;
      if (run) await patch({ lastActivity: Date.now() });
      return { run, phase: t.phase, paymentMethods: t.paymentMethods, quantity: t.quantity, profile: run ? t.profile : {} };
    }
    case "FRAME_HELLO": {
      // Juspay payment iframe (payframe.js) — sirf extension ke tab me, checkout phase me
      const t = await getTask();
      const run = t.enabled && t.phase === "CHECKOUT" && sender.tab?.id === t.activeTabId;
      if (!run) return { run: false };
      await patch({ lastActivity: Date.now() });
      const needCard = t.paymentMethods.includes("card") || t.paymentMethods.includes("emi");
      const card = needCard ? await getCard() : null;
      return {
        run: true, paymentMethods: t.paymentMethods, card,
        netbankingBank: t.netbankingBank, emiBank: t.emiBank, emiTenure: t.emiTenure
      };
    }
    case "GET_CARD": {
      // Sirf extension ke apne tab ko, sirf checkout phase me card milta hai
      const t = await getTask();
      const ok = t.enabled && t.phase === "CHECKOUT" && sender.tab?.id === t.activeTabId;
      return ok ? await getCard() : null;
    }
    case "SAVE_CARD": {
      const v = validateCard(msg.card);
      if (v.error) return { ok: false, error: v.error };
      await saveCard(v.card, !!msg.persist);
      return { ok: true, last4: v.card.number.slice(-4), persist: !!msg.persist };
    }
    case "CLEAR_CARD":
      await clearCard();
      return { ok: true };
    case "CARD_INFO": {
      const c = await getCard();
      const persisted = !!(await chrome.storage.local.get(CARD_KEY))[CARD_KEY];
      return c ? { saved: true, last4: c.number.slice(-4), expiry: c.expiry, persist: persisted } : { saved: false };
    }
    case "TEST_ALARM":
      await playAlarm(msg.seconds);
      return { ok: true };
    case "STOP_ALARM":
      await stopAlarm();
      return { ok: true };

    case "PAGE_RESULT":
      await handleResult(msg.payload || {}, sender.tab?.id);
      return { ok: true };

    case "SAVE_SETTINGS":
      await patch(sanitizeSettings(msg.settings));
      return { ok: true };

    case "START": {
      const s = sanitizeSettings(msg.settings);
      if (!s.productUrls.length) return { ok: false, error: "Kam se kam ek valid Motorola URL daalo (https://www.motorola.in/...)" };
      await cancelSchedule();
      return startRun(s);
    }
    case "SCHEDULE_START": {
      const s = sanitizeSettings(msg.settings);
      if (!s.productUrls.length) return { ok: false, error: "Kam se kam ek valid Motorola URL daalo (https://www.motorola.in/...)" };
      const at = Number(msg.at);
      if (!at || at <= Date.now() + 2000) return { ok: false, error: "Time aage ka hona chahiye" };
      return scheduleStart(s, at);
    }
    case "CANCEL_SCHEDULE":
      await cancelSchedule();
      await status("⏰ Scheduled start cancel kar diya");
      return { ok: true };

    case "CHECK_NOW": {
      const t = await getTask();
      if (!t.enabled) return { ok: false, error: "Pehle Start dabao" };
      if (t.pendingAction) await runPending();
      return { ok: true };
    }
    case "STOP":
      await finish("⏹ Stopped by user");
      return { ok: true };
  }
  return { ok: false };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  serial(() => onMessage(msg, sender))
    .then(sendResponse)
    .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
  return true;
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "watchdog") serial(watchdog);
  if (alarm.name === "schedWake") {
    serial(async () => {
      const t = await getTask();
      if (t.scheduledAt) armExactTimer(t.scheduledAt);
    });
  }
  if (alarm.name === "schedStart") serial(fireScheduled);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    const t = await getTask();
    if (t.enabled && t.activeTabId === tabId) {
      await patch({ activeTabId: null });
      await finish("Tab band ho gaya — stopped");
    }
  });
});

chrome.runtime.onInstalled.addListener(({ reason }) => {
  // Sirf pehli install pe defaults; update/reload pe settings safe rahengi
  if (reason !== "install") return;
  serial(() => patch({}));
});
