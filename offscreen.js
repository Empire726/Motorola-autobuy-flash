// Alarm: zor ki beep-beep (WebAudio), background se PLAY_ALARM / STOP_ALARM aata hai
let ctx = null;
let stopAt = 0;
let loop = null;

function beep(freq, ms) {
  const osc = ctx.createOscillator();
  const gain = ctx.createGain();
  osc.type = "square";
  osc.frequency.value = freq;
  gain.gain.value = 0.35;
  osc.connect(gain).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + ms / 1000);
}

function play(seconds) {
  stop();
  ctx = ctx || new AudioContext();
  stopAt = Date.now() + Math.max(1, seconds) * 1000;
  let hi = true;
  const tick = () => {
    if (Date.now() >= stopAt) return stop();
    beep(hi ? 1000 : 750, 220);
    hi = !hi;
  };
  tick();
  loop = setInterval(tick, 260);
}

function stop() {
  clearInterval(loop);
  loop = null;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.target !== "offscreen") return;
  if (msg.type === "PLAY_ALARM") play(Number(msg.seconds) || 10);
  if (msg.type === "STOP_ALARM") stop();
});
