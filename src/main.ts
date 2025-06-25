import * as utils from '@iobroker/adapter-core';
import { EnergyTrackerApi } from './lib/energy-tracker-api';

class EnergyTracker extends utils.Adapter {
    private api!: EnergyTrackerApi;

    constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({
            ...options,
            name: 'energy-tracker',
        });

        this.on('ready', this.onReady.bind(this));
    }

    private async onReady(): Promise<void> {
        this.api = new EnergyTrackerApi(this);

        await this.setState('info.connection', { val: false, ack: true });

        if (!this.config.bearerToken) {
            this.terminate('Missing bearer token in adapter configuration – skipping adapter start.');
            return;
        }
        if (!Array.isArray(this.config.devices) || this.config.devices.length === 0) {
            this.terminate('No devices configured in adapter settings – skipping adapter start.');
            return;
        }

        for (const device of this.config.devices) {
            if (!device.deviceId || !device.sourceState) {
                this.log.warn(`[${device.sourceState}] Device config incomplete – skipping.`);
                continue;
            }

            void this.api.sendReading(device);
        }

        await this.setState('info.connection', { val: true, ack: true });
        this.terminate('Terminating scheduled adapter instance.');
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new EnergyTracker(options);
} else {
    (() => new EnergyTracker())();
}
