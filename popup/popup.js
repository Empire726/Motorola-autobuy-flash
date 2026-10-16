const KEY = "motoTask";
const PF = [["pfEmail", "email"], ["pfFirstName", "firstName"], ["pfLastName", "lastName"], ["pfPhone", "phone"], ["pfPincode", "pincode"], ["pfAddress1", "address1"], ["pfAddress2", "address2"], ["pfState", "state"], ["pfCity", "city"]];
const $ = (id) => document.getElementById(id);

function readForm() {
  return {
    productUrls: $("productUrls").value.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
    interval: Number($("interval").value) || 10,
    botToken: $("botToken").value.trim(),
    chatId: $("chatId").value.trim(),
    paymentMethods: [...document.querySelectorAll(".pm")].filter((c) => c.checked).map((c) => c.value),
    retryOnMissingMethod: $("retryOnMissingMethod").checked,
    alarmSeconds: Number($("alarmSeconds").value) || 15,
    netbankingBank: $("netbankingBank").value.trim(),
    emiBank: $("emiBank").value.trim(),
    emiTenure: Number($("emiTenure").value) || 0,
    quantity: Number($("quantity").value) || 1,
    profile: Object.fromEntries(PF.map(([id, k]) => [k, $(id).value.trim()]))
  };
}

function validate(s) {
  const bad = s.productUrls.filter((u) => !/^https:\/\/(www\.)?motorola\.in\//i.test(u));
  if (!s.productUrls.length) return "Kam se kam ek product URL daalo.";
  if (bad.length) return `Ye URL motorola.in ka nahi hai:\n${bad[0]}`;
  return null;
}

function renderStatus(t) {
  const time = t.lastChecked ? new Date(t.lastChecked).toLocaleTimeString() : "";
  const state = t.enabled ? "🟢 RUNNING" : "⚪ STOPPED";
  $("status").textContent = `${state}${time ? "  ·  " + time : ""}\n\n${t.lastStatus || "Ready"}`;
}

const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ ok: false, error: e.message }));

async function load() {
  const t = (await chrome.storage.local.get(KEY))[KEY] || {};
  $("productUrls").value = (t.productUrls || []).join("\n");
  $("interval").value = t.interval || 10;
  $("botToken").value = t.botToken || "";
  $("chatId").value = t.chatId || "";
  const pms = t.paymentMethods || [];
  document.querySelectorAll(".pm").forEach((c) => (c.checked = pms.includes(c.value)));
  $("retryOnMissingMethod").checked = !!t.retryOnMissingMethod;
  $("alarmSeconds").value = t.alarmSeconds || 15;
  $("netbankingBank").value = t.netbankingBank || "";
  $("emiBank").value = t.emiBank || "";
  $("emiTenure").value = t.emiTenure ? String(t.emiTenure) : "";
  $("quantity").value = t.quantity || 1;
  PF.forEach(([id, k]) => ($(id).value = t.profile?.[k] || ""));
  refreshCardInfo();
  renderStatus(t);
  renderSchedule(t);
}

// Status live update
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[KEY]?.newValue) {
    renderStatus(changes[KEY].newValue);
    renderSchedule(changes[KEY].newValue);
  }
});

// Field chhodte hi save (sirf settings, running state ko nahi chhedta)
const saveNow = () => send({ type: "SAVE_SETTINGS", settings: readForm() });
["productUrls", "interval", "botToken", "chatId", "retryOnMissingMethod", "alarmSeconds", "netbankingBank", "emiBank", "emiTenure", "quantity", ...PF.map(([id]) => id)].forEach((id) => {
  $(id).addEventListener("change", saveNow);
});
document.querySelectorAll(".pm").forEach((c) => c.addEventListener("change", saveNow));

$("start").addEventListener("click", async () => {
  const settings = readForm();
  const err = validate(settings);
  if (err) return ($("status").textContent = "❌ " + err);
  const res = await send({ type: "START", settings });
  if (!res?.ok) $("status").textContent = "❌ " + (res?.error || "Start failed");
});

$("checkNow").addEventListener("click", async () => {
  const res = await send({ type: "CHECK_NOW" });
  if (!res?.ok) $("status").textContent = "❌ " + (res?.error || "Failed");
});

$("stop").addEventListener("click", () => send({ type: "STOP" }));

load();

// ---------- Alarm ----------
$("testAlarm").addEventListener("click", () => send({ type: "TEST_ALARM", seconds: Number($("alarmSeconds").value) || 15 }));
$("stopAlarm").addEventListener("click", () => send({ type: "STOP_ALARM" }));

// ---------- Card ----------
async function refreshCardInfo() {
  const info = await send({ type: "CARD_INFO" });
  $("cardInfo").textContent = info?.saved
    ? `✅ Card saved: **** ${info.last4} (exp ${info.expiry}) — ${info.persist ? "disk pe saved" : "Chrome band karne pe delete ho jaayega"}`
    : "Card saved nahi hai";
  $("cardPersist").checked = !!info?.persist;
}

$("saveCard").addEventListener("click", async () => {
  const res = await send({
    type: "SAVE_CARD",
    persist: $("cardPersist").checked,
    card: {
      number: $("cardNumber").value,
      expiry: $("cardExpiry").value,
      cvv: $("cardCvv").value,
      name: $("cardName").value
    }
  });
  if (!res?.ok) return ($("cardInfo").textContent = "❌ " + (res?.error || "Save failed"));
  ["cardNumber", "cardExpiry", "cardCvv", "cardName"].forEach((id) => ($(id).value = ""));
  refreshCardInfo();
});

$("clearCard").addEventListener("click", async () => {
  await send({ type: "CLEAR_CARD" });
  refreshCardInfo();
});

// ---------- Scheduled start ----------
const pad = (n) => String(n).padStart(2, "0");
function toLocalInput(d) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

let countdown = null;
function renderSchedule(t) {
  clearInterval(countdown);
  const at = t?.scheduledAt;
  if (!at) {
    $("schedInfo").textContent = "Koi schedule nahi";
    return;
  }
  if (!$("startAt").value) $("startAt").value = toLocalInput(new Date(at));
  const tick = () => {
    const left = Math.max(0, Math.round((at - Date.now()) / 1000));
    const h = Math.floor(left / 3600), m = Math.floor((left % 3600) / 60), sec = left % 60;
    $("schedInfo").textContent =
      `⏰ ${new Date(at).toLocaleString("en-IN", { hour12: true })} pe Start hoga — ${h ? h + "h " : ""}${m}m ${sec}s baaki`;
  };
  tick();
  countdown = setInterval(tick, 1000);
}

// Default: aaj 5:30 PM (nikal gaya ho to kal)
if (!$("startAt").value) {
  const d = new Date();
  d.setHours(17, 30, 0, 0);
  if (d <= new Date()) d.setDate(d.getDate() + 1);
  $("startAt").value = toLocalInput(d);
}

$("schedule").addEventListener("click", async () => {
  const settings = readForm();
  const err = validate(settings);
  if (err) return ($("status").textContent = "❌ " + err);
  const at = new Date($("startAt").value).getTime();
  if (!at) return ($("schedInfo").textContent = "❌ Date/time chuno");
  const res = await send({ type: "SCHEDULE_START", settings, at });
  if (!res?.ok) $("schedInfo").textContent = "❌ " + (res?.error || "Schedule failed");
});

$("cancelSchedule").addEventListener("click", () => send({ type: "CANCEL_SCHEDULE" }));
