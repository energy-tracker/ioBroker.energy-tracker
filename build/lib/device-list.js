"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DeviceList = void 0;
const api_client_1 = require("@energy-tracker/api-client");
class DeviceList {
    adapter;
    client;
    budget;
    options = [];
    refreshAt = 0;
    pending;
    constructor(adapter, client, budget) {
        this.adapter = adapter;
        this.client = client;
        this.budget = budget;
    }
    get(signal) {
        this.pending ??= this.fetch(signal).finally(() => {
            this.pending = undefined;
        });
        return this.pending;
    }
    async fetch(signal) {
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
        }
        catch (error) {
            if (!signal?.aborted) {
                if (error instanceof api_client_1.RateLimitError) {
                    await this.budget.defer(error.retryAfter);
                }
                this.adapter.log.warn('Unable to retrieve devices. Check the token and its read:measuring-device permission.');
            }
        }
        this.refreshAt = Date.now() + 60_000;
        return this.options;
    }
}
exports.DeviceList = DeviceList;
