export class GameAudio {
  constructor() {
    this.context = null;
    this.master = null;
    this.ambient = null;
    this.bossNodes = [];
  }

  async resume() {
    if (typeof window === 'undefined') return;
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    if (!this.context) {
      this.context = new AudioContext();
      this.master = this.context.createGain();
      this.master.gain.value = 0.22;
      this.master.connect(this.context.destination);
    }
    if (this.context.state === 'suspended') await this.context.resume();
    this.startAmbience();
  }

  startAmbience() {
    if (!this.context || this.ambient) return;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.value = 47;
    gain.gain.value = 0.022;
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start();
    this.ambient = { oscillator, gain };
  }

  play(name) {
    if (!this.context || !this.master) return;
    const sounds = {
      swing: [180, 0.045, 'triangle', 0.11],
      rock: [92, 0.07, 'square', 0.12],
      hit: [135, 0.055, 'sawtooth', 0.11],
      crystal: [740, 0.16, 'sine', 0.13],
      dash: [410, 0.09, 'triangle', 0.1],
      blaster: [620, 0.07, 'square', 0.085],
      throw: [250, 0.08, 'triangle', 0.09],
      boom: [58, 0.28, 'sawtooth', 0.19],
      hurt: [105, 0.13, 'square', 0.14],
      roomLock: [155, 0.18, 'square', 0.12],
      roomClear: [520, 0.22, 'triangle', 0.13],
      bossPhase: [240, 0.32, 'sawtooth', 0.14],
      guardianDown: [330, 0.5, 'triangle', 0.16],
      extract: [880, 0.42, 'sine', 0.14],
      weapon: [690, 0.18, 'triangle', 0.12]
    };
    const [frequency, duration, type, volume] = sounds[name] || sounds.hit;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, now);
    if (name === 'boom') oscillator.frequency.exponentialRampToValueAtTime(28, now + duration);
    else oscillator.frequency.exponentialRampToValueAtTime(Math.max(40, frequency * 0.72), now + duration);
    gain.gain.setValueAtTime(volume, now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    oscillator.connect(gain);
    gain.connect(this.master);
    oscillator.start(now);
    oscillator.stop(now + duration + 0.02);
  }

  startBoss() {
    if (!this.context || this.bossNodes.length) return;
    for (const [frequency, type, volume] of [[82, 'square', 0.025], [123, 'triangle', 0.018]]) {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = type;
      oscillator.frequency.value = frequency;
      gain.gain.value = volume;
      oscillator.connect(gain);
      gain.connect(this.master);
      oscillator.start();
      this.bossNodes.push({ oscillator, gain });
    }
  }

  stopBoss() {
    for (const node of this.bossNodes) {
      try { node.oscillator.stop(); } catch {}
      try { node.oscillator.disconnect(); } catch {}
      try { node.gain.disconnect(); } catch {}
    }
    this.bossNodes = [];
  }
}
