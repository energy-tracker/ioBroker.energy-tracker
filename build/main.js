"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var utils = __toESM(require("@iobroker/adapter-core"));
var import_energy_tracker_api = require("./lib/energy-tracker-api");
var import_device_scheduler = require("./lib/device-scheduler");
class EnergyTracker extends utils.Adapter {
  api;
  scheduler;
  constructor(options = {}) {
    super({
      ...options,
      name: "energy-tracker"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
  }
  async onReady() {
    this.api = new import_energy_tracker_api.EnergyTrackerApi(this);
    this.scheduler = new import_device_scheduler.DeviceScheduler(this, this.api);
    await this.setState("info.connection", { val: false, ack: true });
    if (!this.config.bearerToken) {
      this.log.warn("Missing bearer token in adapter configuration \u2013 skipping adapter start.");
      return;
    }
    if (!Array.isArray(this.config.devices) || this.config.devices.length === 0) {
      this.log.warn("No devices configured in adapter settings \u2013 skipping adapter start.");
      return;
    }
    this.scheduler.schedule(this.config.devices);
    await this.setState("info.connection", { val: true, ack: true });
  }
  onUnload(callback) {
    this.scheduler.clear();
    callback();
  }
}
if (require.main !== module) {
  module.exports = (options) => new EnergyTracker(options);
} else {
  (() => new EnergyTracker())();
}
//# sourceMappingURL=main.js.map
