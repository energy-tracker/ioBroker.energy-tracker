"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnergyTrackerApi = void 0;
const api_client_1 = require("@energy-tracker/api-client");
const promises_1 = require("node:timers/promises");
const decimal_js_1 = __importDefault(require("decimal.js"));
class EnergyTrackerApi {
    adapter;
    client;
    retries;
    retryDelay;
    constructor(adapter, client, retries = 0, retryDelay = 2) {
        this.adapter = adapter;
        this.client = client;
        this.retries = retries;
        this.retryDelay = retryDelay;
        if (!Number.isInteger(retries) || retries < 0 || retries > 2) {
            throw new api_client_1.ValidationError('Timeout retries must be an integer between 0 and 2');
        }
        if (retries > 0 && (!Number.isFinite(retryDelay) || retryDelay < 1 || retryDelay > 60)) {
            throw new api_client_1.ValidationError('Retry delay must be between 1 and 60 seconds');
        }
    }
    async sendReading(device, signal) {
        const prefix = `[${device.sourceState}]`;
        let attempt = 0;
        try {
            const state = await this.adapter.getForeignStateAsync(device.sourceState);
            if (signal?.aborted) {
                return false;
            }
            if (!state ||
                (typeof state.val !== 'number' && typeof state.val !== 'string') ||
                (typeof state.val === 'number' && !Number.isFinite(state.val)) ||
                (typeof state.val === 'string' && !/^-?\d+(?:\.\d+)?$/.test(state.val))) {
                this.adapter.log.warn(`${prefix} Invalid or missing numeric state`);
                return false;
            }
            const value = new decimal_js_1.default(state.val);
            if (value.isNegative() && !value.isZero()) {
                this.adapter.log.warn(`${prefix} Reading must not be negative`);
                return false;
            }
            const reading = {
                value: value.toDecimalPlaces(6, decimal_js_1.default.ROUND_HALF_UP).toFixed(),
                ...(this.retries > 0 ? { timestamp: new Date() } : {}),
            };
            for (;;) {
                try {
                    await this.client.meterReadings.create(device.deviceId, reading, {
                        allowRounding: device.allowRounding,
                        signal,
                    });
                    this.adapter.log.info(`${prefix} Reading sent: ${reading.value}`);
                    return true;
                }
                catch (err) {
                    if (!(err instanceof api_client_1.TimeoutError) || attempt >= this.retries || signal?.aborted) {
                        throw err;
                    }
                    attempt++;
                    this.adapter.log.warn(`${prefix} Request timed out; retry ${attempt}/${this.retries} in ${this.retryDelay} seconds`);
                    await (0, promises_1.setTimeout)(this.retryDelay * 1000, undefined, { signal });
                }
            }
        }
        catch (err) {
            if (!signal?.aborted) {
                this.handleError(prefix, err, attempt > 0);
            }
            return false;
        }
    }
    handleError(prefix, err, retried) {
        if (err instanceof api_client_1.AuthenticationError) {
            this.adapter.log.error(`${prefix} Unauthorized: Check your access token`);
        }
        else if (err instanceof api_client_1.ForbiddenError) {
            this.adapter.log.error(`${prefix} Forbidden: Insufficient permissions`);
        }
        else if (err instanceof api_client_1.TimeoutError) {
            this.adapter.log.error(`${prefix} Request timed out after 10 seconds; the reading may already be saved`);
        }
        else if (err instanceof api_client_1.ConflictError && retried) {
            this.adapter.log.warn(`${prefix} Conflict after timeout: the submission outcome is uncertain; check the reading in Energy Tracker`);
        }
        else if (err instanceof api_client_1.RateLimitError) {
            const retryAfter = err.retryAfter === null ? '' : ` – Retry after ${err.retryAfter} seconds.`;
            this.adapter.log.warn(`${prefix} Too many requests: Rate limit exceeded${retryAfter}`);
        }
        else if (err instanceof api_client_1.NetworkError) {
            this.adapter.log.error(`${prefix} Network error: ${err.message}`);
        }
        else if (err instanceof api_client_1.EnergyTrackerAPIError) {
            const status = err.statusCode === null ? 'Invalid input' : `HTTP ${err.statusCode}`;
            this.adapter.log.warn(`${prefix} ${status}: ${err.apiMessage.join('; ') || err.message}`);
        }
        else {
            this.adapter.log.error(`${prefix} Unexpected error: ${String(err)}`);
        }
    }
}
exports.EnergyTrackerApi = EnergyTrackerApi;
