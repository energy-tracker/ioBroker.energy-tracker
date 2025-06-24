import { EnergyTrackerApi } from "./energy-tracker-api";

export class DeviceScheduler {
  get timerCount(): number {
    return this.timers.size;
  }

  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly adapter: ioBroker.Adapter,
    private readonly api: EnergyTrackerApi
  ) {}

  public schedule(devices: ioBroker.AdapterDevice[]): void {
    for (const device of devices) {
      if (!device.deviceId || !device.sourceState || !device.sendIntervalHours) {
        this.adapter.log.warn(`[${device.sourceState}] Device config incomplete – skipping.`);
        continue;
      }

      const logPrefix = `[${device.sourceState}]`;
      const intervalMs = device.sendIntervalHours * 60 * 60 * 1000;

      this.adapter.log.info(`[${logPrefix}] Scheduling reading every ${device.sendIntervalHours}h`);

      const send = (): Promise<void> => this.api.sendReading(device);
      send();
      const timer = setInterval(send, intervalMs);
      this.timers.set(device.deviceId, timer);
    }
  }

  public clear(): void {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}
