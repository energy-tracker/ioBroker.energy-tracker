"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
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
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var energy_tracker_api_exports = {};
__export(energy_tracker_api_exports, {
  EnergyTrackerApi: () => EnergyTrackerApi
});
module.exports = __toCommonJS(energy_tracker_api_exports);
var import_axios = __toESM(require("axios"));
class EnergyTrackerApi {
  constructor(adapter) {
    this.adapter = adapter;
  }
  baseUrl = "https://public-api.energy-tracker.best-ios-apps.de";
  async sendReading(device) {
    const logPrefix = `[${device.sourceState}]`;
    try {
      const state = await this.adapter.getForeignStateAsync(device.sourceState);
      if (!state || typeof state.val !== "number") {
        this.adapter.log.warn(`Invalid or missing state for ${device.sourceState}`);
        return;
      }
      const body = { value: state.val };
      await import_axios.default.post(`${this.baseUrl}/v1/devices/${device.deviceId}/meter-readings`, body, {
        headers: {
          Authorization: `Bearer ${this.adapter.config.bearerToken}`,
          "Content-Type": "application/json"
        },
        params: device.allowRounding ? { allowRounding: true } : {}
      });
      this.adapter.log.info(`${logPrefix} Reading sent: ${state.val}`);
      await this.adapter.setState("info.connection", { val: true, ack: true });
    } catch (err) {
      await this.adapter.setState("info.connection", { val: false, ack: true });
      this.handleError(logPrefix, err);
    }
  }
  handleError(logPrefix, err) {
    var _a, _b, _c, _d, _e, _f;
    if (!import_axios.default.isAxiosError(err)) {
      this.adapter.log.error(`${logPrefix} Unexpected error: ${err}`);
      return;
    }
    const { status, data } = (_a = err.response) != null ? _a : {};
    if (status === void 0) {
      this.adapter.log.error(`${logPrefix} Network error: ${err.message}`);
      return;
    }
    switch (status) {
      case 400:
        this.adapter.log.warn(`${logPrefix} Bad Request: ${(_b = data == null ? void 0 : data.message) != null ? _b : "Invalid input"}`);
        break;
      case 401:
        this.adapter.log.warn(`${logPrefix} Unauthorized: Check your access token`);
        break;
      case 403:
        this.adapter.log.warn(`${logPrefix} Forbidden: Insufficient permissions`);
        break;
      case 429:
        const retryAfter = (_d = (_c = err.response) == null ? void 0 : _c.headers) == null ? void 0 : _d["retry-after"];
        const retryAfterSec = Number(retryAfter);
        let msg = `${logPrefix} Too many requests: Rate limit exceeded`;
        if (retryAfter && !isNaN(retryAfterSec)) {
          msg += ` \u2013 Retry after ${retryAfter} seconds.`;
        }
        this.adapter.log.warn(msg);
        break;
      default:
        if (status >= 500 && status <= 599) {
          this.adapter.log.warn(
            `${logPrefix} Server error ${status}: ${(_e = data == null ? void 0 : data.message) != null ? _e : "Internal server error"}`
          );
        } else {
          this.adapter.log.warn(
            `${logPrefix} Unexpected HTTP ${status}: ${(_f = data == null ? void 0 : data.message) != null ? _f : "Unknown error"}`
          );
        }
    }
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  EnergyTrackerApi
});
//# sourceMappingURL=energy-tracker-api.js.map
