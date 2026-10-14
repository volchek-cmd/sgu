// Синтез звуков СГУ прямо на устройстве. Никаких аудиофайлов: каждый сэмпл считается кодом.
// Генератор один и тот же для AudioWorklet и для запасного ScriptProcessor (старые браузеры).

const GEN_SRC = String.raw`
class SirenGen {
  constructor(sr) {
    this.sr = sr; this.dt = 1 / sr;
    this.mode = 'off'; this.modeT = 0; this.ph = 0; this.env = 0; this.sf = 0;
    this.horn = false; this.hornStyle = 'kryak'; this.hT = 0; this.hEnv = 0; this.gate = 1; this.hf = 0;
    this.hp1 = 0; this.hp2 = 0; this.amp = 0;
    this.manual = false; this.man = 0; this.manPh = 0; this.manF = 0;
    this.rpm = 0; this.mp = 0; this.mf = 0;
    this.dispF = 0; this.level = 0; this.seed = 22222; this.drift = 0; this.jit = 0;
    // профиль блока СГУ (диапазон и скорости тонов из паспорта); см. PROFILES в engine.js
    this.p = { lo: 600, hi: 1500, wail: 4.0, yelp: 0.3, fast: 0.08, hiloA: 1100, hiloB: 750, hiloP: 1.0 };
  }

  set(m) {
    if (m.mode !== undefined && m.mode !== this.mode) { this.mode = m.mode; this.modeT = 0; }
    if (m.horn !== undefined) { if (m.horn && !this.horn) this.hT = 0; this.horn = m.horn; }
    if (m.hornStyle !== undefined) this.hornStyle = m.hornStyle;
    if (m.manual !== undefined) this.manual = m.manual;
    if (m.profile !== undefined) this.p = m.profile;
  }

  // PolyBLEP — убирает алиасинг у прямоугольника и пилы
  blep(t, dt) {
    if (t < dt) { t /= dt; return t + t - t * t - 1; }
    if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
    return 0;
  }
  sq(ph, dt) {
    let v = ph < 0.5 ? 1 : -1;
    v += this.blep(ph, dt);
    v -= this.blep((ph + 0.5) % 1, dt);
    return v;
  }
  saw(ph, dt) { return 2 * ph - 1 - this.blep(ph, dt); }
  noise() { this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff; return this.seed / 0x3fffffff - 1; }

  // Один цикл свипа: быстрый подъём с замедлением у вершины, затем спад
  sweep(t, period, rise, lo, hi, fallPow) {
    const x = (t % period) / period;
    let v;
    if (x < rise) { const u = x / rise; v = 1 - (1 - u) * (1 - u); }
    else { const u = (x - rise) / (1 - rise); v = Math.pow(1 - u, fallPow); }
    return lo + (hi - lo) * v;
  }

  sirenFreq(t) {
    const p = this.p;
    switch (this.mode) {
      case 'wail':   return this.sweep(t, p.wail, 0.45, p.lo, p.hi, 1.2);   // WAIL — «вой/волна»
      case 'yelp':   return this.sweep(t, p.yelp, 0.5, p.lo, p.hi, 1.0);    // YELP — «трель»
      case 'piu':    return this.sweep(t, 0.2, 0.08, p.lo, Math.min(2000, p.hi + 100), 1.8); // «пиу‑пиу»
      case 'phaser': return this.sweep(t, p.fast, 0.5, p.lo, p.hi, 1.0);    // PULSAR / PRIORITY
      case 'hilo':   return (t % p.hiloP) < p.hiloP / 2 ? p.hiloA : p.hiloB; // HI‑LO
    }
    return 0;
  }

  render(out, n) {
    const sr = this.sr, dt = this.dt;
    const kEnv = 1 - Math.exp(-1 / (0.012 * sr));
    const kAtt = 1 - Math.exp(-1 / (0.004 * sr));
    const kRel = 1 - Math.exp(-1 / (0.03 * sr));
    const kGate = 1 - Math.exp(-1 / (0.006 * sr));
    const kSlew = 1 - Math.exp(-1 / (0.003 * sr));
    const tonal = this.mode !== 'off' && this.mode !== 'mech';
    let peak = 0;

    for (let i = 0; i < n; i++) {
      // --- MANUAL: электронный тон разгоняется, пока кнопка зажата, и «выбегает» вниз
      //     после отпускания (как Peak‑and‑Hold / Coast Down у PA300 и MANUAL у «Элины»)
      this.man += ((this.manual ? 1 : 0) - this.man) * (dt / (this.manual ? 1.1 : 2.2));
      let mn = 0;
      if (this.man > 0.004) {
        const f = this.p.hi * Math.sqrt(this.man);
        const inc = f * dt;
        this.manPh = (this.manPh + inc) % 1;
        mn = this.sq(this.manPh, inc) * Math.min(1, this.man * 6) * (this.horn ? 0 : 1);
        this.manF = f;
      }
      const manOn = this.man > 0.05;

      // --- электронная сирена (кряк и MANUAL её перебивают, как на настоящем пульте)
      this.env += ((tonal && !this.horn && !manOn ? 1 : 0) - this.env) * kEnv;
      let s = 0;
      if (tonal) {
        // Генератор настоящего пульта не идеален: частота чуть «плывёт»,
        // а переключения тона сглажены инерцией схемы (~3 мс)
        this.drift += (this.noise() * 0.004 - this.drift) * 0.0005;
        const target = this.sirenFreq(this.modeT) * (1 + this.drift);
        if (this.env < 0.001) this.sf = target;
        this.sf += (target - this.sf) * kSlew;
        this.modeT += dt;
        const inc = this.sf * dt;
        this.ph = (this.ph + inc) % 1;
        s = this.sq(this.ph, inc) * this.env;   // выходной каскад СГУ гонит чистый меандр в рупор
      }

      // --- механическая сирена СО‑120: ротор раскручивается и выбегает
      const spin = this.mode === 'mech' && !this.horn;
      const tau = spin ? 3.0 : 4.5;
      this.rpm += ((spin ? 1 : 0) - this.rpm) * (dt / tau);
      let m = 0;
      if (this.rpm > 0.003) {
        const mf = 90 + 1050 * this.rpm;
        const inc = mf * dt;
        this.mp = (this.mp + inc) % 1;
        const pulse = this.saw(this.mp, inc) - this.saw((this.mp + 0.62) % 1, inc);
        m = (0.75 * pulse + 0.25 * this.noise() * (0.3 + this.rpm)) * Math.min(1, this.rpm * 1.8);
        this.mf = mf;
      }

      // --- кряк / гудок: звучит ровно пока кнопка зажата
      this.hEnv += ((this.horn ? 1 : 0) - this.hEnv) * (this.horn ? kAtt : kRel);
      let h = 0;
      if (this.hEnv > 0.0005) {
        const t = this.hT; this.hT += dt;
        if (this.hornStyle === 'air') {
          // пневмогудок: два тона аккордом с лёгким «подъездом» по высоте
          const bend = 1 + 0.06 * Math.exp(-t / 0.06);
          const f1 = 311 * bend, f2 = 392 * bend;
          const i1 = f1 * dt, i2 = f2 * dt;
          this.hp1 = (this.hp1 + i1) % 1; this.hp2 = (this.hp2 + i2) % 1;
          this.amp = (this.amp + 28 * dt) % 1;
          h = (0.55 * this.sq(this.hp1, i1) + 0.5 * this.sq(this.hp2, i2)) * (0.85 + 0.15 * Math.sin(6.2832 * this.amp));
          this.hf = f1;
        } else {
          // «кряк» ДПС (Air Horn): низкий монотонный рык ~78 Гц из несимметричных
          // прямоугольных импульсов. Узкий импульс даёт густой ряд гармоник —
          // звук «прорезает» поток, даже когда динамик не тянет саму основную частоту
          let g = 1;
          if (this.hornStyle === 'series') {
            this.gate += ((t % 0.22 < 0.14 ? 1 : 0) - this.gate) * kGate;
            g = this.gate;
          }
          // лёгкое дрожание периода, как у реального задающего генератора
          this.jit += (this.noise() * 0.012 - this.jit) * 0.002;
          const f1 = 78 * (1 + this.jit), duty = 0.28;
          const i1 = f1 * dt;
          this.hp1 = (this.hp1 + i1) % 1;
          const pulse = this.saw(this.hp1, i1) - this.saw((this.hp1 + duty) % 1, i1);
          h = pulse * 1.1 * g;
          this.hf = f1;
        }
        h *= this.hEnv;
      }

      let x = 0.55 * (s + mn) + 0.6 * m + 0.65 * h;
      x = Math.tanh(2.6 * x) * 0.72;   // перегруз 100‑ваттного усилителя СГУ
      out[i] = x;
      const a = x < 0 ? -x : x;
      if (a > peak) peak = a;
    }

    this.level = Math.max(peak, this.level * 0.85);
    this.dispF = this.horn ? this.hf
      : this.man > 0.02 ? this.manF
      : tonal ? this.sf
      : this.rpm > 0.02 ? this.mf : 0;
  }
}
`;

