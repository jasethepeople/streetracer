import type {
  ActiveMission,
  LeaderboardSnapshot,
  LonLat,
  MissionOffer,
  PlayerProfile,
} from '@openstreet-racer/shared';
import { haversineMeters } from '@openstreet-racer/world';
import { getVehicleCatalog } from '@openstreet-racer/vehicle/catalog';
import type { GameSettings } from './progress-store';

export type MenuTab = 'missions' | 'build' | 'garage' | 'leaderboards' | 'settings';

export interface GameMenuCallbacks {
  readonly requestMissions: () => void;
  readonly missionAction: (action: 'accept' | 'abandon', missionId: string) => void;
  readonly garageAction: (action: 'buy' | 'select' | 'repair', vehicleId?: string) => void;
  readonly respawn: () => void;
  readonly requestLeaderboard: (raceId?: string) => void;
  readonly publishRace: (title: string, destination: string, waypoints?: readonly LonLat[]) => void;
  readonly getCarPosition: () => LonLat | null;
  readonly saveSettings: (settings: GameSettings) => void;
}

export class GameMenu {
  private readonly content: HTMLElement;
  private readonly status: HTMLElement;
  private readonly profile: HTMLElement;
  private offers: readonly MissionOffer[] = [];
  private activeMission: ActiveMission | null = null;
  private currentProfile: PlayerProfile | null = null;
  private leaderboard: LeaderboardSnapshot | null = null;
  private tab: MenuTab = 'missions';
  private draftCourse: readonly LonLat[] = [];
  private settings: GameSettings;
  private isOpen = false;
  private missionRequestPending = false;

  constructor(
    private readonly root: HTMLElement,
    private readonly openButton: HTMLButtonElement,
    initialSettings: GameSettings,
    private readonly callbacks: GameMenuCallbacks,
  ) {
    this.content = requiredElement(root, '#game-menu-content');
    this.status = requiredElement(root, '#game-menu-status');
    this.profile = requiredElement(root, '#game-menu-profile');
    this.settings = initialSettings;
    this.openButton.addEventListener('click', () => this.toggle());
    requiredElement<HTMLButtonElement>(root, '#game-menu-close').addEventListener('click', () =>
      this.close(),
    );
    for (const button of root.querySelectorAll<HTMLButtonElement>('[data-menu-tab]')) {
      button.addEventListener('click', () => {
        this.tab = button.dataset.menuTab as MenuTab;
        this.render();
      });
    }
    root.addEventListener('click', (event) => {
      if (event.target === root) this.close();
    });
    this.render();
  }

  setOffers(offers: readonly MissionOffer[], activeMission: ActiveMission | null): void {
    this.offers = offers;
    this.activeMission = activeMission;
    if (this.missionRequestPending) {
      this.status.textContent = '';
      this.missionRequestPending = false;
    }
    if (this.tab === 'missions' || this.tab === 'leaderboards') this.render();
  }

  setProfile(profile: PlayerProfile): void {
    this.currentProfile = profile;
    this.activeMission = profile.activeMission;
    this.profile.textContent = `${this.t('balance')}: ${formatMoney(profile.balanceCents)} · ${this.t('missionsDone')}: ${profile.totalMissions}`;
    if (this.tab === 'garage' || this.tab === 'missions') this.render();
  }

  setLeaderboard(snapshot: LeaderboardSnapshot): void {
    this.leaderboard = snapshot;
    if (this.tab === 'leaderboards') this.render();
  }

  setStatus(message: string): void {
    this.status.textContent = message;
  }

  get currentSettings(): GameSettings {
    return this.settings;
  }

  setSettings(settings: GameSettings): void {
    this.settings = settings;
    this.render();
  }

  refresh(): void {
    this.render();
  }

  refreshMissions(): void {
    this.missionRequestPending = true;
    this.callbacks.requestMissions();
    this.setStatus(this.t('loadingMissions'));
  }

