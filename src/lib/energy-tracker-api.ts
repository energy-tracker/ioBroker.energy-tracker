import axios from 'axios';

const BASE_URL = 'https://public-api.energy-tracker.best-ios-apps.de';

/**
 * API client for sending meter readings to the Energy Tracker platform.
 */
export class EnergyTrackerApi {
    /**
     * Creates a new instance of the EnergyTrackerApi.
     *
     * @param adapter ioBroker adapter instance for logging and state management.
     */
    constructor(private readonly adapter: ioBroker.Adapter) {}

    /**
     * Sends a meter reading for the given device to the Energy Tracker API.
     *
     * @param device The device for which the reading should be sent.
     */
    async sendReading(device: ioBroker.AdapterDevice): Promise<void> {
        const logPrefix = `[${device.sourceState}]`;

        try {
            const state = await this.adapter.getForeignStateAsync(device.sourceState);
            if (!state || typeof state.val !== 'number') {
                this.adapter.log.warn(`Invalid or missing state for ${device.sourceState}`);
                return;
            }

            const body = { value: state.val };

            await axios.post(`${BASE_URL}/v1/devices/${device.deviceId}/meter-readings`, body, {
                headers: {
                    Authorization: `Bearer ${this.adapter.config.bearerToken}`,
                    'Content-Type': 'application/json',
                },
                params: device.allowRounding ? { allowRounding: true } : {},
            });

            this.adapter.log.info(`${logPrefix} Reading sent: ${state.val}`);
            await this.adapter.setState('info.connection', { val: true, ack: true });
        } catch (err) {
            await this.adapter.setState('info.connection', { val: false, ack: true });
            this.handleError(logPrefix, err);
        }
    }

    private handleError(logPrefix: string, err: unknown): void {
        if (!axios.isAxiosError(err)) {
            this.adapter.log.error(`${logPrefix} Unexpected error: ${String(err)}`);
            return;
        }

        const { status, data } = err.response ?? {};

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
                    this.adapter.log.warn(
                        `${logPrefix} Server error ${status}: ${data?.message ?? 'Internal server error'}`,
                    );
                } else {
                    this.adapter.log.warn(
                        `${logPrefix} Unexpected HTTP ${status}: ${data?.message ?? 'Unknown error'}`,
                    );
                }
            }
        }
    }
}