const WORKLET_SRC = GEN_SRC + `
class SirenProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.g = new SirenGen(sampleRate);
    this.k = 0;
    this.port.onmessage = (e) => this.g.set(e.data);
  }
  process(inputs, outputs) {
    const chans = outputs[0];
    const out = chans[0];
    this.g.render(out, out.length);
    for (let c = 1; c < chans.length; c++) chans[c].set(out);
    if ((this.k += out.length) >= 1536) {
      this.k = 0;
      this.port.postMessage({ f: this.g.dispF, l: this.g.level });
    }
    return true;
  }
}
registerProcessor('siren-gen', SirenProcessor);
`;

// Профили блоков СГУ. Периоды — из паспортных «циклов в минуту» (60 / N).
// Где паспорт молчит, значение типовое и помечено.
const PROFILES = {
  // Отечественный типовой (Элина «Смерч»/«Сапфир», Элект): паспортных Гц в открытом
  // доступе нет, параметры — в рамках ГОСТ Р 50574 (150–2000 Гц, цикл 0,5–6 с)
  rf:    { lo: 600, hi: 1500, wail: 4.0,     yelp: 0.30,     fast: 0.08,     hiloA: 1100, hiloB: 750, hiloP: 1.0 },
  // Federal Signal PA300: 725–1800 Гц, Wail 15/мин, Yelp 220/мин, Hi‑Lo 70/мин, Priority 1300/мин
  // (частоты Hi‑Lo в паспорте не указаны — типовые)
  pa300: { lo: 725, hi: 1800, wail: 60 / 15, yelp: 60 / 220, fast: 60 / 1300, hiloA: 1050, hiloB: 800, hiloP: 60 / 70 },
  // Premier Hazard 7007: 500–1800 Гц, Wail 11/мин, Yelp 178/мин, Pulsar 650/мин, Hi‑Lo 670–1100 Гц 55/мин
  p7007: { lo: 500, hi: 1800, wail: 60 / 11, yelp: 60 / 178, fast: 60 / 650,  hiloA: 1100, hiloB: 670, hiloP: 60 / 55 },
};

