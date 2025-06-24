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
var import_chai = require("chai");
var import_sinon = __toESM(require("sinon"));
var import_device_scheduler = require("./device-scheduler");
describe("DeviceScheduler", () => {
  let adapterMock;
  let apiMock;
  let scheduler;
  beforeEach(() => {
    adapterMock = {
      log: {
        info: import_sinon.default.stub(),
        warn: import_sinon.default.stub()
      }
    };
    apiMock = {
      sendReading: import_sinon.default.stub().resolves()
    };
    scheduler = new import_device_scheduler.DeviceScheduler(adapterMock, apiMock);
  });
  afterEach(() => {
    scheduler.clear();
    import_sinon.default.restore();
  });
  it("should schedule reading tasks for devices", () => {
    const devices = [
      { deviceId: "id1", sourceState: "state1", sendIntervalHours: 1e-4, allowRounding: true },
      { deviceId: "id2", sourceState: "state2", sendIntervalHours: 1e-4, allowRounding: true }
    ];
    scheduler.schedule(devices);
    (0, import_chai.expect)(apiMock.sendReading.callCount).to.equal(2);
    (0, import_chai.expect)(scheduler.timerCount).to.equal(2);
  });
  it("should skip invalid devices without deviceId or sourceState", () => {
    const devices = [
      { deviceId: "", sourceState: "state1", sendIntervalHours: 1, allowRounding: true },
      { deviceId: "id2", sourceState: "", sendIntervalHours: 1, allowRounding: true }
    ];
    scheduler.schedule(devices);
    (0, import_chai.expect)(apiMock.sendReading.callCount).to.equal(0);
    (0, import_chai.expect)(scheduler.timerCount).to.equal(0);
  });
  it("should clear all timers when clear() is called", () => {
    const devices = [
      { deviceId: "id1", sourceState: "state1", sendIntervalHours: 1, allowRounding: true }
    ];
    scheduler.schedule(devices);
    scheduler.clear();
    (0, import_chai.expect)(scheduler.timerCount).to.equal(0);
  });
});
//# sourceMappingURL=device-scheduler.spec.js.map
