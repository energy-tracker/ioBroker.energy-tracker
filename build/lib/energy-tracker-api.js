"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnergyTrackerApi = void 0;
const axios_1 = require("axios");
class EnergyTrackerApi {
    adapter;
    client;
    constructor(adapter, client) {
        this.adapter = adapter;
        this.client = client;
    }
    async sendReading(device) {
        const logPrefix = `[${device.sourceState}]`;
        try {
            const state = await this.adapter.getForeignStateAsync(device.sourceState);
            if (!state || typeof state.val !== 'number') {
                this.adapter.log.warn(`Invalid or missing state for ${device.sourceState}`);
                return;
            }
            const body = { value: state.val };
            await this.client.post(`/v1/devices/${device.deviceId}/meter-readings`, body, {
                headers: {
                    Authorization: `Bearer ${this.adapter.config.bearerToken}`,
                    'Content-Type': 'application/json',
                },
                params: device.allowRounding ? { allowRounding: true } : {},
            });
            this.adapter.log.info(`${logPrefix} Reading sent: ${state.val}`);
            await this.adapter.setState('info.connection', { val: true, ack: true });
        }
        catch (err) {
            await this.adapter.setState('info.connection', { val: false, ack: true });
            this.handleError(logPrefix, err);
        }
    }
    handleError(logPrefix, err) {
        if (!(0, axios_1.isAxiosError)(err)) {
            this.adapter.log.error(`${logPrefix} Unexpected error: ${String(err)}`);
            return;
        }
        const { status, data } = err.response ?? {};
        if (err.code === 'ECONNABORTED') {
            this.adapter.log.error(`${logPrefix} Request timed out after ${err.config?.timeout ?? 'unknown'} ms`);
            return;
        }
        if (status === undefined) {
            this.adapter.log.error(`${logPrefix} Network error: ${err.message}`);
            return;
        }
        switch (status) {
            case 400:
                this.adapter.log.warn(`${logPrefix} Bad Request: ${data?.message ?? 'Invalid input'}`);
                break;
            case 401:
                this.adapter.log.error(`${logPrefix} Unauthorized: Check your access token`);
                break;
            case 403:
                this.adapter.log.error(`${logPrefix} Forbidden: Insufficient permissions`);
                break;
            case 429: {
                const retryAfter = err.response?.headers?.['retry-after'];
                const retryAfterSec = Number(retryAfter);
                let msg = `${logPrefix} Too many requests: Rate limit exceeded`;
                if (retryAfter && !isNaN(retryAfterSec)) {
                    msg += ` – Retry after ${retryAfter} seconds.`;
                }
                this.adapter.log.warn(msg);
                break;
            }
            default: {
                if (status >= 500 && status <= 599) {
                    this.adapter.log.warn(`${logPrefix} Server error ${status}: ${data?.message ?? 'Internal server error'}`);
                }
                else {
                    this.adapter.log.warn(`${logPrefix} Unexpected HTTP ${status}: ${data?.message ?? 'Unknown error'}`);
                }
            }
        }
    }
}
exports.EnergyTrackerApi = EnergyTrackerApi;
