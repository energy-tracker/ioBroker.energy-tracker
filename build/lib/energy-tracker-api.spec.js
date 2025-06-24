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
var import_chai2 = __toESM(require("chai"));
var import_sinon_chai = __toESM(require("sinon-chai"));
var import_sinon = __toESM(require("sinon"));
var import_axios = __toESM(require("axios"));
var import_energy_tracker_api = require("./energy-tracker-api");
import_chai2.default.use(import_sinon_chai.default);
describe("EnergyTrackerApi", () => {
  let adapterMock;
  let axiosPostStub;
  let api;
  beforeEach(() => {
    adapterMock = {
      getForeignStateAsync: import_sinon.default.stub(),
      setState: import_sinon.default.stub().resolves(),
      config: {
        bearerToken: "test-token"
      },
      log: {
        info: import_sinon.default.stub(),
        warn: import_sinon.default.stub(),
        error: import_sinon.default.stub()
      }
    };
    axiosPostStub = import_sinon.default.stub(import_axios.default, "post");
    api = new import_energy_tracker_api.EnergyTrackerApi(adapterMock);
  });
  afterEach(() => {
    import_sinon.default.restore();
  });
  it("should send a valid reading (allowRounding=false)", async () => {
    const device = {
      deviceId: "abc123",
      sourceState: "test.state",
      allowRounding: false
    };
    adapterMock.getForeignStateAsync.resolves({
      val: 123.456,
      ack: true,
      ts: Date.now(),
      lc: Date.now(),
      from: "system.adapter.test"
    });
    await api.sendReading(device);
    (0, import_chai.expect)(axiosPostStub.calledOnce).to.be.true;
    const [url, body, config] = axiosPostStub.firstCall.args;
    (0, import_chai.expect)(url).to.include("/v1/devices/abc123/meter-readings");
    (0, import_chai.expect)(body).to.deep.equal({ value: 123.456 });
    (0, import_chai.expect)(config.headers.Authorization).to.equal("Bearer test-token");
    (0, import_chai.expect)(config.params).to.deep.equal({});
    (0, import_chai.expect)(adapterMock.log.info).to.have.been.calledWithMatch("[test.state] Reading sent: 123.456");
  });
  it("should include allowRounding=true when enabled", async () => {
    const device = {
      deviceId: "round1",
      sourceState: "round.state",
      allowRounding: true
    };
    adapterMock.getForeignStateAsync.resolves({
      val: 123.789,
      ack: true,
      ts: Date.now(),
      lc: Date.now(),
      from: "system.adapter.test"
    });
    await api.sendReading(device);
    (0, import_chai.expect)(axiosPostStub.firstCall.args[2].params).to.deep.equal({ allowRounding: true });
  });
  it("should warn on invalid state value", async () => {
    const device = {
      deviceId: "invalid1",
      sourceState: "missing.state",
      allowRounding: false
    };
    adapterMock.getForeignStateAsync.resolves({
      val: "not-a-number",
      ack: true,
      ts: 1,
      lc: 1,
      from: "system.adapter.test"
    });
    await api.sendReading(device);
    (0, import_chai.expect)(adapterMock.log.warn).calledWithMatch("Invalid or missing state");
    (0, import_chai.expect)(axiosPostStub.called).to.be.false;
  });
  it("should handle 400 Bad Request gracefully", async () => {
    const device = {
      deviceId: "fail400",
      sourceState: "error.state",
      allowRounding: false
    };
    adapterMock.getForeignStateAsync.resolves({
      val: 1,
      ack: true,
      ts: Date.now(),
      lc: Date.now(),
      from: "system.adapter.test"
    });
    axiosPostStub.rejects({
      isAxiosError: true,
      response: {
        status: 400,
        data: { message: "Test bad request" }
      }
    });
    await api.sendReading(device);
    (0, import_chai.expect)(adapterMock.log.warn).to.have.been.calledWithMatch(
      "[error.state] Bad Request: Test bad request"
    );
  });
});
//# sourceMappingURL=energy-tracker-api.spec.js.map
