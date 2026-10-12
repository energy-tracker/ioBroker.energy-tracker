import { expect } from 'chai';
import sinon from 'sinon';
import 'sinon-chai';
import { EnergyTrackerClient } from '@energy-tracker/api-client';
import { DataReader } from '../src/lib/data-reader';
import type { RequestBudget } from '../src/lib/request-budget';

const device: ioBroker.AdapterReadDevice = {
    deviceId: 'deadbeef-dead-beef-dead-beefdeadbeef',
    unit: 'kWh',
    extrapolationInterval: 'month',
};
const readOptions = { timeZone: '' };
const extrapolation = [
    {
        date: '2026-09-30T22:00:00Z',
        actualValue: 150,
        actualDuration: 864_000,
        expectedValue: 465,
        expectedDuration: 2_678_400,
    },
];

describe('Data retrieval', () => {
    let adapter: sinon.SinonStubbedInstance<ioBroker.Adapter>;
    let fetchMock: sinon.SinonStub;
    let reader: DataReader;
    let budget: { available: boolean; acquire: sinon.SinonStub; defer: sinon.SinonStub };
    let states: Map<string, ioBroker.StateValue>;

    beforeEach(() => {
        states = new Map();
        adapter = {
            namespace: 'energy-tracker.0',
            setObjectNotExistsAsync: sinon.stub().resolves(),
            extendObjectAsync: sinon.stub().resolves(),
            getDevicesAsync: sinon.stub().resolves([]),
            delObjectAsync: sinon.stub().resolves(),
            setStateAsync: sinon.stub().callsFake((id: string, state: ioBroker.SettableState) => {
                states.set(id, state.val ?? null);
                return Promise.resolve(id);
            }),
            log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
        } as unknown as sinon.SinonStubbedInstance<ioBroker.Adapter>;
        fetchMock = sinon.stub().callsFake(() => Promise.resolve(Response.json(extrapolation)));
        budget = {
            available: true,
            acquire: sinon.stub().resolves(),
            defer: sinon.stub().callsFake(() => {
                budget.available = false;
                return Promise.resolve();
            }),
        };
        reader = new DataReader(
            adapter,
            new EnergyTrackerClient({ accessToken: 'test-token', fetch: fetchMock }),
            budget as unknown as RequestBudget,
        );
    });
    afterEach(() => sinon.restore());

    it('retrieves only extrapolations through the SDK with an optional time zone', async () => {
        // Arrange
        const clock = sinon.useFakeTimers({ now: Date.UTC(2026, 9, 12, 12, 30), toFake: ['Date'] });
        const options = { ...readOptions, timeZone: 'Europe/Berlin' };

        // Act
        const result = await reader.read(device, options);

        // Assert
        expect(result).to.equal(true);
        expect(fetchMock).to.have.been.calledOnce;
        expect(fetchMock.firstCall.args[1].method).to.equal('GET');
        const url = new URL(String(fetchMock.firstCall.args[0]));
        expect(url.pathname).to.equal(`/v1/devices/standard/${device.deviceId}/extrapolations/standard/month`);
        expect(url.searchParams.get('timeZone')).to.equal('Europe/Berlin');
        expect(url.searchParams.has('from')).to.equal(false);
        expect(url.searchParams.get('to')).to.equal('2027-01-12T12:30:00.000Z');
        expect(clock.now).to.equal(Date.UTC(2026, 9, 12, 12, 30));
    });

    it('exposes only read-only calculated states', async () => {
        // Arrange: reader and adapter are initialized in beforeEach.

        // Act
        await reader.read(device, readOptions);

        // Assert
        expect(new URL(String(fetchMock.firstCall.args[0])).searchParams.has('timeZone')).to.equal(false);
        expect(adapter.extendObjectAsync.callCount).to.be.greaterThan(0);
        for (const call of adapter.extendObjectAsync.getCalls()) {
            expect((call.args[1].common as ioBroker.StateCommon).read).to.equal(true);
            expect((call.args[1].common as ioBroker.StateCommon).write).to.equal(false);
        }
        for (const call of adapter.setStateAsync.getCalls()) {
            expect((call.args[1] as ioBroker.SettableState).ack).to.equal(true);
        }
    });

    it('uses the full-period estimate without adding actual consumption', async () => {
        // Arrange
        const prefix = `devices.${device.deviceId}.extrapolation`;

        // Act
        await reader.read(device, readOptions);

        // Assert
        expect(states.get(`${prefix}.actualValue`)).to.equal(150);
        expect(states.get(`${prefix}.expectedValue`)).to.equal(465);
        expect(states.get(`${prefix}.interval`)).to.equal('month');
    });

    it('selects the latest forecast-only period instead of an older reading-backed period', async () => {
        // Arrange
        const selected = device;
        const prefix = `devices.${device.deviceId}.extrapolation`;
        const forecast = {
            date: '2026-10-31T23:00:00Z',
            actualValue: 0,
            actualDuration: 0,
            expectedValue: 450,
            expectedDuration: 2_592_000,
        };
        const terminal = {
            date: '2026-11-30T23:00:00Z',
            actualValue: 0,
            actualDuration: 0,
            expectedValue: 0,
            expectedDuration: 0,
        };
        fetchMock.callsFake(() => Promise.resolve(Response.json([...extrapolation, forecast, terminal])));

        // Act
        const result = await reader.read(selected, readOptions);

        // Assert
        expect(result).to.equal(true);
        expect(states.get(`${prefix}.date`)).to.equal('2026-10-31T23:00:00.000Z');
        expect(states.get(`${prefix}.actualDuration`)).to.equal(0);
        expect(states.get(`${prefix}.expectedValue`)).to.equal(450);
        expect(states.get(`${prefix}.expectedDuration`)).to.equal(2_592_000);
        expect(JSON.parse(states.get(`${prefix}.json`) as string)).to.have.length(3);
    });

    it('represents insufficient history with empty JSON and null values, not a zero consumption', async () => {
        // Arrange
        fetchMock.callsFake(() => Promise.resolve(Response.json([])));
        const prefix = `devices.${device.deviceId}`;

        // Act
        const result = await reader.read(device, readOptions);

        // Assert
        expect(result).to.equal(true);
        expect(states.get(`${prefix}.extrapolation.json`)).to.equal('[]');
        expect(states.get(`${prefix}.extrapolation.actualValue`)).to.equal(null);
        expect(states.get(`${prefix}.extrapolation.available`)).to.equal(true);
    });

    it('retrieves only extrapolations with all history and the per-device interval', async () => {
        // Arrange
        sinon.useFakeTimers({ now: Date.UTC(2026, 9, 12, 12, 30), toFake: ['Date'] });
        const selected: ioBroker.AdapterReadDevice = {
            ...device,
            extrapolationInterval: 'quarter',
            forecastPeriods: 2,
        };

        // Act
        const result = await reader.read(selected, readOptions);

        // Assert
        expect(result).to.equal(true);
        expect(fetchMock).to.have.been.calledOnce;
        const url = new URL(String(fetchMock.firstCall.args[0]));
        expect(url.pathname).to.equal(`/v1/devices/standard/${device.deviceId}/extrapolations/standard/quarter`);
        expect(url.searchParams.has('from')).to.equal(false);
        expect(url.searchParams.get('to')).to.equal('2027-04-12T12:30:00.000Z');
        expect(adapter.extendObjectAsync.getCalls().some(call => call.args[0].includes('.dailyValues.'))).to.equal(
            false,
        );
    });

    it('marks failed requests unavailable and retains the last successful value and timestamp', async () => {
        // Arrange
        const selected = device;
        await reader.read(selected, readOptions);
        const prefix = `devices.${device.deviceId}.extrapolation`;
        const lastUpdated = states.get(`${prefix}.lastUpdated`);
        fetchMock.callsFake(() => Promise.resolve(new Response('{}', { status: 503 })));

        // Act
        const result = await reader.read(selected, readOptions);

        // Assert
        expect(result).to.equal(false);
        expect(states.get(`${prefix}.available`)).to.equal(false);
        expect(states.get(`${prefix}.actualValue`)).to.equal(150);
        expect(states.get(`${prefix}.lastUpdated`)).to.equal(lastUpdated);
    });

    for (const recovering of [false, true]) {
        it(`publishes complete, available data before lastUpdated (recovering: ${recovering})`, async () => {
            // Arrange
            const selected = device;
            const prefix = `devices.${device.deviceId}.extrapolation`;
            states.set(`${prefix}.available`, false);
            if (recovering) {
                fetchMock.callsFake(() => Promise.resolve(new Response('{}', { status: 503 })));
                await reader.read(selected, readOptions);
                fetchMock.callsFake(() => Promise.resolve(Response.json(extrapolation)));
            }
            const observations: {
                available: ioBroker.StateValue | undefined;
                value: ioBroker.StateValue | undefined;
            }[] = [];
            adapter.setStateAsync.callsFake((id, state) => {
                if (!state || typeof state !== 'object' || !('val' in state)) {
                    throw new Error('Expected an acknowledged state update');
                }
                if (id === `${prefix}.lastUpdated`) {
                    observations.push({
                        available: states.get(`${prefix}.available`),
                        value: states.get(`${prefix}.actualValue`),
                    });
                }
                states.set(id, state.val ?? null);
                return Promise.resolve(id);
            });

            // Act
            const result = await reader.read(selected, readOptions);

            // Assert
            expect(result).to.equal(true);
            expect(observations).to.deep.equal([{ available: true, value: 150 }]);
        });
    }

    for (const status of [401, 403]) {
        it(`reports authentication or permission rejection from the calculation API (HTTP ${status})`, async () => {
            // Arrange
            fetchMock.callsFake(() => Promise.resolve(new Response('{}', { status })));

            // Act
            const result = await reader.read(device, readOptions);

            // Assert
            expect(result).to.equal(false);
            expect(fetchMock).to.have.been.calledOnce;
            expect(states.get(`devices.${device.deviceId}.extrapolation.available`)).to.equal(false);
            expect(adapter.log.warn).to.have.been.calledOnce;
        });
    }

    it('persists HTTP 429 cooldown and stops further calculation calls', async () => {
        // Arrange
        fetchMock.callsFake(() =>
            Promise.resolve(new Response('{}', { status: 429, headers: { 'Retry-After': '42' } })),
        );

        // Act
        const result = await reader.read(device, readOptions);

        // Assert
        expect(result).to.equal(false);
        expect(budget.defer).to.have.been.calledOnceWithExactly(42);
        expect(fetchMock).to.have.been.calledOnce;
    });

    it('does not publish response data after cancellation', async () => {
        // Arrange
        const controller = new AbortController();
        fetchMock.callsFake(() => {
            controller.abort();
            return Promise.resolve(Response.json(extrapolation));
        });

        // Act
        const result = await reader.read(device, { ...readOptions, signal: controller.signal });

        // Assert
        expect(result).to.equal(false);
        expect(fetchMock).to.have.been.calledOnce;
        expect(states.has(`devices.${device.deviceId}.extrapolation.actualValue`)).to.equal(false);
    });

    for (const { name, selected = device, options = readOptions } of [
        { name: 'unsafe device ID', selected: { ...device, deviceId: '../token' } },
        { name: 'invalid time zone', options: { ...readOptions, timeZone: 'invalid/timezone' } },
        { name: 'zero forecast horizon', selected: { ...device, forecastPeriods: 0 } },
        { name: 'fractional forecast horizon', selected: { ...device, forecastPeriods: 1.5 } },
        { name: 'forecast horizon exceeding its maximum', selected: { ...device, forecastPeriods: 37 } },
        {
            name: 'invalid extrapolation interval',
            selected: { ...device, extrapolationInterval: 'invalid' as 'month' },
        },
    ]) {
        it(`rejects ${name} before reserving a request or calling the API`, async () => {
            // Arrange: the case supplies its invalid device or options.

            // Act
            const result = await reader.read(selected, options);

            // Assert
            expect(result).to.equal(false);
            expect(fetchMock).not.to.have.been.called;
            expect(budget.acquire).not.to.have.been.called;
        });
    }

    it('removes objects for removed devices', async () => {
        // Arrange
        adapter.getDevicesAsync.resolves([
            { _id: `energy-tracker.0.devices.${device.deviceId}` },
            { _id: 'energy-tracker.0.devices.removed' },
        ] as ioBroker.DeviceObject[]);

        // Act
        await reader.configure([device]);

        // Assert
        expect(adapter.delObjectAsync).to.have.been.calledWith('energy-tracker.0.devices.removed', { recursive: true });
        expect(adapter.delObjectAsync).to.have.been.calledOnce;
    });
});
