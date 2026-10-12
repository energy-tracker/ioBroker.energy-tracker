import {
    AuthenticationError,
    ForbiddenError,
    RateLimitError,
    TokenScope,
    type EnergyTrackerClient,
    type TokenStatusDto,
} from '@energy-tracker/api-client';

/** Token metadata sent to the Admin view; dates use the message transport's ISO format. */
export interface TokenInformation {
    /** Result of the most recent live check in this process. */
    status: 'unknown' | 'valid' | 'invalid' | 'blocked' | 'error';
    /** SDK metadata, kept only in memory. */
    token: (Omit<TokenStatusDto, 'expiresAt'> & { expiresAt: string | null }) | null;
    /** Earliest allowed request, including server cooldowns. */
    nextCheckAt: number;
    /** Message key for an unavailable check. */
    error?: string;
}

/** Queries token information only for configuration requests. */
export class TokenStatus {
    private information?: { credential: string; result: TokenInformation };
    private nextCheckAt = 0;
    private restoration?: Promise<void>;
    private pending?: { credential: string; result: Promise<TokenInformation> };

    /**
     * @param adapter Stores only the API request allowance, never token metadata
     * @param client Creates an SDK client for the supplied credential
     */
    constructor(
        private readonly adapter: ioBroker.Adapter,
        private readonly client: (accessToken: string) => Pick<EnergyTrackerClient, 'token'>,
    ) {}

    /**
     * @param credential Saved or draft credential, used only for this check
     * @param signal Cancellation on adapter unload
     * @returns Live information, or the in-memory result while the API requires waiting
     */
    get(credential: string, signal?: AbortSignal): Promise<TokenInformation> {
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

    /**
     * @param credential Saved credential used by the device-list client
     * @param signal Cancellation on adapter unload
     * @returns Whether the token checked for this configuration view permits listing devices
     */
    async allowsDeviceListing(credential: string, signal?: AbortSignal): Promise<boolean> {
        const information =
            !this.pending && this.information?.credential === credential
                ? this.information.result
                : await this.get(credential, signal);
        const token = information.token;
        return (
            information.status === 'valid' &&
            !!token &&
            (token.expiresAt === null || Date.parse(token.expiresAt) > Date.now()) &&
            token.scopes.some(
                scope => scope === TokenScope.READ_MEASURING_DEVICE || scope === TokenScope.MEASURING_DEVICE,
            )
        );
    }

    private async restore(): Promise<void> {
        const state = await this.adapter.getStateAsync('info.tokenCheckNextRequestAt');
        this.nextCheckAt = typeof state?.val === 'number' && Number.isFinite(state.val) ? state.val : 0;
    }

    private async query(credential: string, signal?: AbortSignal): Promise<TokenInformation> {
        this.restoration ??= this.restore();
        await this.restoration;
        if (signal?.aborted) {
            return { status: 'unknown', token: null, nextCheckAt: this.nextCheckAt, error: 'tokenCheckUnavailable' };
        }
        if (this.nextCheckAt > Date.now()) {
            return (
                (this.information?.credential === credential ? this.information.result : undefined) ?? {
                    status: 'unknown',
                    token: null,
                    nextCheckAt: this.nextCheckAt,
                    error: 'tokenCheckWait',
                }
            );
        }
        // At most five requests per five minutes, also after restarts or token changes.
        await this.reserve(Date.now() + 61_000);
        if (signal?.aborted) {
            return { status: 'unknown', token: null, nextCheckAt: this.nextCheckAt, error: 'tokenCheckUnavailable' };
        }
        let information: TokenInformation;
        try {
            const token = await this.client(credential).token.status({ signal });
            information = {
                status: 'valid',
                token: { ...token, expiresAt: token.expiresAt?.toISOString() ?? null },
                nextCheckAt: this.nextCheckAt,
            };
        } catch (error) {
            if (signal?.aborted) {
                return {
                    status: 'unknown',
                    token: null,
                    nextCheckAt: this.nextCheckAt,
                    error: 'tokenCheckUnavailable',
                };
            }
            const status =
                error instanceof AuthenticationError
                    ? 'invalid'
                    : error instanceof ForbiddenError
                      ? 'blocked'
                      : 'error';
            let message = status === 'error' ? 'tokenCheckUnavailable' : undefined;
            if (error instanceof RateLimitError) {
                await this.reserve(
                    Math.max(this.nextCheckAt, Date.now() + (Math.max(1, error.retryAfter ?? 300) + 1) * 1000),
                );
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

    private async reserve(deadline: number): Promise<void> {
        this.nextCheckAt = deadline;
        await this.adapter.setStateAsync('info.tokenCheckNextRequestAt', { val: deadline, ack: true });
    }
}