class SirenEngine {
  constructor() {
    this.ctx = null;
    this.state = { mode: 'off', horn: false, manual: false, hornStyle: 'kryak' };
    this.send = null;
    this.freq = 0;
    this.level = 0;
    this.volume = 0.8;
  }

  // Вызывать синхронно внутри обработчика нажатия — иначе iOS не даст звук
  unlock() {
    if (!this.ctx) {
      try { if (navigator.audioSession) navigator.audioSession.type = 'playback'; } catch (e) {}
      const AC = window.AudioContext || window.webkitAudioContext;
      this.ctx = new AC({ latencyHint: 'interactive' });
      this._build();
    }
    if (this.ctx.state !== 'running') this.ctx.resume();
  }

  _build() {
    const ctx = this.ctx;
    const biquad = (type, f, q, g) => {
      const b = ctx.createBiquadFilter();
      b.type = type; b.frequency.value = f; b.Q.value = q;
      if (g !== undefined) b.gain.value = g;
      return b;
    };
    const chain = (nodes) => { for (let i = 1; i < nodes.length; i++) nodes[i - 1].connect(nodes[i]); return nodes; };

    // 1. Драйвер рупора: мембрана не отрабатывает низ и перегружается на громкости
    const driver = chain([biquad('highpass', 330, 0.9), biquad('highpass', 330, 0.6)]);
    const drive = ctx.createWaveShaper();
    const curve = new Float32Array(2048);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.tanh(2.2 * x + 0.25 * x * x) * 0.85;
    }
    drive.curve = curve; drive.oversample = '4x';
    driver[1].connect(drive);

    // 2. Свёрнутый (re‑entrant) рупор — это труба с отражениями от раструба.
    //    Две гребёнки с обратной связью дают ряд резонансов через ~260 и ~430 Гц:
    //    при свипе громкость и тембр «гуляют», а импульсы кряка звенят металлом.
    const comb = (src, delay, fb, damp) => {
      const sum = ctx.createGain();
      const d = ctx.createDelay(0.05); d.delayTime.value = delay;
      const lp = biquad('lowpass', damp, 0.5);
      const g = ctx.createGain(); g.gain.value = fb;
      src.connect(sum);
      sum.connect(d); d.connect(lp); lp.connect(g); g.connect(sum);
      const out = ctx.createGain(); out.gain.value = 1 - fb;
      sum.connect(out);
      return out;
    };
    const tube = comb(comb(drive, 0.0038, 0.55, 3800), 0.0023, 0.35, 4500);

    // 3. Мембрана и раструб: резонансы ~1, 1,65, 2,7 кГц и завал верха
    const horn = chain([
      biquad('peaking', 1000, 2.2, 5), biquad('peaking', 1650, 3.5, 7), biquad('peaking', 2700, 4, 4),
      biquad('lowpass', 4600, 0.8), biquad('lowpass', 5200, 0.6),
    ]);
    tube.connect(horn[0]);
    const hornOut = horn[horn.length - 1];

