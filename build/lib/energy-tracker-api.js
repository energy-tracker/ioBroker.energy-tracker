"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.EnergyTrackerApi = void 0;
const api_client_1 = require("@energy-tracker/api-client");
const promises_1 = require("node:timers/promises");
const decimal_js_1 = __importDefault(require("decimal.js"));
const RETRY_DELAYS = [2, 5, 10, 30, 60];
class EnergyTrackerApi {
    adapter;
    client;
    budget;
    constructor(adapter, client, budget) {
        this.adapter = adapter;
        this.client = client;
        this.budget = budget;
    }
    async sendReading(device, signal) {
        if (signal?.aborted) {
            return false;
        }
        const prefix = `[${device.sourceState}]`;
        let attempt = 0;
        try {
            const initialReading = await this.readSource(device, prefix, signal);
            if (!initialReading) {
                return false;
            }
            let reading = initialReading;
            for (;;) {
                try {
                    if (this.budget && !this.budget.available) {
                        this.adapter.log.warn(`${prefix} Reading submission skipped: API cooldown`);
                        return false;
                    }
                    await this.budget?.acquire(signal);
                    signal?.throwIfAborted();
                    if (this.budget && attempt === 0) {
                        const latestReading = await this.readSource(device, prefix, signal);
                        if (!latestReading) {
                            return false;
                        }
                        reading = latestReading;
                    }
                    await this.client.meterReadings.create(device.deviceId, reading, {
                        allowRounding: device.allowRounding,
                        signal,
                    });
                    this.adapter.log.info(`${prefix} Reading sent: ${reading.value}`);
                    return true;
                }
                catch (err) {
                    const retryable = err instanceof api_client_1.TimeoutError ||
                        (err instanceof api_client_1.EnergyTrackerAPIError &&
                            err.statusCode !== null &&
                            err.statusCode >= 500 &&
                            err.statusCode < 600);
                    if (!retryable || attempt >= RETRY_DELAYS.length || signal?.aborted) {
                        throw err;
                    }
                    const seconds = RETRY_DELAYS[attempt];
                    attempt++;
                    const reason = err instanceof api_client_1.TimeoutError ? 'timeout' : `HTTP ${err.statusCode}`;
                    this.adapter.log.warn(`${prefix} ${reason}; retry ${attempt}/${RETRY_DELAYS.length} after ${seconds} seconds`);
                    await (0, promises_1.setTimeout)(seconds * 1000, undefined, { signal });
                }
            }
        }
        catch (err) {
            if (err instanceof api_client_1.RateLimitError && !signal?.aborted) {
                await this.budget?.defer(err.retryAfter);
            }
            if (!signal?.aborted) {
                this.handleError(prefix, err, attempt > 0);
            }
            return false;
        }
    }
    async readSource(device, prefix, signal) {
        const state = await this.adapter.getForeignStateAsync(device.sourceState);
        if (signal?.aborted) {
            return null;
        }
        if (!state ||
            (typeof state.val !== 'number' && typeof state.val !== 'string') ||
            (typeof state.val === 'number' && !Number.isFinite(state.val)) ||
            (typeof state.val === 'string' && !/^-?\d+(?:\.\d+)?$/.test(state.val))) {
            this.adapter.log.warn(`${prefix} Invalid or missing numeric state`);
            return null;
        }
        const value = new decimal_js_1.default(state.val);
        if (value.isNegative() && !value.isZero()) {
            this.adapter.log.warn(`${prefix} Reading must not be negative`);
            return null;
        }
        return {
            value: value.toDecimalPlaces(6, decimal_js_1.default.ROUND_DOWN).toFixed(),
            timestamp: new Date(),
        };
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
            this.adapter.log.warn(`${prefix} Conflict after retry: the submission outcome is uncertain; check the reading in Energy Tracker`);
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
