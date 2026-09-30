import * as utils from '@iobroker/adapter-core';
import { EnergyTrackerClient } from '@energy-tracker/api-client';
import { EnergyTrackerApi } from './lib/energy-tracker-api';

class EnergyTracker extends utils.Adapter {
    private readonly abortController = new AbortController();

    constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'energy-tracker',
        });

        this.on('ready', this.onReady.bind(this));
        this.on('unload', callback => {
            this.abortController.abort();
            callback();
        });
    }

    private async onReady(): Promise<void> {
        let terminationMessage = 'Terminating scheduled adapter instance.';
        try {
            await this.setStateAsync('info.connection', { val: false, ack: true });
            if (this.abortController.signal.aborted) {
                return;
            }
            if (!this.config.bearerToken) {
                terminationMessage = 'Missing bearer token in adapter configuration – skipping adapter start.';
                return;
            }
            if (!Array.isArray(this.config.devices) || this.config.devices.length === 0) {
                terminationMessage = 'No devices configured in adapter settings – skipping adapter start.';
                return;
            }
            const api = new EnergyTrackerApi(
                this,
                new EnergyTrackerClient({ accessToken: this.config.bearerToken, timeout: 10 }),
                this.config.timeoutRetries ?? 0,
                this.config.retryDelay ?? 2,
            );
            const results = await Promise.all(
                this.config.devices.map(device => {
                    if (!device?.deviceId || !device.sourceState) {
                        this.log.warn('Device config incomplete – skipping.');
                        return Promise.resolve(false);
                    }
                    return api.sendReading(device, this.abortController.signal);
                }),
            );
            if (!this.abortController.signal.aborted) {
                await this.setStateAsync('info.connection', { val: results.every(Boolean), ack: true });
            }
        } catch (err) {
            this.log.error(`Unable to send readings: ${String(err)}`);
        } finally {
            if (!this.abortController.signal.aborted) {
                this.terminate(terminationMessage);
            }
        }
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new EnergyTracker(options);
} else {
    (() => new EnergyTracker())();
}
