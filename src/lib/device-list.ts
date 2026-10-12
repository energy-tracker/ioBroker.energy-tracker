import { RateLimitError, type EnergyTrackerClient } from '@energy-tracker/api-client';
import type { RequestBudget } from './request-budget';

interface DeviceOption {
    value: string;
    label: string;
}

/** Shares one short-lived device list between all configuration table selectors. */
export class DeviceList {
    private options: DeviceOption[] = [];
    private refreshAt = 0;
    private pending?: Promise<DeviceOption[]>;

    /**
     * @param adapter Diagnostic messages
     * @param client SDK device resource
     * @param budget Request spacing shared with sending and calculation retrieval
     */
    constructor(
        private readonly adapter: ioBroker.Adapter,
        private readonly client: Pick<EnergyTrackerClient, 'devices'>,
        private readonly budget: RequestBudget,
    ) {}

    /**
     * @param signal Cancellation on unload
     * @returns Native ioBroker dropdown entries using device names, paths and IDs
     */
    get(signal?: AbortSignal): Promise<DeviceOption[]> {
        this.pending ??= this.fetch(signal).finally(() => {
            this.pending = undefined;
        });
        return this.pending;
    }

    private async fetch(signal?: AbortSignal): Promise<DeviceOption[]> {
        if (signal?.aborted || Date.now() < this.refreshAt || !this.budget.available) {
            return this.options;
        }
        try {
            await this.budget.acquire(signal);
            const devices = await this.client.devices.listStandard({ signal });
            if (!signal?.aborted) {
                this.options = devices
                    .map(device => ({
                        value: device.id,
                        label: `${device.folderPath}/${device.name} (${device.id})`.replace(/\/{2,}/g, '/'),
                    }))
                    .sort((a, b) => a.label.localeCompare(b.label));
            }
        } catch (error) {
            if (!signal?.aborted) {
                if (error instanceof RateLimitError) {
                    await this.budget.defer(error.retryAfter);
                }
                this.adapter.log.warn(
                    'Unable to retrieve devices. Check the token and its read:measuring-device permission.',
                );
            }
        }
        this.refreshAt = Date.now() + 60_000;
        return this.options;
    }
}
