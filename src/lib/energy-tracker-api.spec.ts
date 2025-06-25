import { expect } from "chai";
import chai from "chai";
import sinonChai from "sinon-chai";
import sinon from "sinon";
import axios from "axios";
import { assert } from "chai";
import { EnergyTrackerApi } from "./energy-tracker-api";

chai.use(sinonChai);

describe("EnergyTrackerApi", () => {
  let adapterMock: sinon.SinonStubbedInstance<ioBroker.Adapter>;
  let axiosPostStub: sinon.SinonStub;
  let api: EnergyTrackerApi;

  beforeEach(() => {
    adapterMock = {
      getForeignStateAsync: sinon.stub(),
      setState: sinon.stub().resolves(),
      config: {
        bearerToken: "test-token",
      },
      log: {
        info: sinon.stub(),
        warn: sinon.stub(),
        error: sinon.stub(),
      },
    } as unknown as sinon.SinonStubbedInstance<ioBroker.Adapter>;

    axiosPostStub = sinon.stub(axios, "post");
    api = new EnergyTrackerApi(adapterMock);
  });

  afterEach(() => {
    sinon.restore();
  });

  it("should send a valid reading (allowRounding=false)", async () => {
    // Arrange
    const device = {
      deviceId: "abc123",
      sourceState: "test.state",
      allowRounding: false,
    } satisfies ioBroker.AdapterDevice;
    adapterMock.getForeignStateAsync.resolves({
      val: 123.456,
      ack: true,
      ts: Date.now(),
      lc: Date.now(),
      from: "system.adapter.test",
    });

    // Act
    await api.sendReading(device);

    // Assert
    assert.isTrue(axiosPostStub.calledOnce);
    const [url, body, config] = axiosPostStub.firstCall.args;
    expect(url).to.include("/v1/devices/abc123/meter-readings");
    expect(body).to.deep.equal({ value: 123.456 });
    expect(config.headers.Authorization).to.equal("Bearer test-token");
    expect(config.params).to.deep.equal({});
    expect(adapterMock.log.info).to.have.been.calledWithMatch("[test.state] Reading sent: 123.456");
  });

  it("should include allowRounding=true when enabled", async () => {
    // Arrange
    const device = {
      deviceId: "round1",
      sourceState: "round.state",
      allowRounding: true,
    } satisfies ioBroker.AdapterDevice;
    adapterMock.getForeignStateAsync.resolves({
      val: 123.789,
      ack: true,
      ts: Date.now(),
      lc: Date.now(),
      from: "system.adapter.test",
    });

    // Act
    await api.sendReading(device);

    // Assert
    expect(axiosPostStub.firstCall.args[2].params).to.deep.equal({ allowRounding: true });
  });

  it("should warn on invalid state value", async () => {
    // Arrange
    const device = {
      deviceId: "invalid1",
      sourceState: "missing.state",
      allowRounding: false,
    } satisfies ioBroker.AdapterDevice;
    adapterMock.getForeignStateAsync.resolves({
      val: "not-a-number",
      ack: true,
      ts: 1,
      lc: 1,
      from: "system.adapter.test",
    });

    // Act
    await api.sendReading(device);

    // Assert
    expect(adapterMock.log.warn).to.have.been.calledWithMatch("Invalid or missing state");
    assert.isFalse(axiosPostStub.called);
  });

  it("should handle 400 Bad Request gracefully", async () => {
    // Arrange
    const device = {
      deviceId: "fail400",
      sourceState: "error.state",
      allowRounding: false,
    } satisfies ioBroker.AdapterDevice;
    adapterMock.getForeignStateAsync.resolves({
      val: 1,
      ack: true,
      ts: Date.now(),
      lc: Date.now(),
      from: "system.adapter.test",
    });

    axiosPostStub.rejects({
      isAxiosError: true,
      response: {
        status: 400,
        data: { message: "Test bad request" },
      },
    });

    // Act
    await api.sendReading(device);

    // Assert
    expect(adapterMock.log.warn).to.have.been.calledWithMatch(
      "[error.state] Bad Request: Test bad request"
    );
  });
});
