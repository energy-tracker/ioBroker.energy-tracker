"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var device_scheduler_exports = {};
__export(device_scheduler_exports, {
  DeviceScheduler: () => DeviceScheduler
});
module.exports = __toCommonJS(device_scheduler_exports);
class DeviceScheduler {
  constructor(adapter, api) {
    this.adapter = adapter;
    this.api = api;
  }
  get timerCount() {
    return this.timers.size;
  }
  timers = /* @__PURE__ */ new Map();
  schedule(devices) {
    for (const device of devices) {
      if (!device.deviceId || !device.sourceState || !device.sendIntervalHours) {
        this.adapter.log.warn(`[${device.sourceState}] Device config incomplete \u2013 skipping.`);
        continue;
      }
      const logPrefix = `[${device.sourceState}]`;
      const intervalMs = device.sendIntervalHours * 60 * 60 * 1e3;
      this.adapter.log.info(`[${logPrefix}] Scheduling reading every ${device.sendIntervalHours}h`);
      const send = () => this.api.sendReading(device);
      send();
      const timer = setInterval(send, intervalMs);
      this.timers.set(device.deviceId, timer);
    }
  }
  clear() {
    for (const timer of this.timers.values()) {
      clearInterval(timer);
    }
    this.timers.clear();
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  DeviceScheduler
});
//# sourceMappingURL=device-scheduler.js.map
