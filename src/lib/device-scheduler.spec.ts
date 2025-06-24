import { expect } from "chai";
import sinon from "sinon";
import { DeviceScheduler } from "./device-scheduler";
import { EnergyTrackerApi } from "./energy-tracker-api";

describe("DeviceScheduler", () => {
  let adapterMock: sinon.SinonStubbedInstance<ioBroker.Adapter>;
  let apiMock: sinon.SinonStubbedInstance<EnergyTrackerApi>;
  let scheduler: DeviceScheduler;

  beforeEach(() => {
    adapterMock = {
      log: {
        info: sinon.stub(),
        warn: sinon.stub(),
      },
    } as unknown as sinon.SinonStubbedInstance<ioBroker.Adapter>;

    apiMock = {
      sendReading: sinon.stub().resolves(),
    } as unknown as sinon.SinonStubbedInstance<EnergyTrackerApi>;

    scheduler = new DeviceScheduler(adapterMock, apiMock);
  });

  afterEach(() => {
    scheduler.clear();
    sinon.restore();
  });

  it("should schedule reading tasks for devices", () => {
    // Arrange
    const devices = [
      { deviceId: "id1", sourceState: "state1", sendIntervalHours: 0.0001, allowRounding: true },
      { deviceId: "id2", sourceState: "state2", sendIntervalHours: 0.0001, allowRounding: true },
    ] satisfies ioBroker.AdapterDevice[];

    // Act
    scheduler.schedule(devices);

    // Assert
    expect((apiMock.sendReading as sinon.SinonStub).callCount).to.equal(2);
    expect(scheduler.timerCount).to.equal(2);
  });

  it("should skip invalid devices without deviceId or sourceState", () => {
    // Arrange
    const devices = [
      { deviceId: "", sourceState: "state1", sendIntervalHours: 1, allowRounding: true },
      { deviceId: "id2", sourceState: "", sendIntervalHours: 1, allowRounding: true },
    ] satisfies ioBroker.AdapterDevice[];

    // Act
    scheduler.schedule(devices);

    // Assert
    expect((apiMock.sendReading as sinon.SinonStub).callCount).to.equal(0);
    expect(scheduler.timerCount).to.equal(0);
  });

  it("should clear all timers when clear() is called", () => {
    // Arrange
    const devices = [
      { deviceId: "id1", sourceState: "state1", sendIntervalHours: 1, allowRounding: true },
    ] satisfies ioBroker.AdapterDevice[];
    scheduler.schedule(devices);

    // Act
    scheduler.clear();

    // Assert
    expect(scheduler.timerCount).to.equal(0);
  });
});
