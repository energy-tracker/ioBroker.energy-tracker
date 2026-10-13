"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RequestBudget = void 0;
exports.pollingInterval = pollingInterval;
const promises_1 = require("node:timers/promises");
const supportedIntervals = [60, 120, 300, 900, 3600];
class RequestBudget {
    adapter;
    nextRequestAt = 0;
    pending = Promise.resolve();
    nextAllowedAt = 0;
    constructor(adapter) {
        this.adapter = adapter;
    }
    async restore() {
        const request = await this.adapter.getStateAsync('info.polling.nextRequestAt');
        const cooldown = await this.adapter.getStateAsync('info.polling.nextAllowedAt');
        this.nextRequestAt = typeof request?.val === 'number' && Number.isFinite(request.val) ? request.val : 0;
        this.nextAllowedAt = typeof cooldown?.val === 'number' && Number.isFinite(cooldown.val) ? cooldown.val : 0;
    }
    get available() {
        return this.nextAllowedAt <= Date.now();
    }
    async acquire(signal) {
        const reservation = this.pending.then(async () => {
            signal?.throwIfAborted();
            let wait;
            while ((wait = Math.max(this.nextRequestAt, this.nextAllowedAt) - Date.now()) > 0) {
                await (0, promises_1.setTimeout)(wait, undefined, { signal });
                signal?.throwIfAborted();
            }
            signal?.throwIfAborted();
            this.nextRequestAt = Date.now() + 5000;
            await this.adapter.setStateAsync('info.polling.nextRequestAt', { val: this.nextRequestAt, ack: true });
        });
        this.pending = reservation.catch(() => undefined);
        await reservation;
    }
    async defer(retryAfter) {
        this.nextAllowedAt = Math.max(this.nextAllowedAt, Date.now() + (Math.max(1, retryAfter ?? 300) + 1) * 1000);
        await this.adapter.setStateAsync('info.polling.nextAllowedAt', { val: this.nextAllowedAt, ack: true });
    }
}
exports.RequestBudget = RequestBudget;
function pollingInterval(selected, devices) {
    if (!supportedIntervals.includes(selected)) {
        throw new Error('Polling interval must be 60, 120, 300, 900 or 3600 seconds');
    }
    return Math.max(selected, devices.length * 5);
}
