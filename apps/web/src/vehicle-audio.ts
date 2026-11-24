import type { CarState, PlayerInput } from '@openstreet-racer/shared';

const STORAGE_KEY = 'openstreet-racer-audio';
const DEFAULT_VOLUME = 0.3;

interface AudioPreferences {
  volume: number;
  muted: boolean;
}

export interface VehicleAudioLevels {
  readonly engineFrequencyHz: number;
  readonly engineGain: number;
  readonly tireGain: number;
  readonly ambienceGain: number;
}

export function vehicleAudioLevels(
  car: Pick<CarState, 'velocity' | 'headingRadians'>,
  input: PlayerInput,
): VehicleAudioLevels {
  const forwardSpeed = Math.max(
    0,
    car.velocity.x * Math.sin(car.headingRadians) + car.velocity.y * Math.cos(car.headingRadians),
  );
  const lateralSpeed =
    car.velocity.x * Math.cos(car.headingRadians) - car.velocity.y * Math.sin(car.headingRadians);
  const slip = Math.min(1, Math.abs(lateralSpeed) / Math.max(4, forwardSpeed * 0.3));
  const engineFrequencyHz = 58 + Math.min(forwardSpeed, 38) * 6.4 + input.throttle * 26;
  const engineGain = Math.min(0.12, 0.012 + forwardSpeed * 0.0015 + input.throttle * 0.035);
  const tireGain = Math.min(
    0.045,
    forwardSpeed * (0.00035 + slip * 0.0018) + input.handbrake * 0.012,
  );
  const ambienceGain = Math.min(0.012, 0.002 + forwardSpeed * 0.00018);
  return { engineFrequencyHz, engineGain, tireGain, ambienceGain };
}

export class VehicleAudio {
  private context: AudioContext | null = null;
  private master: GainNode | null = null;
  private engine: OscillatorNode | null = null;
  private engineHarmonic: OscillatorNode | null = null;
  private engineFilter: BiquadFilterNode | null = null;
  private engineGain: GainNode | null = null;
  private tireSource: AudioBufferSourceNode | null = null;
  private tireFilter: BiquadFilterNode | null = null;
  private tireGain: GainNode | null = null;
  private ambienceFilter: BiquadFilterNode | null = null;
  private ambienceGain: GainNode | null = null;
  private sirenOscillator: OscillatorNode | null = null;
  private sirenGain: GainNode | null = null;
  private sirenLfo: OscillatorNode | null = null;
  private sirenLfoGain: GainNode | null = null;
  private sirenActive = false;
  private preferences: AudioPreferences = readPreferences();

  get volume(): number {
    return this.preferences.volume;
  }

  get muted(): boolean {
    return this.preferences.muted;
  }

  activate(): void {
    if (this.context) {
      if (this.context.state === 'suspended') void this.context.resume();
      return;
    }
    const AudioContextClass = window.AudioContext;
    if (!AudioContextClass) return;
    const context = new AudioContextClass();
    const master = context.createGain();
    master.gain.value = this.preferences.muted ? 0 : this.preferences.volume;
    master.connect(context.destination);

    const engineFilter = context.createBiquadFilter();
    engineFilter.type = 'lowpass';
    engineFilter.frequency.value = 340;
    const engineGain = context.createGain();
    engineGain.gain.value = 0.004;
    const engine = context.createOscillator();
    engine.type = 'sawtooth';
    engine.frequency.value = 58;
    engine.connect(engineFilter);
    engineFilter.connect(engineGain);
    engineGain.connect(master);
    engine.start();

    const harmonicGain = context.createGain();
    harmonicGain.gain.value = 0.28;
    const engineHarmonic = context.createOscillator();
    engineHarmonic.type = 'triangle';
    engineHarmonic.frequency.value = 116;
    engineHarmonic.connect(harmonicGain);
    harmonicGain.connect(engineFilter);
    engineHarmonic.start();

    const noiseBuffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const noise = noiseBuffer.getChannelData(0);
    for (let index = 0; index < noise.length; index += 1) noise[index] = Math.random() * 2 - 1;

    const tireSource = context.createBufferSource();
    tireSource.buffer = noiseBuffer;
    tireSource.loop = true;
    const tireFilter = context.createBiquadFilter();
    tireFilter.type = 'bandpass';
    tireFilter.frequency.value = 820;
    tireFilter.Q.value = 0.7;
    const tireGain = context.createGain();
    tireGain.gain.value = 0;
    tireSource.connect(tireFilter);
    tireFilter.connect(tireGain);
    tireGain.connect(master);
    tireSource.start();

    const ambienceFilter = context.createBiquadFilter();
    ambienceFilter.type = 'lowpass';
    ambienceFilter.frequency.value = 240;
    const ambienceGain = context.createGain();
    ambienceGain.gain.value = 0.002;
    const ambienceSource = context.createBufferSource();
    ambienceSource.buffer = noiseBuffer;
    ambienceSource.loop = true;
    ambienceSource.connect(ambienceFilter);
    ambienceFilter.connect(ambienceGain);
    ambienceGain.connect(master);
    ambienceSource.start();

    const sirenLfoGain = context.createGain();
    sirenLfoGain.gain.value = 140;
    const sirenLfo = context.createOscillator();
    sirenLfo.type = 'square';
    sirenLfo.frequency.value = 1.6;
    sirenLfo.connect(sirenLfoGain);
    sirenLfo.start();

    const sirenGain = context.createGain();
    sirenGain.gain.value = 0;
    const sirenOscillator = context.createOscillator();
    sirenOscillator.type = 'sawtooth';
    sirenOscillator.frequency.value = 620;
    sirenLfoGain.connect(sirenOscillator.frequency);
    sirenOscillator.connect(sirenGain);
    sirenGain.connect(master);
    sirenOscillator.start();

    this.context = context;
    this.master = master;
    this.engine = engine;
    this.engineHarmonic = engineHarmonic;
    this.engineFilter = engineFilter;
    this.engineGain = engineGain;
    this.tireSource = tireSource;
    this.tireFilter = tireFilter;
    this.tireGain = tireGain;
    this.ambienceFilter = ambienceFilter;
    this.ambienceGain = ambienceGain;
    this.sirenOscillator = sirenOscillator;
    this.sirenGain = sirenGain;
    this.sirenLfo = sirenLfo;
    this.sirenLfoGain = sirenLfoGain;
  }