  open(tab: MenuTab = this.tab): void {
    this.tab = tab;
    this.isOpen = true;
    this.root.hidden = false;
    this.openButton.setAttribute('aria-expanded', 'true');
    this.render();
    if ((tab === 'missions' || tab === 'leaderboards') && this.offers.length === 0) {
      this.refreshMissions();
    }
    if (tab === 'leaderboards') this.callbacks.requestLeaderboard();
  }

  close(): void {
    this.isOpen = false;
    this.root.hidden = true;
    this.openButton.setAttribute('aria-expanded', 'false');
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  private render(): void {
    this.root.lang = this.settings.language === 'es' ? 'es' : 'en';
    for (const button of this.root.querySelectorAll<HTMLButtonElement>('[data-menu-tab]')) {
      const selected = button.dataset.menuTab === this.tab;
      button.setAttribute('aria-selected', String(selected));
      button.textContent = this.t(button.dataset.menuTab ?? 'missions');
    }
    this.profile.textContent = this.currentProfile
      ? `${this.t('balance')}: ${formatMoney(this.currentProfile.balanceCents)} · ${this.t('missionsDone')}: ${this.currentProfile.totalMissions}`
      : this.t('loadingProfile');
    this.content.replaceChildren();
    if (this.tab === 'missions') this.renderMissions();
    if (this.tab === 'build') this.renderBuild();
    if (this.tab === 'garage') this.renderGarage();
    if (this.tab === 'leaderboards') this.renderLeaderboards();
    if (this.tab === 'settings') this.renderSettings();
  }

  private renderBuild(): void {
    const builder = makeElement('article', 'menu-card race-builder');
    builder.append(makeElement('strong', '', this.t('buildCourse')));
    builder.append(makeElement('p', 'menu-muted', this.t('buildIntro')));

    const list = makeElement('ul', 'menu-checkpoint-list');
    if (this.draftCourse.length === 0) {
      list.append(makeElement('li', 'menu-muted', this.t('courseEmpty')));
    } else {
      this.draftCourse.forEach((point, index) => {
        const from = index === 0 ? point : this.draftCourse[index - 1]!;
        const meters = Math.round(haversineMeters(from, point));
        list.append(makeElement('li', '', `${this.t('coursePoint')} ${index + 1} · ${meters} m`));
      });
    }
    builder.append(list);

    const row = makeElement('div', 'menu-race-form');
    const drop = makeElement('button', 'menu-button', this.t('dropCheckpoint'));
    drop.type = 'button';
    drop.addEventListener('click', () => {
      const position = this.callbacks.getCarPosition();
      if (!position) {
        this.setStatus(this.t('courseNoCar'));
        return;
      }
      const last = this.draftCourse.at(-1);
      if (last && haversineMeters(last, position) < 100) {
        this.setStatus(this.t('courseTooClose'));
        return;
      }
      if (this.draftCourse.length >= 5) {
        this.setStatus(this.t('courseFull'));
        return;
      }
      this.draftCourse = [...this.draftCourse, position];
      this.setStatus('');
      this.render();
    });
    const removeLast = makeElement('button', 'menu-button', this.t('removeLastCheckpoint'));
    removeLast.type = 'button';
    removeLast.disabled = this.draftCourse.length === 0;
    removeLast.addEventListener('click', () => {
      this.draftCourse = this.draftCourse.slice(0, -1);
      this.render();
    });
    const clear = makeElement('button', 'menu-button', this.t('clearCourse'));
    clear.type = 'button';
    clear.disabled = this.draftCourse.length === 0;
    clear.addEventListener('click', () => {
      this.draftCourse = [];
      this.render();
    });
    row.append(drop, removeLast, clear);
    builder.append(row);

    const form = makeElement('form', 'menu-race-form');
    const title = makeElement('input', 'menu-select');
    title.required = true;
    title.maxLength = 48;
    title.placeholder = this.t('raceName');
    title.setAttribute('aria-label', this.t('raceName'));
    const publish = makeElement('button', 'menu-button', this.t('publishCourse'));
    publish.type = 'submit';
    publish.disabled = this.draftCourse.length === 0;
    form.append(title, publish);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const finish = this.draftCourse.at(-1);
      if (!finish) return;
      this.callbacks.publishRace(title.value.trim(), '', [...this.draftCourse]);
      this.draftCourse = [];
    });
    builder.append(form);
    this.content.append(builder);
  }

  private renderMissions(): void {
    const publisher = makeElement('article', 'menu-card race-publisher');
    publisher.append(makeElement('strong', '', this.t('createRace')));
    publisher.append(makeElement('p', 'menu-muted', this.t('raceStartsHere')));
    const form = makeElement('form', 'menu-race-form');
    const title = makeElement('input', 'menu-select');
    title.required = true;
    title.maxLength = 48;
    title.placeholder = this.t('raceName');
    title.setAttribute('aria-label', this.t('raceName'));
    const destination = makeElement('input', 'menu-select');
    destination.required = true;
    destination.minLength = 3;
    destination.placeholder = this.t('raceDestination');
    destination.setAttribute('aria-label', this.t('raceDestination'));
    const publish = makeElement('button', 'menu-button', this.t('publishRace'));
    publish.type = 'submit';
    form.append(title, destination, publish);
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.callbacks.publishRace(title.value.trim(), destination.value.trim());
    });
    publisher.append(form);
    this.content.append(publisher);
    if (this.activeMission) {
      const { offer, startedAtMs, nextCheckpointIndex } = this.activeMission;
      const active = makeElement('article', 'menu-card active-mission');
      active.append(makeElement('strong', '', offer.title));
      active.append(
        makeElement(
          'p',
          '',
          startedAtMs === null ? this.t('driveToPickup') : this.t('missionActive'),
        ),
      );
      if (offer.checkpoints.length) {
        active.append(
          makeElement(
            'p',
            'menu-muted',
            `${this.t('checkpoints')}: ${nextCheckpointIndex}/${offer.checkpoints.length}`,
          ),
        );
      }
      const details = makeElement(
        'p',
        'menu-muted',
        `${formatDistance(offer.distanceMeters)} · ${formatMoney(offer.rewardCents)}`,
      );
      active.append(details);
      const abandon = makeElement('button', 'menu-button secondary', this.t('abandon'));
      abandon.addEventListener('click', () => this.callbacks.missionAction('abandon', offer.id));
      active.append(abandon);
      this.content.append(active);
    }
    if (!this.offers.length) {
      this.content.append(makeElement('p', 'menu-muted', this.t('noMissions')));
    }
    for (const offer of this.offers) {
      if (this.activeMission?.offer.id === offer.id) continue;
      const card = makeElement('article', 'menu-card');
      card.append(makeElement('strong', '', offer.title));
      card.append(
        makeElement(
          'p',
          'menu-muted',
          `${this.t(offer.kind)} · ${formatDistance(offer.distanceMeters)}`,
        ),
      );
      card.append(
        makeElement(
          'p',
          'menu-muted',
          `${this.t('reward')}: ${formatMoney(offer.rewardCents)} · ${this.t('limit')}: ${Math.ceil(offer.timeLimitSeconds / 60)} min`,
        ),
      );
      if (offer.checkpoints.length)
        card.append(
          makeElement(
            'p',
            'menu-muted',
            `${offer.checkpoints.length} ${this.t('checkpoints').toLowerCase()}`,
          ),
        );
      const accept = makeElement('button', 'menu-button', this.t('acceptMission'));
      accept.disabled = Boolean(this.activeMission);
      accept.addEventListener('click', () => this.callbacks.missionAction('accept', offer.id));
      card.append(accept);
      this.content.append(card);
    }
    const refresh = makeElement('button', 'menu-button secondary', this.t('refreshMissions'));
    refresh.addEventListener('click', () => this.refreshMissions());
    this.content.append(refresh);
  }

  private renderGarage(): void {
    const profile = this.currentProfile;
    if (!profile) {
      this.content.append(makeElement('p', 'menu-muted', this.t('loadingProfile')));
      return;
    }
    const repairCost = Math.ceil(profile.damage * 25);
    const condition = makeElement('article', 'menu-card');
    condition.append(
      makeElement(
        'strong',
        '',
        `${this.t('vehicleCondition')}: ${Math.round(100 - profile.damage)}%`,
      ),
    );
    const repair = makeElement(
      'button',
      'menu-button secondary',
      `${this.t('repair')} · ${formatMoney(repairCost)}`,
    );
    repair.disabled = profile.damage <= 0 || profile.balanceCents < repairCost;
    repair.addEventListener('click', () => this.callbacks.garageAction('repair'));
    condition.append(repair);
    const respawn = makeElement('button', 'menu-button secondary', this.t('respawn'));
    respawn.addEventListener('click', () => this.callbacks.respawn());
    condition.append(respawn);
    this.content.append(condition);

    for (const vehicle of getVehicleCatalog()) {
      const owned = profile.ownedVehicleIds.includes(vehicle.id);
      const selected = profile.selectedVehicleId === vehicle.id;
      const card = makeElement('article', `menu-card vehicle-card${selected ? ' selected' : ''}`);
      card.append(makeElement('strong', '', vehicle.name));
      card.append(makeElement('p', 'menu-muted', `${vehicle.category} · ${vehicle.visual}`));
      card.append(
        makeElement(
          'p',
          'menu-muted',
          `${Math.round(vehicle.handling.maxSpeedMps * 3.6)} km/h · ${Math.round(vehicle.handling.massKg)} kg · ${this.t('grip')} ${vehicle.handling.grip.toFixed(1)}`,
        ),
      );
      const action = makeElement(
        'button',
        'menu-button',
        selected
          ? this.t('currentVehicle')
          : owned
            ? this.t('drive')
            : `${this.t('buy')} · ${formatMoney(vehicle.costCents)}`,
      );
      action.disabled = selected || (!owned && profile.balanceCents < vehicle.costCents);
      action.addEventListener('click', () =>
        this.callbacks.garageAction(owned ? 'select' : 'buy', vehicle.id),
      );
      card.append(action);
      this.content.append(card);
    }
  }

  private renderLeaderboards(): void {
    const select = document.createElement('select');
    select.className = 'menu-select';
    select.setAttribute('aria-label', this.t('chooseRace'));
    const areaOption = new Option(this.t('areaEarnings'), '');
    select.add(areaOption);
    for (const offer of this.offers.filter(
      (candidate) => candidate.kind === 'time-trial' || candidate.kind === 'checkpoint-race',
    )) {
      select.add(new Option(offer.title, offer.id));
    }
    select.value = this.leaderboard?.raceId ?? '';
    select.addEventListener('change', () =>
      this.callbacks.requestLeaderboard(select.value || undefined),
    );
    this.content.append(select);
    if (!this.leaderboard || !this.leaderboard.entries.length) {
      this.content.append(makeElement('p', 'menu-muted', this.t('noScores')));
      return;
    }
    for (const [index, entry] of this.leaderboard.entries.entries()) {
      const row = makeElement('article', 'leaderboard-row');
      row.append(makeElement('span', 'leaderboard-rank', String(index + 1).padStart(2, '0')));
      row.append(makeElement('strong', '', entry.handle));
      const score =
        entry.timeSeconds === null ? formatMoney(entry.score) : `${entry.timeSeconds.toFixed(1)} s`;
      row.append(makeElement('span', 'leaderboard-score', score));
      this.content.append(row);
    }
  }

  private renderSettings(): void {
    this.addSetting('graphicsQuality', this.t('graphics'), [
      ['low', this.t('low')],
      ['medium', this.t('medium')],
      ['high', this.t('high')],
    ]);
    this.addSetting('controlMode', this.t('controls'), [
      ['keyboard', this.t('keyboard')],
      ['touch', this.t('touch')],
      ['both', this.t('both')],
    ]);
    this.addSetting('language', this.t('language'), [
      ['en', 'English'],
      ['es', 'Español'],
    ]);
    const volumeLabel = makeElement('label', 'setting-row');
    volumeLabel.append(makeElement('span', '', this.t('volume')));
    const volume = document.createElement('input');
    volume.type = 'range';
    volume.min = '0';
    volume.max = '1';
    volume.step = '0.01';
    volume.value = String(this.settings.audioVolume);
    const output = makeElement('output', '', `${Math.round(this.settings.audioVolume * 100)}%`);
    volume.addEventListener('input', () => {
      this.settings = { ...this.settings, audioVolume: Number(volume.value) };
      output.textContent = `${Math.round(this.settings.audioVolume * 100)}%`;
      this.callbacks.saveSettings(this.settings);
    });
    volumeLabel.append(volume, output);
    this.content.append(volumeLabel);
    const mute = makeElement(
      'button',
      'menu-button secondary',
      this.settings.audioMuted ? this.t('unmute') : this.t('mute'),
    );
    mute.setAttribute('aria-pressed', String(this.settings.audioMuted));
    mute.addEventListener('click', () => {
      this.settings = { ...this.settings, audioMuted: !this.settings.audioMuted };
      this.callbacks.saveSettings(this.settings);
      this.render();
    });
    this.content.append(mute);
  }

  private addSetting(
    key: 'graphicsQuality' | 'controlMode' | 'language',
    label: string,
    options: readonly (readonly [string, string])[],
  ): void {
    const row = makeElement('label', 'setting-row');
    row.append(makeElement('span', '', label));
    const select = document.createElement('select');
    select.className = 'menu-select';
    for (const [value, text] of options) select.add(new Option(text, value));
    select.value = this.settings[key];
    select.addEventListener('change', () => {
      const next = { ...this.settings, [key]: select.value } as GameSettings;
      this.settings = next;
      this.callbacks.saveSettings(next);
      if (key === 'language') this.render();
    });
    row.append(select);
    this.content.append(row);
  }

  private t(key: string): string {
    const language = this.settings.language;
    const words: Record<string, readonly [string, string]> = {
      missions: ['Missions', 'Misiones'],
      build: ['Build', 'Crear'],
      buildCourse: ['Build a street race', 'Crea una carrera callejera'],
      buildIntro: [
        'Drive to a spot and drop a checkpoint. Keep adding points, name the race, and publish it. Your current position is the start, and the last checkpoint is the finish.',
        'Conduce hasta un punto y deja un control. Añade más puntos, ponle nombre y publícala. Tu posición actual es la salida y el último control es la meta.',
      ],
      courseEmpty: [
        'No checkpoints yet. Drive somewhere and drop the first one.',
        'Aún no hay controles. Conduce a un sitio y deja el primero.',
      ],
      coursePoint: ['Checkpoint', 'Control'],
      dropCheckpoint: ['Drop checkpoint here', 'Dejar control aquí'],
      removeLastCheckpoint: ['Remove last', 'Quitar último'],
      clearCourse: ['Clear course', 'Borrar recorrido'],
      publishCourse: ['Publish race', 'Publicar carrera'],
      courseNoCar: [
        'Drive a little first so the car has a position.',
        'Conduce un poco primero para que el coche tenga posición.',
      ],
      courseTooClose: [
        'That checkpoint is under 100 m from the last one. Drive farther.',
        'Ese control está a menos de 100 m del anterior. Conduce más lejos.',
      ],
      courseFull: [
        'A course can have at most 5 checkpoints.',
        'Un recorrido puede tener como máximo 5 controles.',
      ],
      garage: ['Garage', 'Garaje'],
      leaderboards: ['Leaderboards', 'Clasificaciones'],
      settings: ['Settings', 'Ajustes'],
      balance: ['Balance', 'Saldo'],
      missionsDone: ['missions', 'misiones'],
      loadingProfile: ['Loading player…', 'Cargando jugador…'],
      loadingMissions: ['Finding nearby places…', 'Buscando lugares cercanos…'],
      noMissions: [
        'No road missions found here yet. Try refreshing after the streets load.',
        'Aún no hay misiones aquí. Actualiza cuando carguen las calles.',
      ],
      refreshMissions: ['Refresh missions', 'Actualizar misiones'],
      acceptMission: ['Accept mission', 'Aceptar misión'],
      abandon: ['Abandon mission', 'Abandonar misión'],
      driveToPickup: [
        'Drive to the pickup marker to begin.',
        'Conduce hasta el punto de recogida para comenzar.',
      ],
      missionActive: [
        'Mission underway · drive to the destination.',
        'Misión en curso · conduce al destino.',
      ],
      checkpoints: ['Checkpoints', 'Puntos de control'],
      reward: ['Reward', 'Recompensa'],
      limit: ['Limit', 'Límite'],
      vehicleCondition: ['Vehicle condition', 'Estado del vehículo'],
      respawn: ['Respawn at starting area', 'Reaparecer en el punto inicial'],
      repair: ['Repair', 'Reparar'],
      grip: ['grip', 'agarre'],
      currentVehicle: ['Current vehicle', 'Vehículo actual'],
      drive: ['Drive this vehicle', 'Conducir este vehículo'],
      buy: ['Buy', 'Comprar'],
      chooseRace: ['Choose a race', 'Elige una carrera'],
      createRace: ['Create a street race', 'Crear una carrera'],
      raceStartsHere: [
        'Starts where you are and finishes at the searched destination.',
        'Empieza donde estás y termina en el destino que busques.',
      ],
      raceName: ['Race name', 'Nombre de la carrera'],
      raceDestination: ['Destination', 'Destino'],
      publishRace: ['Publish race', 'Publicar carrera'],
      areaEarnings: ['Area earnings', 'Ganancias del área'],
      noScores: [
        'No scores yet. Finish a mission to appear here.',
        'Aún no hay puntuaciones. Completa una misión para aparecer aquí.',
      ],
      graphics: ['Graphics quality', 'Calidad gráfica'],
      controls: ['Controls', 'Controles'],
      low: ['Low', 'Baja'],
      medium: ['Medium', 'Media'],
      high: ['High', 'Alta'],
      keyboard: ['Keyboard', 'Teclado'],
      touch: ['Touch', 'Táctil'],
      both: ['Both', 'Ambos'],
      language: ['Language', 'Idioma'],
      volume: ['Master volume', 'Volumen general'],
      mute: ['Mute', 'Silenciar'],
      unmute: ['Unmute', 'Activar sonido'],
      delivery: ['Delivery', 'Entrega'],
      taxi: ['Taxi fare', 'Viaje en taxi'],
      'time-trial': ['Time trial', 'Contrarreloj'],
      'checkpoint-race': ['Checkpoint race', 'Carrera con puntos'],
    };
    return words[key]?.[language === 'es' ? 1 : 0] ?? key;
  }
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = '',
  text = '',
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

function requiredElement<T extends HTMLElement>(parent: HTMLElement, selector: string): T {
  const node = parent.querySelector(selector);
  if (!node) throw new Error(`Missing menu element ${selector}`);
  return node as T;
}

function formatMoney(cents: number): string {
  return new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(
    cents / 100,
  );
}

function formatDistance(meters: number): string {
  return meters < 1_000 ? `${Math.round(meters)} m` : `${(meters / 1_000).toFixed(1)} km`;
}
