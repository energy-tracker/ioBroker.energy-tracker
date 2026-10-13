"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataReader = void 0;
const api_client_1 = require("@energy-tracker/api-client");
const forecast_end_1 = require("./forecast-end");
const pointFields = {
    date: { name: 'Calendar period start', type: 'string', role: 'date' },
    actualValue: { name: 'Reading-backed consumption or production', type: 'number', role: 'value' },
    actualDuration: { name: 'Reading-backed duration', type: 'number', role: 'value.interval', unit: 's' },
    expectedValue: { name: 'Estimated total for the entire period', type: 'number', role: 'value' },
    expectedDuration: { name: 'Nominal full-period duration', type: 'number', role: 'value.interval', unit: 's' },
};
class DataReader {
    adapter;
    client;
    budget;
    createdObjects = new Set();
    constructor(adapter, client, budget) {
        this.adapter = adapter;
        this.client = client;
        this.budget = budget;
    }
    async configure(devices) {
        const configured = new Set(devices.filter(device => this.validDevice(device)).map(device => device.deviceId));
        for (const object of await this.adapter.getDevicesAsync()) {
            const prefix = `${this.adapter.namespace}.devices.`;
            if (object._id.startsWith(prefix) && !configured.has(object._id.slice(prefix.length))) {
                await this.adapter.delObjectAsync(object._id, { recursive: true });
            }
        }
    }
    async read(device, options) {
        const { timeZone, signal } = options;
        const periods = device?.forecastPeriods ?? 3;
        if (signal?.aborted) {
            return false;
        }
        if (!this.validDevice(device) ||
            !Object.values(api_client_1.CalculationInterval).includes(device.extrapolationInterval) ||
            !Number.isInteger(periods) ||
            periods < 1 ||
            periods > 36) {
            this.adapter.log.warn('Invalid read device, extrapolation interval or forecast horizon.');
            return false;
        }
        if (timeZone) {
            try {
                if (timeZone.length > 100) {
                    return false;
                }
                new Intl.DateTimeFormat('en', { timeZone }).format();
            }
            catch {
                this.adapter.log.warn('Invalid IANA time zone.');
                return false;
            }
        }
        const root = `devices.${device.deviceId}`;
        await this.object('devices', {
            type: 'channel',
            common: { name: 'Retrieved devices' },
            native: {},
        });
        await this.object(root, {
            type: 'device',
            common: { name: device.deviceId },
            native: {},
        });
        const requestOptions = { ...(timeZone ? { timeZone } : {}), signal };
        const id = `${root}.extrapolation`;
        await this.calculationGroup(id, 'Estimated consumption or production', device.unit);
        await this.state(`${id}.interval`, { name: 'Calendar interval', type: 'string', role: 'text' });
        return this.request(id, async () => {
            const points = await this.client.calculations.extrapolations(device.deviceId, {
                ...requestOptions,
                interval: device.extrapolationInterval,
                to: (0, forecast_end_1.forecastEnd)(device.extrapolationInterval, periods),
            });
            if (!signal?.aborted) {
                await this.writePoints(id, points);
                await this.write(`${id}.interval`, device.extrapolationInterval);
            }
        }, signal);
    }
    validDevice(device) {
        return (!!device &&
            typeof device.deviceId === 'string' &&
            /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(device.deviceId));
    }
    async object(id, object) {
        if (!this.createdObjects.has(id)) {
            await this.adapter.setObjectNotExistsAsync(id, object);
            this.createdObjects.add(id);
        }
    }
    async state(id, common) {
        if (this.createdObjects.has(id)) {
            return;
        }
        await this.adapter.extendObjectAsync(id, {
            type: 'state',
            common: { ...common, read: true, write: false },
            native: {},
        });
        this.createdObjects.add(id);
    }
    async group(id, name) {
        await this.object(id, { type: 'channel', common: { name }, native: {} });
        await this.state(`${id}.json`, { name: 'API result as JSON', type: 'string', role: 'json' });
        await this.state(`${id}.available`, {
            name: 'Last retrieval succeeded; values may be empty',
            type: 'boolean',
            role: 'indicator.reachable',
            def: false,
        });
        await this.state(`${id}.lastUpdated`, { name: 'Last successful retrieval', type: 'number', role: 'date' });
    }
    async calculationGroup(id, name, unit = '') {
        await this.group(id, name);
        for (const [field, common] of Object.entries(pointFields)) {
            await this.state(`${id}.${field}`, {
                ...common,
                ...(field === 'actualValue' || field === 'expectedValue' ? { unit } : {}),
            });
        }
    }
    async writePoints(id, points) {
        await this.write(`${id}.json`, JSON.stringify(points));
        const latest = points.findLast(point => point.actualDuration > 0 || point.expectedDuration > 0);
        for (const field of Object.keys(pointFields)) {
            const value = latest?.[field];
            await this.write(`${id}.${field}`, value instanceof Date ? value.toISOString() : (value ?? null));
        }
    }
    async request(id, operation, signal) {
        if (signal?.aborted) {
            return false;
        }
        if (!this.budget.available) {
            await this.write(`${id}.available`, false);
            this.adapter.log.warn(`[${id}] Retrieval skipped: API cooldown`);
            return false;
        }
        try {
            await this.budget.acquire(signal);
            await operation();
            if (signal?.aborted) {
                return false;
            }
            await this.write(`${id}.available`, true);
            await this.write(`${id}.lastUpdated`, Date.now());
            return true;
        }
        catch (error) {
            if (!signal?.aborted) {
                if (error instanceof api_client_1.RateLimitError) {
                    await this.budget.defer(error.retryAfter);
                }
                await this.write(`${id}.available`, false);
                this.adapter.log.warn(`[${id}] Retrieval failed: ${String(error)}`);
            }
            return false;
        }
    }
    async write(id, val) {
        await this.adapter.setStateAsync(id, { val, ack: true });
    }
}
exports.DataReader = DataReader;
