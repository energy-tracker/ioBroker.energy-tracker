import * as utils from '@iobroker/adapter-core';
import { EnergyTrackerClient } from '@energy-tracker/api-client';
import { EnergyTrackerApi } from './lib/energy-tracker-api';
import { DataReader } from './lib/data-reader';
import { RequestBudget, pollingInterval } from './lib/request-budget';
import { DEFAULT_SEND_SCHEDULE, migrateLegacyInstances } from './lib/migration';
import { submissionSchedule } from './lib/submission-schedule';
import { TokenStatus } from './lib/token-status';
import { accessTokenInput } from './lib/token-input';
import { DeviceList } from './lib/device-list';
import { timeZoneOptions } from './lib/time-zone-options';
import type { Job } from 'node-schedule';
import { setTimeout as delay } from 'node:timers/promises';

class EnergyTracker extends utils.Adapter {
    private readonly abortController = new AbortController();
    private sendJob?: Job;
    private sending = false;
    private readResult?: boolean;
    private sendResult?: boolean;
    private tokenStatus?: TokenStatus;
    private deviceList?: DeviceList;

    constructor(options: Partial<utils.AdapterOptions> = {}) {
        super({ ...options, name: 'energy-tracker', useFormatDate: true });
        this.on('install', this.onInstall.bind(this));
        this.on('ready', this.onReady.bind(this));
        this.on('message', this.onMessage.bind(this));
        this.on('unload', callback => {
            this.abortController.abort();
            this.sendJob?.cancel();
            callback();
        });
    }

    private async onInstall(): Promise<void> {
        try {
            await migrateLegacyInstances(this);
            this.terminate('Instance migration completed.', 0);
        } catch (error) {
            this.log.error(`Unable to migrate Energy Tracker instances: ${String(error)}`);
            this.terminate('Instance migration failed.', 1);
        }
    }

    private async onReady(): Promise<void> {
        try {
            if (await migrateLegacyInstances(this)) {
                return;
            }
            if (this.common?.mode !== 'daemon') {
                this.terminate(
                    'Install or upgrade the adapter to migrate its instance configuration.',
                    utils.EXIT_CODES.INVALID_ADAPTER_CONFIG,
                );
                return;
            }
            await this.resetAvailability();
            if (this.abortController.signal.aborted) {
                return;
            }
            this.tokenStatus = new TokenStatus(
                this,
                accessToken => new EnergyTrackerClient({ accessToken, timeout: 10 }),
            );
            if (!this.config.bearerToken) {
                this.log.warn('Missing bearer token in adapter configuration – waiting for configuration.');
                return;
            }
            const client = new EnergyTrackerClient({ accessToken: this.config.bearerToken, timeout: 10 });
            const budget = new RequestBudget(this);
            await budget.restore();
            if (this.abortController.signal.aborted) {
                return;
            }
            this.deviceList = new DeviceList(this, client, budget);
            await this.scheduleSubmission(client, budget);
            const reader = new DataReader(this, client, budget);
            const readDevices = Array.isArray(this.config.readDevices) ? this.config.readDevices : [];
            await reader.configure(readDevices);
            await this.pollCalculations(reader, budget, readDevices);
        } catch (error) {
            if (!this.abortController.signal.aborted) {
                this.readResult = false;
                this.log.error(`Unable to initialize or retrieve Energy Tracker data: ${String(error)}`);
                await this.publishConnection().catch(() => undefined);
            }
        }
    }

    private async onMessage(message: ioBroker.Message): Promise<void> {
        if (
            !message.callback ||
            !['getTokenInfo', 'checkToken', 'getDevices', 'getTimeZones'].includes(message.command)
        ) {
            return;
        }
        let response: unknown;
        try {
            if (message.command === 'getTimeZones') {
                response = timeZoneOptions(this.language, message.message?.timeZone);
            } else if (message.command === 'getDevices') {
                response =
                    this.config.bearerToken &&
                    (await this.tokenStatus?.allowsDeviceListing(this.config.bearerToken, this.abortController.signal))
                        ? ((await this.deviceList?.get(this.abortController.signal)) ?? [])
                        : [];
            } else {
                const payload = message.message;
                const supplied = payload && typeof payload === 'object' && 'token' in payload;
                const credential = supplied ? accessTokenInput(payload.token) : this.config.bearerToken;
                response = !credential
                    ? { error: 'tokenCheckFormat' }
                    : this.tokenStatus
                      ? await this.tokenStatus.get(credential, this.abortController.signal)
                      : { error: 'tokenCheckUnavailable' };
            }
        } catch {
            response = ['getDevices', 'getTimeZones'].includes(message.command)
                ? []
                : { error: 'tokenCheckUnavailable' };
            this.log.warn('Unable to process the configuration request.');
        }
        this.sendTo(message.from, message.command, response, message.callback);
    }

