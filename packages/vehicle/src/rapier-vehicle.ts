import RAPIER from '@dimforge/rapier3d-compat';
import type { CarState, LonLat, PlayerInput, Point2, WheelState } from '@openstreet-racer/shared';
import type { ChunkGeometry, TileCell } from '@openstreet-racer/world';
import { lonLatToLocalMeters } from '@openstreet-racer/world';

import { getVehicleDefinition, STARTING_VEHICLE_ID, type VehicleDefinition } from './catalog';

const DEFAULT_WHEEL_REST_LENGTH = 0.24;
const MINIMUM_CHASSIS_START_HEIGHT = 0.78;
// Arcade feel: punchier engine and brakes than the raw catalog values.
const ARCADE_ENGINE_MULTIPLIER = 1.75;
const ARCADE_BRAKE_MULTIPLIER = 1.4;
// Burnout model: a hard launch from near-standstill spins the driven wheels.
const BURNOUT_THROTTLE_THRESHOLD = 0.8;
const BURNOUT_ENTRY_SPEED = 2.5;
const BURNOUT_EXIT_SPEED = 6;
const BURNOUT_MAX_SECONDS = 0.9;
const BURNOUT_REAR_GRIP_FACTOR = 0.45;
// Handbrake drift: locking the rear wheels also unloads their lateral grip.
const HANDBRAKE_REAR_GRIP_FACTOR = 0.22;
const SLIDE_SPEED_REFERENCE = 6;

export interface TractionState {
  /** 0..1 wheelspin intensity while burning out from a standstill. */
  readonly burnout: number;
  /** True while the car is sliding sideways (drift or handbrake slide). */
  readonly sliding: boolean;
  /** 0..1 lateral slip magnitude relative to the car's heading. */
  readonly slipAmount: number;
  /** Extra driven-wheel spin rate in rad/s above rolling (visual smoke/screech cue). */
  readonly wheelSpinRadiansPerSecond: number;
}

const NEUTRAL_TRACTION: TractionState = {
  burnout: 0,
  sliding: false,
  slipAmount: 0,
  wheelSpinRadiansPerSecond: 0,
};

export class RapierVehicle {
  private readonly world: RAPIER.World;
  private readonly ground: RAPIER.RigidBody;
  private chassis: RAPIER.RigidBody;
  private controller: RAPIER.DynamicRayCastVehicleController;
  private readonly chunkBodies = new Map<string, RAPIER.RigidBody>();
  private origin: LonLat;
  private definition: VehicleDefinition;
  private frontWheels: readonly number[] = [];
  private rearWheels: readonly number[] = [];
  private damage = 0;
  private lastImpactAtMs = 0;
  private burnoutElapsed = 0;
  private tractionState: TractionState = NEUTRAL_TRACTION;
  private lastDrivenWheelRotation = 0;

  /** Invoked when the chassis takes a hard collision (impact speed delta in m/s). */
  onImpact: ((impactMetersPerSecond: number) => void) | null = null;

