import { setTimeout as delay } from 'node:timers/promises';

const supportedIntervals = [60, 120, 300, 900, 3600];

/**
 * Keeps this instance below 60 data requests per five minutes, leaving
 * headroom within the API's shared 120-request IP budget.
 */
export class RequestBudget {
    private nextRequestAt = 0;
    private pending: Promise<void> = Promise.resolve();
    nextAllowedAt = 0;

    /**
     * @param adapter Adapter storing deadlines across restarts
     */
    constructor(private readonly adapter: ioBroker.Adapter) {}

    /** Restore request spacing and HTTP 429 cooldown. */
    async restore(): Promise<void> {
        const request = await this.adapter.getStateAsync('info.polling.nextRequestAt');
        const cooldown = await this.adapter.getStateAsync('info.polling.nextAllowedAt');
        this.nextRequestAt = typeof request?.val === 'number' && Number.isFinite(request.val) ? request.val : 0;
        this.nextAllowedAt = typeof cooldown?.val === 'number' && Number.isFinite(cooldown.val) ? cooldown.val : 0;
    }

    /** Whether a previous HTTP 429 permits another request yet. */
    get available(): boolean {
        return this.nextAllowedAt <= Date.now();
    }

    /**
     * Wait at least five seconds between data requests, including restarts.
     *
     * @param signal Cancellation on unload
     */
    async acquire(signal?: AbortSignal): Promise<void> {
        const reservation = this.pending.then(async () => {
            signal?.throwIfAborted();
            let wait: number;
            while ((wait = Math.max(this.nextRequestAt, this.nextAllowedAt) - Date.now()) > 0) {
                await delay(wait, undefined, { signal });
                signal?.throwIfAborted();
            }
            signal?.throwIfAborted();
            this.nextRequestAt = Date.now() + 5000;
            await this.adapter.setStateAsync('info.polling.nextRequestAt', { val: this.nextRequestAt, ack: true });
        });
        this.pending = reservation.catch(() => undefined);
        await reservation;
    }

    /**
     * @param retryAfter Server cooldown in seconds; unknown defaults to five minutes
     */
    async defer(retryAfter: number | null): Promise<void> {
        this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + (Math.max(1, retryAfter ?? 300) + 1) * 1000);
        await this.adapter.setStateAsync('info.polling.nextAllowedAt', { val: this.nextAllowedAt, ack: true });
    }
}

/**
 * @param selected User-selected pause after each completed cycle
 * @param devices Configured calculation resources
 * @returns Effective interval allowing headroom for each resource
 */
export function pollingInterval(selected: number, devices: ioBroker.AdapterReadDevice[]): number {
    if (!supportedIntervals.includes(selected)) {
        throw new Error('Polling interval must be 60, 120, 300, 900 or 3600 seconds');
    }
    return Math.max(selected, devices.length * 5);
}
