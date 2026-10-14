const engine = new SirenEngine();
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const MODE_NAMES = {
  off: 'ГОТОВ', wail: 'ВОЛНА', yelp: 'ТРЕЛЬ', piu: 'ПИУ‑ПИУ',
  phaser: 'ФАЗЕР', hilo: 'ДВУХТОН', mech: 'МЕХАНИКА',
};
const HORN_NAMES = { kryak: 'КРЯК', series: 'КРЯ‑КРЯ', air: 'ГУДОК' };

const ui = { mode: 'off', horn: false, manual: false, hornStyle: 'kryak' };

const store = {
  get(k, d) { try { const v = localStorage.getItem('sgu.' + k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem('sgu.' + k, v); } catch (e) {} },
};

function buzz(ms) { try { navigator.vibrate && navigator.vibrate(ms); } catch (e) {} }

function render() {
  $$('.key.mode').forEach((b) => b.classList.toggle('active', b.dataset.mode === ui.mode));
  $('[data-hold="horn"]').classList.toggle('pressed', ui.horn);
  $('[data-hold="manual"]').classList.toggle('pressed', ui.manual);
  $$('[data-style]').forEach((b) => b.classList.toggle('active', b.dataset.style === ui.hornStyle));
  const live = ui.mode !== 'off' || ui.horn || ui.manual;
  $('#lightbar').classList.toggle('on', live && ui.lights);
  $('#lightbar').classList.toggle('disabled', !ui.lights);
  $('#btnLights').classList.toggle('active', ui.lights);
  document.body.classList.toggle('live', live);
  let name = MODE_NAMES[ui.mode];
  if (ui.manual) name = 'РУЧНОЙ';
  if (ui.horn) name = HORN_NAMES[ui.hornStyle];
  $('#dMode').textContent = name;
}

// --- Тоны: фиксируемые кнопки, повторное нажатие выключает
$$('.key.mode').forEach((b) => {
  b.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    engine.unlock();
    ui.mode = ui.mode === b.dataset.mode ? 'off' : b.dataset.mode;
    engine.set({ mode: ui.mode });
    buzz(15);
    render();
  });
});

$('#btnOff').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  engine.unlock();
  ui.mode = 'off';
  releaseManual();
  engine.set({ mode: 'off', stop: true });   // глушит и «выбег» ручного/механики
  buzz(30);
  render();
});

// --- Мигалка: визуально включается/выключается, звук не трогает
ui.lights = store.get('lights', '1') === '1';
$('#btnLights').addEventListener('pointerdown', (e) => {
  e.preventDefault();
  ui.lights = !ui.lights;
  store.set('lights', ui.lights ? '1' : '0');
  buzz(10);
  render();
});

// --- Удерживаемые кнопки: звучат пока палец на кнопке
function bindHold(el, key) {
  const down = (e) => {
    e.preventDefault();
    engine.unlock();
    try { el.setPointerCapture(e.pointerId); } catch (err) {}
    if (ui[key]) return;
    ui[key] = true;
    engine.set({ [key]: true });
    buzz(key === 'horn' ? 25 : 10);
    render();
  };
  const up = () => {
    if (!ui[key]) return;
    ui[key] = false;
    engine.set({ [key]: false });
    render();
  };
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', up);
  el.addEventListener('lostpointercapture', up);
  return up;
}
const releaseHorn = bindHold($('[data-hold="horn"]'), 'horn');
const releaseManual = bindHold($('[data-hold="manual"]'), 'manual');

// --- Тип кряка
$$('[data-style]').forEach((b) => {
  b.addEventListener('click', () => {
    ui.hornStyle = b.dataset.style;
    engine.set({ hornStyle: ui.hornStyle });
    store.set('hornStyle', ui.hornStyle);
    render();
  });
});

// --- Профиль блока СГУ: диапазон и скорости тонов по паспорту
function setProfile(p) {
  if (!PROFILES[p]) p = 'rf';
  engine.set({ profile: PROFILES[p] });
  $$('[data-prof]').forEach((b) => b.classList.toggle('active', b.dataset.prof === p));
  store.set('prof', p);
}
$$('[data-prof]').forEach((b) => b.addEventListener('click', () => setProfile(b.dataset.prof)));
setProfile(store.get('prof', 'rf'));

// --- Акустика: близко / улица / далеко
function setAcoustic(a) {
  engine.setAcoustic(a);
  $$('[data-acou]').forEach((b) => b.classList.toggle('active', b.dataset.acou === a));
  store.set('acou', a);
}
$$('[data-acou]').forEach((b) => b.addEventListener('click', () => setAcoustic(b.dataset.acou)));
setAcoustic(store.get('acou', 'near'));

// --- Громкость
const vol = $('#vol');
vol.value = store.get('vol', '100');
engine.setVolume(vol.value / 100);
vol.addEventListener('input', () => {
  engine.setVolume(vol.value / 100);
  store.set('vol', vol.value);
});

// --- Скины
function setSkin(s) {
  if (!['classic', 'membrane', 'retro'].includes(s)) s = 'classic';
  document.body.dataset.skin = s;
  $$('.skin-btn').forEach((b) => b.classList.toggle('active', b.dataset.skin === s));
  store.set('skin', s);
}
$$('.skin-btn').forEach((b) => b.addEventListener('click', () => setSkin(b.dataset.skin)));
setSkin(store.get('skin', 'classic'));

ui.hornStyle = store.get('hornStyle', 'kryak');
engine.set({ hornStyle: ui.hornStyle });

// --- Клавиатура (удобно проверять на компьютере): 1‑6 тоны, пробел кряк, M ручной, 0/Esc стоп
const KEY_MODES = { '1': 'wail', '2': 'yelp', '3': 'piu', '4': 'phaser', '5': 'hilo', '6': 'mech' };
window.addEventListener('keydown', (e) => {
  if (e.repeat) return;
  if (KEY_MODES[e.key]) { $(`[data-mode="${KEY_MODES[e.key]}"]`).dispatchEvent(new PointerEvent('pointerdown')); }
  else if (e.key === '0' || e.key === 'Escape') { $('#btnOff').dispatchEvent(new PointerEvent('pointerdown')); }
  else if (e.code === 'Space' || e.key === 'm' || e.key === 'ь') {
    e.preventDefault();
    const key = e.code === 'Space' ? 'horn' : 'manual';
    engine.unlock(); ui[key] = true; engine.set({ [key]: true }); render();
  }
});
window.addEventListener('keyup', (e) => {
  if (e.code === 'Space') releaseHorn();
  if (e.key === 'm' || e.key === 'ь') releaseManual();
});

// --- Свернули приложение — гасим всё, чтобы сирена не орала в кармане
function allOff() {
  releaseHorn(); releaseManual();
  ui.mode = 'off'; engine.set({ mode: 'off' });
  render();
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) { allOff(); engine.suspend(); }
});
window.addEventListener('blur', () => { releaseHorn(); releaseManual(); });
document.addEventListener('contextmenu', (e) => e.preventDefault());

// --- Дисплей
const dFreq = $('#dFreq'), dMeter = $('#dMeter');
(function tick() {
  const f = engine.freq;
  dFreq.textContent = f > 1 ? String(Math.round(f)).padStart(4, ' ') : '----';
  dMeter.style.transform = `scaleX(${Math.min(1, engine.level * 1.4).toFixed(3)})`;
  requestAnimationFrame(tick);
})();

render();

if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