    private async resetAvailability(): Promise<void> {
        await this.setStateAsync('info.connection', { val: false, ack: true });
        await this.setStateAsync('info.sending.available', { val: false, ack: true });
        await this.setStateAsync('info.sending.nextRun', { val: null, ack: true });
        await this.setStateAsync('info.polling.effectiveInterval', { val: 0, ack: true });
        for (const id of Object.keys(await this.getStatesAsync('devices.*.available'))) {
            await this.setStateAsync(id, { val: false, ack: true });
        }
    }

    private async scheduleSubmission(client: EnergyTrackerClient, budget: RequestBudget): Promise<void> {
        const devices = Array.isArray(this.config.devices)
            ? this.config.devices.filter(device => device?.deviceId || device?.sourceState)
            : [];
        if (this.config.sendEnabled && devices.length > 0) {
            const schedule = this.config.sendSchedule ?? DEFAULT_SEND_SCHEDULE;
            this.sendJob =
                submissionSchedule(schedule, async () => {
                    await this.submitReadings(client, budget, devices);
                    if (!this.abortController.signal.aborted) {
                        await this.publishNextSubmission();
                    }
                }) ?? undefined;
            if (this.sendJob) {
                this.sendJob.on('error', error => this.log.error(`Reading submission job failed: ${String(error)}`));
                await this.publishNextSubmission();
                this.log.info(`Reading submission scheduled: ${schedule}`);
            } else {
                this.sendResult = false;
                this.log.error('Invalid reading submission CRON schedule – sending is disabled.');
            }
        }
    }

    private async pollCalculations(
        reader: DataReader,
        budget: RequestBudget,
        devices: ioBroker.AdapterReadDevice[],
    ): Promise<void> {
        if (devices.length === 0) {
            this.log.info('Calculation retrieval is disabled.');
            return;
        }
        const interval = pollingInterval(this.config.pollInterval ?? 60, devices);
        const options = {
            timeZone: this.config.timeZone?.trim() ?? '',
            signal: this.abortController.signal,
        };
        this.log.info(`Retrieving calculations with a ${interval} second pause between completed cycles.`);
        let failures = 0;
        do {
            const results: boolean[] = [];
            for (const device of devices) {
                if (this.abortController.signal.aborted) {
                    return;
                }
                results.push(await reader.read(device, options));
            }
            if (this.abortController.signal.aborted) {
                return;
            }
            this.readResult = results.every(Boolean);
            await this.publishConnection();
            failures = this.readResult ? 0 : Math.min(failures + 1, 6);
            const pause = Math.max(
                interval,
                Math.min(interval * 2 ** failures, 900),
                (budget.nextAllowedAt - Date.now()) / 1000,
            );
            await this.setStateAsync('info.polling.effectiveInterval', { val: pause, ack: true });
            await delay(pause * 1000, undefined, { signal: this.abortController.signal });
        } while (!this.abortController.signal.aborted);
    }

    private async submitReadings(
        client: EnergyTrackerClient,
        budget: RequestBudget,
        devices: ioBroker.AdapterDevice[],
    ): Promise<void> {
        const signal = this.abortController.signal;
        if (signal.aborted || this.sending) {
            return;
        }
        this.sending = true;
        try {
            const api = new EnergyTrackerApi(this, client, budget);
            const results: boolean[] = [];
            for (const device of devices) {
                if (signal.aborted) {
                    return;
                }
                if (!device?.deviceId || !device.sourceState) {
                    this.log.warn('Device config incomplete – skipping reading submission.');
                    results.push(false);
                } else {
                    results.push(await api.sendReading(device, signal));
                }
            }
            if (!signal.aborted) {
                this.sendResult = results.length > 0 && results.every(Boolean);
                await this.setStateAsync('info.sending.available', { val: this.sendResult, ack: true });
                await this.setStateAsync('info.sending.lastRun', { val: Date.now(), ack: true });
                await this.publishConnection();
            }
        } catch (error) {
            if (!signal.aborted) {
                this.sendResult = false;
                await this.setStateAsync('info.sending.available', { val: false, ack: true });
                await this.publishConnection();
                this.log.error(`Unable to submit Energy Tracker readings: ${String(error)}`);
            }
        } finally {
            this.sending = false;
        }
    }

    private async publishConnection(): Promise<void> {
        const results = [this.readResult, this.sendResult].filter(result => result !== undefined);
        await this.setStateAsync('info.connection', { val: results.length > 0 && results.every(Boolean), ack: true });
    }

    private async publishNextSubmission(): Promise<void> {
        await this.setStateAsync('info.sending.nextRun', {
            val: this.sendJob?.nextInvocation()?.getTime() ?? null,
            ack: true,
        });
    }
}

if (require.main !== module) {
    module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new EnergyTracker(options);
} else {
    (() => new EnergyTracker())();
}
