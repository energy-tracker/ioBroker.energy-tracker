import {
    AuthenticationError,
    ConflictError,
    EnergyTrackerAPIError,
    type EnergyTrackerClient,
    ForbiddenError,
    NetworkError,
    RateLimitError,
    TimeoutError,
    ValidationError,
} from '@energy-tracker/api-client';
import { setTimeout as delay } from 'node:timers/promises';
import Decimal from 'decimal.js';

/** Sends source states through the SDK and reports confirmed delivery. */
export class EnergyTrackerApi {
    /**
     * Create the adapter's reading sender with optional timeout retries.
     *
     * @param adapter Adapter for reading source states and reporting results
     * @param client Energy Tracker SDK client
     * @param retries Additional attempts after a timeout (0–2)
     * @param retryDelay Delay between attempts in seconds (1–60)
     */
    constructor(
        private readonly adapter: ioBroker.Adapter,
        private readonly client: Pick<EnergyTrackerClient, 'meterReadings'>,
        private readonly retries = 0,
        private readonly retryDelay = 2,
    ) {
        if (!Number.isInteger(retries) || retries < 0 || retries > 2) {
            throw new ValidationError('Timeout retries must be an integer between 0 and 2');
        }
        if (retries > 0 && (!Number.isFinite(retryDelay) || retryDelay < 1 || retryDelay > 60)) {
            throw new ValidationError('Retry delay must be between 1 and 60 seconds');
        }
    }

    /**
     * Send a reading without changing the batch's connection state.
     *
     * @param device Device and source state to submit
     * @param signal Signal to stop requests and pending retries on unload
     * @returns Whether the server confirmed that the reading was saved
     */
    async sendReading(device: ioBroker.AdapterDevice, signal?: AbortSignal): Promise<boolean> {
        const prefix = `[${device.sourceState}]`;
        let attempt = 0;
        try {
            const state = await this.adapter.getForeignStateAsync(device.sourceState);
            if (signal?.aborted) {
                return false;
            }
            if (
                !state ||
                (typeof state.val !== 'number' && typeof state.val !== 'string') ||
                (typeof state.val === 'number' && !Number.isFinite(state.val)) ||
                (typeof state.val === 'string' && !/^-?\d+(?:\.\d+)?$/.test(state.val))
            ) {
                this.adapter.log.warn(`${prefix} Invalid or missing numeric state`);
                return false;
            }

            const value = new Decimal(state.val);
            if (value.isNegative() && !value.isZero()) {
                this.adapter.log.warn(`${prefix} Reading must not be negative`);
                return false;
            }

            // Pin the timestamp when retrying: the server rejects duplicate readings at the same time.
            const reading = {
                value: value.toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed(),
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
                } catch (err) {
                    if (!(err instanceof TimeoutError) || attempt >= this.retries || signal?.aborted) {
                        throw err;
                    }
                    attempt++;
                    this.adapter.log.warn(
                        `${prefix} Request timed out; retry ${attempt}/${this.retries} in ${this.retryDelay} seconds`,
                    );
                    await delay(this.retryDelay * 1000, undefined, { signal });
                }
            }
        } catch (err) {
            if (!signal?.aborted) {
                this.handleError(prefix, err, attempt > 0);
            }
            return false;
        }
    }

    private handleError(prefix: string, err: unknown, retried: boolean): void {
        if (err instanceof AuthenticationError) {
            this.adapter.log.error(`${prefix} Unauthorized: Check your access token`);
        } else if (err instanceof ForbiddenError) {
            this.adapter.log.error(`${prefix} Forbidden: Insufficient permissions`);
        } else if (err instanceof TimeoutError) {
            this.adapter.log.error(`${prefix} Request timed out after 10 seconds; the reading may already be saved`);
        } else if (err instanceof ConflictError && retried) {
            this.adapter.log.warn(
                `${prefix} Conflict after timeout: the submission outcome is uncertain; check the reading in Energy Tracker`,
            );
        } else if (err instanceof RateLimitError) {
            const retryAfter = err.retryAfter === null ? '' : ` – Retry after ${err.retryAfter} seconds.`;
            this.adapter.log.warn(`${prefix} Too many requests: Rate limit exceeded${retryAfter}`);
        } else if (err instanceof NetworkError) {
            this.adapter.log.error(`${prefix} Network error: ${err.message}`);
        } else if (err instanceof EnergyTrackerAPIError) {
            const status = err.statusCode === null ? 'Invalid input' : `HTTP ${err.statusCode}`;
            this.adapter.log.warn(`${prefix} ${status}: ${err.apiMessage.join('; ') || err.message}`);
        } else {
            this.adapter.log.error(`${prefix} Unexpected error: ${String(err)}`);
        }
    }
}