    // 4. Два рупора на машине + отражение от капота: короткая задержка даёт «гребёнку»
    const body = ctx.createGain();
    const d1 = ctx.createDelay(0.05); d1.delayTime.value = 0.0011;
    const d1g = ctx.createGain(); d1g.gain.value = 0.55;
    const d2 = ctx.createDelay(0.05); d2.delayTime.value = 0.0047;
    const d2g = ctx.createGain(); d2g.gain.value = 0.3;
    hornOut.connect(body);
    hornOut.connect(d1); d1.connect(d1g); d1g.connect(body);
    hornOut.connect(d2); d2.connect(d2g); d2g.connect(body);

    // 5. Улица: поглощение верхов воздухом + эхо от домов
    this.air = biquad('lowpass', 12000, 0.5);
    body.connect(this.air);
    this.dry = ctx.createGain();
    this.wet = ctx.createGain();
    const verb = ctx.createConvolver();
    verb.buffer = this._streetIR();
    this.air.connect(this.dry);
    this.air.connect(verb); verb.connect(this.wet);

    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -12; comp.ratio.value = 5; comp.attack.value = 0.003; comp.release.value = 0.15;
    this.gain = ctx.createGain(); this.gain.gain.value = this.volume;
    this.dry.connect(comp); this.wet.connect(comp);
    comp.connect(this.gain); this.gain.connect(ctx.destination);
    this.input = driver[0];
    this.setAcoustic(this.acoustic || 'street');

    const ready = (send) => { this.send = send; send({ ...this.state }); };

    if (ctx.audioWorklet && window.AudioWorkletNode) {
      const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      ctx.audioWorklet.addModule(url).then(() => {
        const node = new AudioWorkletNode(ctx, 'siren-gen', { numberOfInputs: 0, outputChannelCount: [1] });
        node.port.onmessage = (e) => { this.freq = e.data.f; this.level = e.data.l; };
        node.connect(this.input);
        ready((m) => node.port.postMessage(m));
      }).catch(() => this._fallback(ready));
    } else {
      this._fallback(ready);
    }
  }

  _fallback(ready) {
    const Gen = new Function(GEN_SRC + '; return SirenGen;')();
    const gen = new Gen(this.ctx.sampleRate);
    const sp = this.ctx.createScriptProcessor(1024, 1, 1);
    sp.onaudioprocess = (e) => {
      const out = e.outputBuffer.getChannelData(0);
      gen.render(out, out.length);
      this.freq = gen.dispF; this.level = gen.level;
    };
    sp.connect(this.input);
    this._sp = sp; // держим ссылку, иначе Safari может собрать узел сборщиком мусора
    ready((m) => gen.set(m));
  }

  // Импульсная характеристика городской улицы: отдельные отражения от домов
  // и затухающий «хвост». Стерео — разные отражения слева и справа.
  _streetIR() {
    const sr = this.ctx.sampleRate;
    const len = Math.floor(sr * 2.4);
    const ir = this.ctx.createBuffer(2, len, sr);
    let seed = 1234;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      // ранние отражения: фасады домов на расстоянии 5–40 м
      for (let k = 0; k < 14; k++) {
        const t = 0.015 + rnd() * 0.22;
        const i = Math.floor(t * sr);
        d[i] += (rnd() < 0.5 ? -1 : 1) * (0.25 + rnd() * 0.45) * Math.exp(-t / 0.35);
      }
      // диффузный хвост, тёмный (высокие частоты гаснут быстрее)
      let lp = 0;
      for (let i = Math.floor(0.03 * sr); i < len; i++) {
        const t = i / sr;
        lp += ((rnd() * 2 - 1) - lp) * (0.35 * Math.exp(-t / 1.2) + 0.05);
        d[i] += lp * 0.5 * Math.exp(-t / 0.55) * Math.min(1, (t - 0.03) / 0.05);
      }
    }
    return ir;
  }

  // Где «стоит» слушатель относительно машины
  setAcoustic(name) {
    this.acoustic = name;
    if (!this.ctx) return;
    const p = {
      near:   { air: 14000, dry: 1.0,  wet: 0.12 },
      street: { air: 8000,  dry: 0.85, wet: 0.38 },
      far:    { air: 2600,  dry: 0.3,  wet: 0.75 },
    }[name] || {};
    const t = this.ctx.currentTime;
    this.air.frequency.setTargetAtTime(p.air, t, 0.05);
    this.dry.gain.setTargetAtTime(p.dry, t, 0.05);
    this.wet.gain.setTargetAtTime(p.wet, t, 0.05);
  }

  set(patch) {
    Object.assign(this.state, patch);
    if (this.send) this.send(patch);
  }

  setVolume(v) {
    this.volume = v;
    if (this.gain) this.gain.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }

  suspend() { if (this.ctx && this.ctx.state === 'running') this.ctx.suspend(); }
}
