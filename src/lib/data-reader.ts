import {
    CalculationInterval,
    RateLimitError,
    type CalculationPointDto,
    type EnergyTrackerClient,
} from '@energy-tracker/api-client';
import type { RequestBudget } from './request-budget';
import { forecastEnd } from './forecast-end';

const pointFields = {
    date: { name: 'Calendar period start', type: 'string', role: 'date' },
    actualValue: { name: 'Reading-backed consumption or production', type: 'number', role: 'value' },
    actualDuration: { name: 'Reading-backed duration', type: 'number', role: 'value.interval', unit: 's' },
    expectedValue: { name: 'Estimated total for the entire period', type: 'number', role: 'value' },
    expectedDuration: { name: 'Nominal full-period duration', type: 'number', role: 'value.interval', unit: 's' },
} as const;

interface CalculationOptions {
    timeZone: string;
    signal?: AbortSignal;
}

/** Retrieves extrapolations through the public SDK into read-only ioBroker states. */
export class DataReader {
    private readonly createdObjects = new Set<string>();
    /**
     * @param adapter Adapter receiving states
     * @param client SDK calculation resource
     * @param budget Persistent request spacing and cooldown
     */
    constructor(
        private readonly adapter: ioBroker.Adapter,
        private readonly client: Pick<EnergyTrackerClient, 'calculations'>,
        private readonly budget: RequestBudget,
    ) {}

    /**
     * Remove states for no longer configured devices.
     *
     * @param devices Current read configuration
     */
    async configure(devices: ioBroker.AdapterReadDevice[]): Promise<void> {
        const configured = new Set(devices.filter(device => this.validDevice(device)).map(device => device.deviceId));
        for (const object of await this.adapter.getDevicesAsync()) {
            const prefix = `${this.adapter.namespace}.devices.`;
            if (object._id.startsWith(prefix) && !configured.has(object._id.slice(prefix.length))) {
                await this.adapter.delObjectAsync(object._id, { recursive: true });
            }
        }
    }

    /**
     * @param device Extrapolation interval and settings for a standard measuring device
     * @param options Optional IANA time zone and cancellation on unload
     * @returns Whether the extrapolation was retrieved
     */
    async read(device: ioBroker.AdapterReadDevice, options: CalculationOptions): Promise<boolean> {
        const { timeZone, signal } = options;
        const periods = device?.forecastPeriods ?? 3;
        if (signal?.aborted) {
            return false;
        }
        if (
            !this.validDevice(device) ||
            !Object.values(CalculationInterval).includes(device.extrapolationInterval) ||
            !Number.isInteger(periods) ||
            periods < 1 ||
            periods > 36
        ) {
            this.adapter.log.warn('Invalid read device, extrapolation interval or forecast horizon.');
            return false;
        }
        if (timeZone) {
            try {
                if (timeZone.length > 100) {
                    return false;
                }
                new Intl.DateTimeFormat('en', { timeZone }).format();
            } catch {
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
        return this.request(
            id,
            async () => {
                const points = await this.client.calculations.extrapolations(device.deviceId, {
                    ...requestOptions,
                    interval: device.extrapolationInterval,
                    to: forecastEnd(device.extrapolationInterval, periods),
                });
                if (!signal?.aborted) {
                    await this.writePoints(id, points);
                    await this.write(`${id}.interval`, device.extrapolationInterval);
                }
            },
            signal,
        );
    }

    private validDevice(device: ioBroker.AdapterReadDevice): boolean {
        return (
            !!device &&
            typeof device.deviceId === 'string' &&
            /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(device.deviceId)
        );
    }

    private async object(id: string, object: ioBroker.SettableObject): Promise<void> {
        if (!this.createdObjects.has(id)) {
            await this.adapter.setObjectNotExistsAsync(id, object);
            this.createdObjects.add(id);
        }
    }

    private async state(id: string, common: Omit<ioBroker.StateCommon, 'read' | 'write'>): Promise<void> {
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

    private async group(id: string, name: string): Promise<void> {
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

    private async calculationGroup(id: string, name: string, unit = ''): Promise<void> {
        await this.group(id, name);
        for (const [field, common] of Object.entries(pointFields)) {
            await this.state(`${id}.${field}`, {
                ...common,
                ...(field === 'actualValue' || field === 'expectedValue' ? { unit } : {}),
            });
        }
    }

    private async writePoints(id: string, points: CalculationPointDto[]): Promise<void> {
        await this.write(`${id}.json`, JSON.stringify(points));
        // Forecast-only periods are valid; zero-duration terminal placeholders are not.
        const latest = points.findLast(point => point.actualDuration > 0 || point.expectedDuration > 0);
        for (const field of Object.keys(pointFields) as (keyof CalculationPointDto)[]) {
            const value = latest?.[field];
            await this.write(`${id}.${field}`, value instanceof Date ? value.toISOString() : (value ?? null));
        }
    }

    private async request(id: string, operation: () => Promise<void>, signal?: AbortSignal): Promise<boolean> {
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
        } catch (error) {
            if (!signal?.aborted) {
                if (error instanceof RateLimitError) {
                    await this.budget.defer(error.retryAfter);
                }
                await this.write(`${id}.available`, false);
                this.adapter.log.warn(`[${id}] Retrieval failed: ${String(error)}`);
            }
            return false;
        }
    }

    private async write(id: string, val: ioBroker.StateValue): Promise<void> {
        await this.adapter.setStateAsync(id, { val, ack: true });
    }
}
