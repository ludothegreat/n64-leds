// Must match src/main.cpp.
const SERVICE_UUID = "1f350ed4-bf6b-48a5-9845-45f5d4d6cdbc";
const STATE_UUID = "ae7d2ebf-fbee-4d2e-99fd-5bcf2b93bdfb";
const PROTOCOL_VERSION = 1;
const MAX_BRIGHTNESS = 255;

// LED colors, not UI colors: these are what the lights will show.
const SWATCHES = ["#ff0000", "#00ff00", "#0000ff", "#a000ff", "#ff5000", "#ffffff",
                  "#ff0080", "#00ffff", "#ff2000", "#40ff00", "#ff00ff", "#ffb060"];

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const controls = $("controls");

let device = null;
let stateChar = null;
let state = { on: true, r: 255, g: 0, b: 0, brightness: 40, effect: 0, speed: 128 };

// Only one GATT write may be in flight. Slider drags produce far more events
// than BLE can take, so keep just the newest state and send it when free.
let writing = false;
let dirty = false;

function log(...args) { console.log("[n64-leds]", ...args); }

function setStatus(text, kind = "") {
  statusEl.textContent = text;
  statusEl.className = "status " + kind;
}

function encode(s) {
  return new Uint8Array([PROTOCOL_VERSION, s.on ? 1 : 0, s.r, s.g, s.b,
                         Math.min(s.brightness, MAX_BRIGHTNESS), s.effect, Math.max(1, s.speed)]);
}

function decode(view) {
  if (view.byteLength !== 8 || view.getUint8(0) !== PROTOCOL_VERSION) {
    throw new Error(`unexpected state packet (${view.byteLength} bytes, version ${view.getUint8(0)})`);
  }
  return { on: view.getUint8(1) === 1, r: view.getUint8(2), g: view.getUint8(3), b: view.getUint8(4),
           brightness: view.getUint8(5), effect: view.getUint8(6), speed: view.getUint8(7) };
}

const hex = (n) => n.toString(16).padStart(2, "0");
const toHex = (s) => `#${hex(s.r)}${hex(s.g)}${hex(s.b)}`;
function fromHex(h) {
  return { r: parseInt(h.slice(1, 3), 16), g: parseInt(h.slice(3, 5), 16), b: parseInt(h.slice(5, 7), 16) };
}

function render() {
  $("power").setAttribute("aria-pressed", String(state.on));
  $("power").textContent = state.on ? "On" : "Off";
  $("color").value = toHex(state);
  for (const sw of document.querySelectorAll(".swatch")) {
    sw.setAttribute("aria-pressed", String(sw.dataset.color === toHex(state)));
  }
  $("brightness").value = state.brightness;
  $("brightness-val").textContent = `${Math.round(state.brightness / MAX_BRIGHTNESS * 100)}%`;
  for (const b of document.querySelectorAll("#effects button")) {
    b.setAttribute("aria-pressed", String(Number(b.dataset.effect) === state.effect));
  }
  $("speed").value = state.speed;
  $("speed-val").textContent = state.speed;
}

async function flush() {
  if (writing || !stateChar) return;
  writing = true;
  try {
    while (dirty) {
      dirty = false;
      const packet = encode(state);
      log("write", Array.from(packet));
      await stateChar.writeValueWithResponse(packet);
    }
  } catch (err) {
    log("write failed", err);
    setStatus(`Write failed: ${err.message}`, "err");
  } finally {
    writing = false;
  }
}

function update(patch) {
  state = { ...state, ...patch };
  render();
  dirty = true;
  flush();
}

function onNotify(event) {
  // While a drag is still being sent, the echo is of an older value; applying
  // it would yank the slider backwards under the user's finger.
  if (writing || dirty) return;
  try {
    state = decode(event.target.value);
    log("notify", state);
    render();
  } catch (err) {
    log("bad notify", err);
    setStatus(err.message, "err");
  }
}

function onDisconnected() {
  log("disconnected");
  stateChar = null;
  controls.setAttribute("aria-disabled", "true");
  $("connect").disabled = false;
  $("connect").textContent = "Reconnect";
  setStatus("Disconnected", "err");
}

async function connect() {
  $("connect").disabled = true;
  try {
    if (!device) {
      setStatus("Pick N64-LEDs from the list…");
      device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE_UUID] }] });
      device.addEventListener("gattserverdisconnected", onDisconnected);
    }
    setStatus(`Connecting to ${device.name || "device"}…`);
    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(SERVICE_UUID);
    stateChar = await service.getCharacteristic(STATE_UUID);
    // The first protected read is what makes Android show its pairing prompt.
    setStatus("If Android asks for a PIN, enter the N64-LEDs PIN…");
    state = decode(await stateChar.readValue());
    stateChar.addEventListener("characteristicvaluechanged", onNotify);
    await stateChar.startNotifications();
    log("connected, state", state);
    render();
    controls.setAttribute("aria-disabled", "false");
    $("connect").textContent = "Connected";
    setStatus(`Connected to ${device.name || "device"}`, "ok");
  } catch (err) {
    log("connect failed", err);
    // Cancelling the picker is not an error worth shouting about.
    if (err.name === "NotFoundError") setStatus("No device picked");
    // A wrong or cancelled PIN surfaces as a security/network error on the read.
    else if (err.name === "SecurityError" || err.name === "NetworkError")
      setStatus(`Pairing failed (wrong PIN or cancelled): ${err.message}`, "err");
    else setStatus(`Connect failed: ${err.message}`, "err");
    if (device && device.gatt.connected) device.gatt.disconnect();
    $("connect").disabled = false;
  }
}

function init() {
  const swatches = $("swatches");
  for (const c of SWATCHES) {
    const b = document.createElement("button");
    b.className = "swatch";
    b.dataset.color = c;
    b.style.background = c;
    b.setAttribute("aria-label", c);
    b.addEventListener("click", () => update({ ...fromHex(c), effect: state.effect === 1 ? 0 : state.effect }));
    swatches.appendChild(b);
  }
  $("power").addEventListener("click", () => update({ on: !state.on }));
  $("color").addEventListener("input", (e) => update(fromHex(e.target.value)));
  $("brightness").addEventListener("input", (e) => update({ brightness: Number(e.target.value) }));
  $("speed").addEventListener("input", (e) => update({ speed: Number(e.target.value) }));
  for (const b of document.querySelectorAll("#effects button")) {
    b.addEventListener("click", () => update({ effect: Number(b.dataset.effect) }));
  }
  $("connect").addEventListener("click", connect);

  if (!("bluetooth" in navigator)) {
    $("connect").disabled = true;
    $("unsupported").hidden = false;
    setStatus("Bluetooth not available in this browser", "err");
  }
  render();

  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("sw.js").catch((err) => log("service worker failed", err));
  }
}

init();
