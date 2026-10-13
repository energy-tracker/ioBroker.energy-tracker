import {
    AuthenticationError,
    ConflictError,
    EnergyTrackerAPIError,
    type EnergyTrackerClient,
    ForbiddenError,
    NetworkError,
    RateLimitError,
    TimeoutError,
} from '@energy-tracker/api-client';
import { setTimeout as delay } from 'node:timers/promises';
import Decimal from 'decimal.js';
import type { RequestBudget } from './request-budget';

const RETRY_DELAYS = [2, 5, 10, 30, 60] as const;

/** Sends source states through the SDK and reports confirmed delivery. */
export class EnergyTrackerApi {
    /**
     * Create the reading sender with bounded timeout and server-error retries.
     *
     * @param adapter Adapter for reading source states and reporting results
     * @param client Energy Tracker SDK client
     * @param budget Shared request spacing and rate-limit cooldown
     */
    constructor(
        private readonly adapter: ioBroker.Adapter,
        private readonly client: Pick<EnergyTrackerClient, 'meterReadings'>,
        private readonly budget?: RequestBudget,
    ) {}

    /**
     * Send a reading without changing the batch's connection state.
     *
     * @param device Device and source state to submit
     * @param signal Signal to stop requests and pending retries on unload
     * @returns Whether the server confirmed that the reading was saved
     */
    async sendReading(device: ioBroker.AdapterDevice, signal?: AbortSignal): Promise<boolean> {
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
                        // A queued request may wait for other transfers or a rate-limit cooldown.
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
                } catch (err) {
                    const retryable =
                        err instanceof TimeoutError ||
                        (err instanceof EnergyTrackerAPIError &&
                            err.statusCode !== null &&
                            err.statusCode >= 500 &&
                            err.statusCode < 600);
                    if (!retryable || attempt >= RETRY_DELAYS.length || signal?.aborted) {
                        throw err;
                    }
                    const seconds = RETRY_DELAYS[attempt];
                    attempt++;
                    const reason = err instanceof TimeoutError ? 'timeout' : `HTTP ${err.statusCode}`;
                    this.adapter.log.warn(
                        `${prefix} ${reason}; retry ${attempt}/${RETRY_DELAYS.length} after ${seconds} seconds`,
                    );
                    await delay(seconds * 1000, undefined, { signal });
                }
            }
        } catch (err) {
            if (err instanceof RateLimitError && !signal?.aborted) {
                await this.budget?.defer(err.retryAfter);
            }
            if (!signal?.aborted) {
                this.handleError(prefix, err, attempt > 0);
            }
            return false;
        }
    }

    private async readSource(
        device: ioBroker.AdapterDevice,
        prefix: string,
        signal?: AbortSignal,
    ): Promise<{ value: string; timestamp?: Date } | null> {
        const state = await this.adapter.getForeignStateAsync(device.sourceState);
        if (signal?.aborted) {
            return null;
        }
        if (
            !state ||
            (typeof state.val !== 'number' && typeof state.val !== 'string') ||
            (typeof state.val === 'number' && !Number.isFinite(state.val)) ||
            (typeof state.val === 'string' && !/^-?\d+(?:\.\d+)?$/.test(state.val))
        ) {
            this.adapter.log.warn(`${prefix} Invalid or missing numeric state`);
            return null;
        }

        const value = new Decimal(state.val);
        if (value.isNegative() && !value.isZero()) {
            this.adapter.log.warn(`${prefix} Reading must not be negative`);
            return null;
        }

        // All attempts reuse the same timestamp: the server rejects duplicate readings at that time.
        return {
            value: value.toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed(),
            timestamp: new Date(),
        };
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
                `${prefix} Conflict after retry: the submission outcome is uncertain; check the reading in Energy Tracker`,
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
