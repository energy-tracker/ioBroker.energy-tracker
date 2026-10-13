"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
const api_client_1 = require("@energy-tracker/api-client");
const energy_tracker_api_1 = require("./lib/energy-tracker-api");
const data_reader_1 = require("./lib/data-reader");
const request_budget_1 = require("./lib/request-budget");
const migration_1 = require("./lib/migration");
const submission_schedule_1 = require("./lib/submission-schedule");
const token_status_1 = require("./lib/token-status");
const token_input_1 = require("./lib/token-input");
const device_list_1 = require("./lib/device-list");
const time_zone_options_1 = require("./lib/time-zone-options");
const promises_1 = require("node:timers/promises");
class EnergyTracker extends utils.Adapter {
    abortController = new AbortController();
    sendJob;
    sending = false;
    readResult;
    sendResult;
    tokenStatus;
    deviceList;
    constructor(options = {}) {
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
    async onInstall() {
        try {
            await (0, migration_1.migrateLegacyInstances)(this);
            this.terminate('Instance migration completed.', 0);
        }
        catch (error) {
            this.log.error(`Unable to migrate Energy Tracker instances: ${String(error)}`);
            this.terminate('Instance migration failed.', 1);
        }
    }
    async onReady() {
        try {
            if (await (0, migration_1.migrateLegacyInstances)(this)) {
                return;
            }
            if (this.common?.mode !== 'daemon') {
                this.terminate('Install or upgrade the adapter to migrate its instance configuration.', utils.EXIT_CODES.INVALID_ADAPTER_CONFIG);
                return;
            }
            await this.resetAvailability();
            if (this.abortController.signal.aborted) {
                return;
            }
            this.tokenStatus = new token_status_1.TokenStatus(this, accessToken => new api_client_1.EnergyTrackerClient({ accessToken, timeout: 10 }));
            if (!this.config.bearerToken) {
                this.log.warn('Missing bearer token in adapter configuration – waiting for configuration.');
                return;
            }
            const client = new api_client_1.EnergyTrackerClient({ accessToken: this.config.bearerToken, timeout: 10 });
            const budget = new request_budget_1.RequestBudget(this);
            await budget.restore();
            if (this.abortController.signal.aborted) {
                return;
            }
            this.deviceList = new device_list_1.DeviceList(this, client, budget);
            await this.scheduleSubmission(client, budget);
            const reader = new data_reader_1.DataReader(this, client, budget);
            const readDevices = Array.isArray(this.config.readDevices) ? this.config.readDevices : [];
            await reader.configure(readDevices);
            await this.pollCalculations(reader, budget, readDevices);
        }
        catch (error) {
            if (!this.abortController.signal.aborted) {
                this.readResult = false;
                this.log.error(`Unable to initialize or retrieve Energy Tracker data: ${String(error)}`);
                await this.publishConnection().catch(() => undefined);
            }
        }
    }
    async onMessage(message) {
        if (!message.callback ||
            !['getTokenInfo', 'checkToken', 'getDevices', 'getTimeZones'].includes(message.command)) {
            return;
        }
        let response;
        try {
            if (message.command === 'getTimeZones') {
                response = (0, time_zone_options_1.timeZoneOptions)(this.language, message.message?.timeZone);
            }
            else if (message.command === 'getDevices') {
                response =
                    this.config.bearerToken &&
                        (await this.tokenStatus?.allowsDeviceListing(this.config.bearerToken, this.abortController.signal))
                        ? ((await this.deviceList?.get(this.abortController.signal)) ?? [])
                        : [];
            }
            else {
                const payload = message.message;
                const supplied = payload && typeof payload === 'object' && 'token' in payload;
                const credential = supplied ? (0, token_input_1.accessTokenInput)(payload.token) : this.config.bearerToken;
                response = !credential
                    ? { error: 'tokenCheckFormat' }
                    : this.tokenStatus
                        ? await this.tokenStatus.get(credential, this.abortController.signal)
                        : { error: 'tokenCheckUnavailable' };
            }
        }
        catch {
            response = ['getDevices', 'getTimeZones'].includes(message.command)
                ? []
                : { error: 'tokenCheckUnavailable' };
            this.log.warn('Unable to process the configuration request.');
        }
        this.sendTo(message.from, message.command, response, message.callback);
    }
    async resetAvailability() {
        await this.setStateAsync('info.connection', { val: false, ack: true });
        await this.setStateAsync('info.sending.available', { val: false, ack: true });
        await this.setStateAsync('info.sending.nextRun', { val: null, ack: true });
        await this.setStateAsync('info.polling.effectiveInterval', { val: 0, ack: true });
        for (const id of Object.keys(await this.getStatesAsync('devices.*.available'))) {
            await this.setStateAsync(id, { val: false, ack: true });
        }
    }
    async scheduleSubmission(client, budget) {
        const devices = Array.isArray(this.config.devices)
            ? this.config.devices.filter(device => device?.deviceId || device?.sourceState)
            : [];
        if (this.config.sendEnabled && devices.length > 0) {
            const schedule = this.config.sendSchedule ?? migration_1.DEFAULT_SEND_SCHEDULE;
            this.sendJob =
                (0, submission_schedule_1.submissionSchedule)(schedule, async () => {
                    await this.submitReadings(client, budget, devices);
                    if (!this.abortController.signal.aborted) {
                        await this.publishNextSubmission();
                    }
                }) ?? undefined;
            if (this.sendJob) {
                this.sendJob.on('error', error => this.log.error(`Reading submission job failed: ${String(error)}`));
                await this.publishNextSubmission();
                this.log.info(`Reading submission scheduled: ${schedule}`);
            }
            else {
                this.sendResult = false;
                this.log.error('Invalid reading submission CRON schedule – sending is disabled.');
            }
        }
    }
    async pollCalculations(reader, budget, devices) {
        if (devices.length === 0) {
            this.log.info('Calculation retrieval is disabled.');
            return;
        }
        const interval = (0, request_budget_1.pollingInterval)(this.config.pollInterval ?? 60, devices);
        const options = {
            timeZone: this.config.timeZone?.trim() ?? '',
            signal: this.abortController.signal,
        };
        this.log.info(`Retrieving calculations with a ${interval} second pause between completed cycles.`);
        let failures = 0;
        do {
            const results = [];
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
            const pause = Math.max(interval, Math.min(interval * 2 ** failures, 900), (budget.nextAllowedAt - Date.now()) / 1000);
            await this.setStateAsync('info.polling.effectiveInterval', { val: pause, ack: true });
            await (0, promises_1.setTimeout)(pause * 1000, undefined, { signal: this.abortController.signal });
        } while (!this.abortController.signal.aborted);
    }
    async submitReadings(client, budget, devices) {
        const signal = this.abortController.signal;
        if (signal.aborted || this.sending) {
            return;
        }
        this.sending = true;
        try {
            const api = new energy_tracker_api_1.EnergyTrackerApi(this, client, budget);
            const results = [];
            for (const device of devices) {
                if (signal.aborted) {
                    return;
                }
                if (!device?.deviceId || !device.sourceState) {
                    this.log.warn('Device config incomplete – skipping reading submission.');
                    results.push(false);
                }
                else {
                    results.push(await api.sendReading(device, signal));
                }
            }
            if (!signal.aborted) {
                this.sendResult = results.length > 0 && results.every(Boolean);
                await this.setStateAsync('info.sending.available', { val: this.sendResult, ack: true });
                await this.setStateAsync('info.sending.lastRun', { val: Date.now(), ack: true });
                await this.publishConnection();
            }
        }
        catch (error) {
            if (!signal.aborted) {
                this.sendResult = false;
                await this.setStateAsync('info.sending.available', { val: false, ack: true });
                await this.publishConnection();
                this.log.error(`Unable to submit Energy Tracker readings: ${String(error)}`);
            }
        }
        finally {
            this.sending = false;
        }
    }
    async publishConnection() {
        const results = [this.readResult, this.sendResult].filter(result => result !== undefined);
        await this.setStateAsync('info.connection', { val: results.length > 0 && results.every(Boolean), ack: true });
    }
    async publishNextSubmission() {
        await this.setStateAsync('info.sending.nextRun', {
            val: this.sendJob?.nextInvocation()?.getTime() ?? null,
            ack: true,
        });
    }
}
if (require.main !== module) {
    module.exports = (options) => new EnergyTracker(options);
}
else {
    (() => new EnergyTracker())();
}
