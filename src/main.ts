import * as utils from "@iobroker/adapter-core";
import { EnergyTrackerApi } from "./lib/energy-tracker-api";
import { DeviceScheduler } from "./lib/device-scheduler";

class EnergyTracker extends utils.Adapter {
  private api!: EnergyTrackerApi;
  private scheduler!: DeviceScheduler;

  constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "energy-tracker",
    });

    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }

  private async onReady(): Promise<void> {
    this.api = new EnergyTrackerApi(this);
    this.scheduler = new DeviceScheduler(this, this.api);

    await this.setState("info.connection", { val: false, ack: true });

    if (!this.config.bearerToken) {
      this.log.warn("Missing bearer token in adapter configuration.");
    }
    if (!Array.isArray(this.config.devices) || this.config.devices.length === 0) {
      this.log.warn("No devices configured in adapter settings.");
      return;
    }

    this.scheduler.schedule(this.config.devices);

    await this.setState("info.connection", { val: true, ack: true });
  }

  private onUnload(callback: () => void): void {
    this.scheduler.clear();
    callback();
  }
}

if (require.main !== module) {
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) =>
    new EnergyTracker(options);
} else {
  (() => new EnergyTracker())();
}
