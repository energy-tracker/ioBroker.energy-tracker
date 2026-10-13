"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TokenStatus = void 0;
const api_client_1 = require("@energy-tracker/api-client");
class TokenStatus {
    adapter;
    client;
    information;
    nextCheckAt = 0;
    restoration;
    pending;
    constructor(adapter, client) {
        this.adapter = adapter;
        this.client = client;
    }
    get(credential, signal) {
        if (this.pending) {
            return this.pending.credential === credential
                ? this.pending.result
                : this.pending.result.then(() => this.get(credential, signal));
        }
        const result = this.query(credential, signal).finally(() => {
            this.pending = undefined;
        });
        this.pending = { credential, result };
        return result;
    }
    async allowsDeviceListing(credential, signal) {
        const information = !this.pending && this.information?.credential === credential
            ? this.information.result
            : await this.get(credential, signal);
        const token = information.token;
        return (information.status === 'valid' &&
            !!token &&
            (token.expiresAt === null || Date.parse(token.expiresAt) > Date.now()) &&
            token.scopes.some(scope => scope === api_client_1.TokenScope.READ_MEASURING_DEVICE || scope === api_client_1.TokenScope.MEASURING_DEVICE));
    }
    async restore() {
        const state = await this.adapter.getStateAsync('info.tokenCheckNextRequestAt');
        this.nextCheckAt = typeof state?.val === 'number' && Number.isFinite(state.val) ? state.val : 0;
    }
    async query(credential, signal) {
        this.restoration ??= this.restore();
        await this.restoration;
        if (signal?.aborted) {
            return { status: 'unknown', token: null, nextCheckAt: this.nextCheckAt, error: 'tokenCheckUnavailable' };
        }
        if (this.nextCheckAt > Date.now()) {
            return ((this.information?.credential === credential ? this.information.result : undefined) ?? {
                status: 'unknown',
                token: null,
                nextCheckAt: this.nextCheckAt,
                error: 'tokenCheckWait',
            });
        }
        await this.reserve(Date.now() + 61_000);
        if (signal?.aborted) {
            return { status: 'unknown', token: null, nextCheckAt: this.nextCheckAt, error: 'tokenCheckUnavailable' };
        }
        let information;
        try {
            const token = await this.client(credential).token.status({ signal });
            information = {
                status: 'valid',
                token: { ...token, expiresAt: token.expiresAt?.toISOString() ?? null },
                nextCheckAt: this.nextCheckAt,
            };
        }
        catch (error) {
            if (signal?.aborted) {
                return {
                    status: 'unknown',
                    token: null,
                    nextCheckAt: this.nextCheckAt,
                    error: 'tokenCheckUnavailable',
                };
            }
            const status = error instanceof api_client_1.AuthenticationError
                ? 'invalid'
                : error instanceof api_client_1.ForbiddenError
                    ? 'blocked'
                    : 'error';
            let message = status === 'error' ? 'tokenCheckUnavailable' : undefined;
            if (error instanceof api_client_1.RateLimitError) {
                await this.reserve(Math.max(this.nextCheckAt, Date.now() + (Math.max(1, error.retryAfter ?? 300) + 1) * 1000));
                message = 'tokenCheckWait';
            }
            information = { status, token: null, nextCheckAt: this.nextCheckAt, error: message };
            this.adapter.log.warn(`Token check failed (${status}).`);
        }
        if (signal?.aborted) {
            return { status: 'unknown', token: null, nextCheckAt: this.nextCheckAt, error: 'tokenCheckUnavailable' };
        }
        this.information = { credential, result: information };
        return information;
    }
    async reserve(deadline) {
        this.nextCheckAt = deadline;
        await this.adapter.setStateAsync('info.tokenCheckNextRequestAt', { val: deadline, ack: true });
    }
}
exports.TokenStatus = TokenStatus;