  setSiren(active: boolean): void {
    this.sirenActive = active;
    const context = this.context;
    if (!context || !this.sirenGain) return;
    this.sirenGain.gain.setTargetAtTime(active ? 0.035 : 0, context.currentTime, 0.12);
  }

  update(car: CarState, input: PlayerInput): void {
    const context = this.context;
    if (!context || !this.engine || !this.engineHarmonic || !this.engineFilter) return;
    if (context.state === 'suspended') void context.resume();
    const levels = vehicleAudioLevels(car, input);
    const now = context.currentTime;
    const forwardSpeed = Math.max(
      0,
      car.velocity.x * Math.sin(car.headingRadians) + car.velocity.y * Math.cos(car.headingRadians),
    );
    this.engine.frequency.setTargetAtTime(levels.engineFrequencyHz, now, 0.09);
    this.engineHarmonic.frequency.setTargetAtTime(levels.engineFrequencyHz * 2, now, 0.09);
    this.engineFilter.frequency.setTargetAtTime(230 + forwardSpeed * 34, now, 0.12);
    this.engineGain?.gain.setTargetAtTime(levels.engineGain, now, 0.12);
    this.tireFilter?.frequency.setTargetAtTime(620 + forwardSpeed * 42, now, 0.15);
    this.tireGain?.gain.setTargetAtTime(levels.tireGain, now, 0.16);
    this.ambienceFilter?.frequency.setTargetAtTime(180 + forwardSpeed * 12, now, 0.2);
    this.ambienceGain?.gain.setTargetAtTime(levels.ambienceGain, now, 0.2);
  }

  setVolume(volume: number): void {
    this.preferences.volume = clamp(volume, 0, 1);
    this.persist();
    this.applyMasterVolume();
  }

  toggleMuted(): boolean {
    this.preferences.muted = !this.preferences.muted;
    this.persist();
    this.applyMasterVolume();
    return this.preferences.muted;
  }

  setMuted(muted: boolean): void {
    this.preferences.muted = muted;
    this.persist();
    this.applyMasterVolume();
  }

  destroy(): void {
    this.engine?.stop();
    this.engineHarmonic?.stop();
    this.tireSource?.stop();
    this.sirenLfo?.stop();
    this.sirenOscillator?.stop();
    if (this.context) void this.context.close();
    this.context = null;
  }

  private applyMasterVolume(): void {
    if (!this.context || !this.master) return;
    const target = this.preferences.muted ? 0 : this.preferences.volume;
    this.master.gain.setTargetAtTime(target, this.context.currentTime, 0.035);
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.preferences));
    } catch {
      return;
    }
  }
}

function readPreferences(): AudioPreferences {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? 'null');
    if (parsed && typeof parsed === 'object') {
      const preferences = parsed as Partial<AudioPreferences>;
      return {
        volume:
          typeof preferences.volume === 'number' ? clamp(preferences.volume, 0, 1) : DEFAULT_VOLUME,
        muted: preferences.muted === true,
      };
    }
  } catch {
    return { volume: DEFAULT_VOLUME, muted: false };
  }
  return { volume: DEFAULT_VOLUME, muted: false };
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : minimum;
}