  private constructor(world: RAPIER.World, origin: LonLat, vehicleId: string) {
    this.world = world;
    this.origin = { ...origin };
    this.definition = getVehicleDefinition(vehicleId);
    this.world.timestep = 1 / 60;
    const groundBody = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed());
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(20_000, 0.15, 20_000).setTranslation(0, -0.15, 0).setFriction(1.1),
      groundBody,
    );
    this.ground = groundBody;
    const rig = this.createVehicleRig();
    this.chassis = rig.chassis;
    this.controller = rig.controller;
    this.frontWheels = rig.frontWheels;
    this.rearWheels = rig.rearWheels;
  }

  static async create(origin: LonLat, vehicleId = STARTING_VEHICLE_ID): Promise<RapierVehicle> {
    await RAPIER.init();
    return new RapierVehicle(new RAPIER.World({ x: 0, y: -9.81, z: 0 }), origin, vehicleId);
  }

  step(input: PlayerInput, deltaSeconds: number): CarState {
    const delta = clamp(deltaSeconds, 0, 1 / 30);
    const speed = this.controller.currentVehicleSpeed();
    const damageFactor = 1 - this.damage * 0.0045;
    const steeringFactor = 1 - this.damage * 0.0025;
    const throttle = clamp(input.throttle, 0, 1);
    const brakeInput = clamp(input.brake, 0, 1);
    const handbrake = clamp(input.handbrake, 0, 1);
    let engineForce = 0;
    let braking = 0;

    if (brakeInput > 0) {
      if (speed > 0.45)
        braking = brakeInput * this.definition.handling.brakeForce * ARCADE_BRAKE_MULTIPLIER;
      else
        engineForce =
          -brakeInput * this.definition.handling.engineForce * 0.76 * ARCADE_ENGINE_MULTIPLIER;
    } else if (throttle > 0) {
      if (speed < -0.45)
        braking = throttle * this.definition.handling.brakeForce * 0.7 * ARCADE_BRAKE_MULTIPLIER;
      else
        engineForce =
          throttle * this.definition.handling.engineForce * damageFactor * ARCADE_ENGINE_MULTIPLIER;
    }

    if (speed >= this.definition.handling.maxSpeedMps && engineForce > 0) engineForce = 0;
    if (speed <= -this.definition.handling.maxReverseMps && engineForce < 0) engineForce = 0;

    // Burnout: hard throttle from near-standstill spins the driven wheels and
    // limits initial movement while the tires fight for grip.
    const wantsLaunch =
      brakeInput === 0 &&
      throttle >= BURNOUT_THROTTLE_THRESHOLD &&
      engineForce > 0 &&
      speed > -0.5 &&
      speed < BURNOUT_EXIT_SPEED;
    if (!wantsLaunch) this.burnoutElapsed = 0;
    const burning =
      wantsLaunch &&
      this.burnoutElapsed < BURNOUT_MAX_SECONDS &&
      (this.burnoutElapsed > 0 || speed < BURNOUT_ENTRY_SPEED || handbrake > 0);
    let burnout = 0;
    let rearGripFactor = 1;
    if (burning) {
      this.burnoutElapsed += delta;
      const progress = clamp(this.burnoutElapsed / BURNOUT_MAX_SECONDS, 0, 1);
      burnout = 1 - 0.4 * progress;
      engineForce *= 0.38 + 0.62 * progress;
      rearGripFactor = BURNOUT_REAR_GRIP_FACTOR;
    }
    if (handbrake > 0) {
      // Locked rear wheels lose lateral grip: the car slides and can drift.
      rearGripFactor = Math.min(rearGripFactor, 1 - (1 - HANDBRAKE_REAR_GRIP_FACTOR) * handbrake);
    }

    const grip = this.definition.handling.grip;
    for (const wheel of this.frontWheels) {
      this.controller.setWheelSteering(
        wheel,
        -clamp(input.steer, -1, 1) * this.definition.handling.steeringRadians * steeringFactor,
      );
      this.controller.setWheelEngineForce(wheel, (engineForce / this.frontWheels.length) * 0.3);
      this.controller.setWheelBrake(wheel, braking + handbrake * 450);
      this.controller.setWheelFrictionSlip(wheel, grip);
    }
    for (const wheel of this.rearWheels) {
      this.controller.setWheelSteering(wheel, 0);
      this.controller.setWheelEngineForce(wheel, (engineForce / this.rearWheels.length) * 0.7);
      // During a handbrake burnout the engine fights a softer rear brake so
      // the wheels can actually spin instead of staying locked.
      const rearHandbrake = handbrake * 1_800 * (burning ? 1 - 0.8 * throttle : 1);
      this.controller.setWheelBrake(wheel, braking + rearHandbrake);
      this.controller.setWheelFrictionSlip(wheel, grip * rearGripFactor);
    }
    const speedBeforeStep = Math.hypot(this.chassis.linvel().x, this.chassis.linvel().z);
    this.world.timestep = delta;
    this.controller.updateVehicle(delta);
    this.world.step();
    this.recordImpact(speedBeforeStep);
    this.chassis.wakeUp();
    this.updateTraction(burnout, handbrake, delta);
    return this.snapshot();
  }

  /** Current wheelspin/slide state for smoke, screech, and HUD integration. */
  traction(): TractionState {
    return this.tractionState;
  }

  snapshot(): CarState {
    const translation = this.chassis.translation();
    const velocity = this.chassis.linvel();
    const rotation = this.chassis.rotation();
    const forwardX = 2 * (rotation.x * rotation.z + rotation.w * rotation.y);
    const forwardZ = 1 - 2 * (rotation.x * rotation.x + rotation.y * rotation.y);
    const yaw = Math.atan2(forwardX, forwardZ);
    const headingRadians = normalizeAngle(Math.PI - yaw);
    const speedMetersPerSecond = velocity.x * forwardX + velocity.z * forwardZ;
    return {
      id: 'player',
      vehicleId: this.definition.id,
      damage: this.damage,
      position: { x: translation.x, y: -translation.z },
      velocity: { x: velocity.x, y: -velocity.z },
      altitudeMeters: translation.y,
      verticalVelocityMetersPerSecond: velocity.y,
      wheels: this.readWheelStates(),
      headingRadians,
      speedMetersPerSecond,
    };
  }

  switchVehicle(vehicleId: string): CarState {
    const nextDefinition = getVehicleDefinition(vehicleId);
    if (nextDefinition.id === this.definition.id) return this.snapshot();
    const previous = this.snapshot();
    this.world.removeVehicleController(this.controller);
    this.world.removeRigidBody(this.chassis);
    this.definition = nextDefinition;
    this.burnoutElapsed = 0;
    this.tractionState = NEUTRAL_TRACTION;
    this.lastDrivenWheelRotation = 0;
    const rig = this.createVehicleRig();
    this.chassis = rig.chassis;
    this.controller = rig.controller;
    this.frontWheels = rig.frontWheels;
    this.rearWheels = rig.rearWheels;
    this.placeAt(previous.position, previous.headingRadians);
    return this.snapshot();
  }

  setDamage(value: number): void {
    this.damage = clamp(value, 0, 100);
  }

  repair(): CarState {
    this.damage = 0;
    return this.snapshot();
  }

  placeAt(position: Point2, headingRadians: number): void {
    const yaw = Math.PI - headingRadians;
    this.chassis.setTranslation({ x: position.x, y: this.startHeight(), z: -position.y }, true);
    this.chassis.setRotation({ x: 0, y: Math.sin(yaw / 2), z: 0, w: Math.cos(yaw / 2) }, true);
    this.chassis.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.setAngvel({ x: 0, y: 0, z: 0 }, true);
    this.chassis.wakeUp();
  }

  addChunk(cell: TileCell, geometry: ChunkGeometry): void {
    this.removeChunk(cell.key);
    if (geometry.buildings.indices.length < 3) return;
    const offset = lonLatToLocalMeters(cell.center, this.origin);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.fixed().setTranslation(offset.x, 0, -offset.y),
    );
    const collider = RAPIER.ColliderDesc.trimesh(
      geometry.buildings.positions,
      geometry.buildings.indices,
    )
      .setFriction(0.65)
      .setRestitution(0.02);
    this.world.createCollider(collider, body);
    this.chunkBodies.set(cell.key, body);
  }

  removeChunk(key: string): void {
    const body = this.chunkBodies.get(key);
    if (!body) return;
    this.world.removeRigidBody(body);
    this.chunkBodies.delete(key);
  }

  shiftOrigin(shift: Point2, nextOrigin: LonLat): void {
    this.world.bodies.forEach((body) => {
      if (body === this.ground) return;
      const current = body.translation();
      body.setTranslation({ x: current.x - shift.x, y: current.y, z: current.z + shift.y }, true);
    });
    this.origin = { ...nextOrigin };
  }

  reset(origin: LonLat): void {
    for (const key of this.chunkBodies.keys()) this.removeChunk(key);
    this.origin = { ...origin };
    this.burnoutElapsed = 0;
    this.tractionState = NEUTRAL_TRACTION;
    this.lastDrivenWheelRotation = 0;
    this.placeAt({ x: 0, y: 0 }, 0);
    for (let wheel = 0; wheel < this.controller.numWheels(); wheel += 1) {
      this.controller.setWheelEngineForce(wheel, 0);
      this.controller.setWheelBrake(wheel, 0);
      this.controller.setWheelSteering(wheel, 0);
    }
  }

  private createVehicleRig(): {
    chassis: RAPIER.RigidBody;
    controller: RAPIER.DynamicRayCastVehicleController;
    frontWheels: number[];
    rearWheels: number[];
  } {
    const { dimensions, handling, visual } = this.definition;
    const chassis = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(0, this.startHeight(), 0)
        .setRotation({ x: 0, y: 1, z: 0, w: 0 })
        .setAdditionalMass(handling.massKg)
        .setLinearDamping(0.08)
        .setAngularDamping(1.4)
        .lockRotations(),
    );
    chassis.setEnabledRotations(false, true, false, true);
    chassis.enableCcd(true);
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(
        dimensions.width * 0.5,
        Math.max(0.24, dimensions.height * 0.27),
        dimensions.length * 0.5,
      ).setFriction(0.7),
      chassis,
    );
    const controller = this.world.createVehicleController(chassis);
    const frontWheels: number[] = [];
    const rearWheels: number[] = [];
    const wheelPairs =
      visual === 'motorbike'
        ? [
            { x: 0, z: dimensions.wheelbase * 0.5, axle: frontWheels },
            { x: 0, z: -dimensions.wheelbase * 0.5, axle: rearWheels },
          ]
        : [
            { x: -dimensions.track * 0.5, z: dimensions.wheelbase * 0.5, axle: frontWheels },
            { x: dimensions.track * 0.5, z: dimensions.wheelbase * 0.5, axle: frontWheels },
            { x: -dimensions.track * 0.5, z: -dimensions.wheelbase * 0.5, axle: rearWheels },
            { x: dimensions.track * 0.5, z: -dimensions.wheelbase * 0.5, axle: rearWheels },
          ];
    const wheelRestLength =
      DEFAULT_WHEEL_REST_LENGTH * Math.max(0.6, dimensions.wheelRadius / 0.36);
    for (const wheel of wheelPairs) {
      const index = controller.numWheels();
      controller.addWheel(
        { x: wheel.x, y: -dimensions.height * 0.14, z: wheel.z },
        { x: 0, y: -1, z: 0 },
        { x: -1, y: 0, z: 0 },
        wheelRestLength,
        dimensions.wheelRadius,
      );
      wheel.axle.push(index);
      controller.setWheelSuspensionStiffness(index, handling.suspensionStiffness);
      controller.setWheelSuspensionCompression(index, 5.2);
      controller.setWheelSuspensionRelaxation(index, 3.8);
      controller.setWheelMaxSuspensionTravel(index, 0.32);
      controller.setWheelMaxSuspensionForce(index, handling.massKg * 9.5);
      controller.setWheelFrictionSlip(index, handling.grip);
      controller.setWheelSideFrictionStiffness(index, 1.4);
    }
    return { chassis, controller, frontWheels, rearWheels };
  }

  private updateTraction(burnout: number, handbrake: number, delta: number): void {
    const velocity = this.chassis.linvel();
    const rotation = this.chassis.rotation();
    const forwardX = 2 * (rotation.x * rotation.z + rotation.w * rotation.y);
    const forwardZ = 1 - 2 * (rotation.x * rotation.x + rotation.y * rotation.y);
    const forwardSpeed = velocity.x * forwardX + velocity.z * forwardZ;
    const lateralSpeed = velocity.x * forwardZ - velocity.z * forwardX;
    const slipAmount = clamp(Math.abs(lateralSpeed) / SLIDE_SPEED_REFERENCE, 0, 1);
    const groundSpeed = Math.hypot(velocity.x, velocity.z);
    const sliding = (slipAmount > 0.3 && groundSpeed > 2) || (handbrake > 0.4 && groundSpeed > 2.5);
    let wheelSpinRadiansPerSecond = 0;
    const drivenWheel = this.rearWheels[0];
    if (drivenWheel !== undefined && delta > 0) {
      const rotationNow = this.controller.wheelRotation(drivenWheel) ?? 0;
      const rollingRate = Math.abs(forwardSpeed) / this.definition.dimensions.wheelRadius;
      const rawRate = Math.abs((rotationNow - this.lastDrivenWheelRotation) / delta);
      wheelSpinRadiansPerSecond = Math.max(0, rawRate - rollingRate);
      this.lastDrivenWheelRotation = rotationNow;
    }
    // The raycast wheels visually roll with the chassis, so model the extra
    // slip spin of a burnout explicitly for smoke/screech integration.
    wheelSpinRadiansPerSecond = Math.max(wheelSpinRadiansPerSecond, burnout * 45);
    this.tractionState = {
      burnout,
      sliding,
      slipAmount,
      wheelSpinRadiansPerSecond: clamp(wheelSpinRadiansPerSecond, 0, 400),
    };
  }

  private recordImpact(speedBeforeStep: number): void {
    const velocity = this.chassis.linvel();
    const speedAfterStep = Math.hypot(velocity.x, velocity.z);
    const impact = speedBeforeStep - speedAfterStep;
    const timestamp = Date.now();
    if (speedBeforeStep < 7 || impact < 3.2 || timestamp - this.lastImpactAtMs < 1_200) return;
    this.damage = Math.min(100, this.damage + clamp((impact - 2.4) * 2.2, 4, 22));
    this.lastImpactAtMs = timestamp;
    this.onImpact?.(impact);
  }

  private startHeight(): number {
    return Math.max(MINIMUM_CHASSIS_START_HEIGHT, this.definition.dimensions.height * 0.68);
  }

  private readWheelStates(): WheelState[] {
    return Array.from({ length: this.controller.numWheels() }, (_, index) => {
      const connection = this.controller.wheelChassisConnectionPointCs(index);
      return {
        position: {
          x: connection?.x ?? 0,
          y:
            (connection?.y ?? -0.16) -
            (this.controller.wheelSuspensionLength(index) ?? DEFAULT_WHEEL_REST_LENGTH),
          z: connection?.z ?? 0,
        },
        rotationRadians: this.controller.wheelRotation(index) ?? 0,
        steeringRadians: this.controller.wheelSteering(index) ?? 0,
      };
    });
  }

  get chunkCount(): number {
    return this.chunkBodies.size;
  }

  dispose(): void {
    this.world.free();
    this.chunkBodies.clear();
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(minimum, Math.min(maximum, value)) : 0;
}

function normalizeAngle(value: number): number {
  const fullTurn = 2 * Math.PI;
  return ((value % fullTurn) + fullTurn) % fullTurn;
}
