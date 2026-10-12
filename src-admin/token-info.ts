import {
    EnergyTrackerClient,
    AuthenticationError,
    ForbiddenError,
    RateLimitError,
    type TokenStatusDto,
} from '@energy-tracker/api-client';
import ioPackage from '../io-package.json';

/** The SDK DTO plus the identity and outcome of its last explicit check. */
export interface TokenInfo {
    /** SHA-256 of the saved token, never the credentials themselves. */
    fingerprint: string;
    /** Result of the last explicit request. */
    status: 'valid' | 'invalid' | 'blocked' | 'unknown';
    /** Check time in Unix milliseconds. */
    checkedAt: number;
    /** Unmodified SDK result, or null when the request failed. */
    token: TokenStatusDto | null;
}

/** ioBroker Admin operations required for token information. */
export interface TokenSocket {
    /** Read the saved result or API deadline. */
    getState(id: string): Promise<ioBroker.State | null | undefined>;
    /** Save metadata without starting the adapter. */
    setState(id: string, state: { val: ioBroker.StateValue; ack: boolean }): Promise<unknown>;
    /** Look up the diagnostic object after an upgrade. */
    getObject(id: string): Promise<ioBroker.Object | null | undefined>;
    /** Create a diagnostic object if the scheduled adapter has not run yet. */
    setObject(id: string, object: ioBroker.SettableObject): Promise<unknown>;
    /** Receive local diagnostic changes; this does not query the public API. */
    subscribeState(id: string[], callback: ioBroker.StateChangeHandler): Promise<void>;
    /** Stop receiving local changes when the configuration closes. */
    unsubscribeState(id: string[], callback: ioBroker.StateChangeHandler): void;
}

/** Saved credentials and authenticated Admin connection. */
export interface TokenContext {
    /** Authenticated Admin connection. */
    socket: TokenSocket;
    /** Instance storing the information. */
    namespace: string;
    /** Saved, decrypted credentials. */
    token: string;
    /** Token identity used to hide stale information. */
    fingerprint: string;
    /** Cancellation on configuration changes or close. */
    signal: AbortSignal;
}

/**
 * Read local metadata, hiding results for a different saved token.
 *
 * @param context Saved token and Admin connection
 * @returns Last result and the persisted API deadline
 */
export async function loadTokenInfo(context: TokenContext): Promise<{ info: TokenInfo | null; nextAllowedAt: number }> {
    const [state, wait] = await Promise.all([
        context.socket.getState(`${context.namespace}.info.token.cache`),
        context.socket.getState(`${context.namespace}.info.token.nextAllowedAt`),
    ]);
    let info: TokenInfo | null = null;
    try {
        const saved = JSON.parse(typeof state?.val === 'string' ? state.val : 'null', (key, value: unknown) =>
            key === 'expiresAt' && typeof value === 'string' ? new Date(value) : value,
        ) as TokenInfo | null;
        if (
            saved?.fingerprint === context.fingerprint &&
            ['valid', 'invalid', 'blocked', 'unknown'].includes(saved.status)
        ) {
            info = saved;
        }
    } catch {
        // Missing or damaged metadata is shown as unknown until an explicit check.
    }
    return { info, nextAllowedAt: typeof wait?.val === 'number' && Number.isFinite(wait.val) ? wait.val : 0 };
}

/**
 * @param context Saved token and Admin connection
 */
export async function ensureTokenObjects(context: TokenContext): Promise<void> {
    for (const definition of ioPackage.instanceObjects) {
        if (
            !['info.token', 'info.token.cache', 'info.token.nextAllowedAt'].includes(definition._id) ||
            context.signal.aborted
        ) {
            continue;
        }
        const id = `${context.namespace}.${definition._id}`;
        if (!(await context.socket.getObject(id)) && !context.signal.aborted) {
            const { _id: _local, ...object } = definition;
            await context.socket.setObject(id, object as ioBroker.SettableObject);
        }
    }
}

/**
 * Check only the token through the SDK; never start an adapter or submit readings.
 *
 * @param context Saved token and Admin connection
 * @returns Updated information, or the existing result during an API wait
 */
export async function checkToken(context: TokenContext): Promise<{ info: TokenInfo | null; nextAllowedAt: number }> {
    const current = await loadTokenInfo(context);
    if (context.signal.aborted || current.nextAllowedAt > Date.now()) {
        return current;
    }
    await ensureTokenObjects(context);
    if (context.signal.aborted) {
        return current;
    }
    const checkedAt = Date.now();
    // One minute plus a margin keeps repeated clicks below five requests per five minutes.
    let nextAllowedAt = checkedAt + 61_000;
    const saveWait = (): Promise<unknown> =>
        context.socket.setState(`${context.namespace}.info.token.nextAllowedAt`, { val: nextAllowedAt, ack: true });
    await saveWait();
    if (context.signal.aborted) {
        return current;
    }
    const info: TokenInfo = { fingerprint: context.fingerprint, checkedAt, status: 'valid', token: null };
    try {
        const client = new EnergyTrackerClient({
            accessToken: context.token,
            timeout: 10,
            fetch: (url, init) => fetch(url, { ...init, credentials: 'omit', redirect: 'error' }),
        });
        info.token = await client.token.status({ signal: context.signal });
    } catch (error) {
        if (context.signal.aborted) {
            return current;
        }
        info.status =
            error instanceof AuthenticationError ? 'invalid' : error instanceof ForbiddenError ? 'blocked' : 'unknown';
        nextAllowedAt =
            Date.now() + (Math.max(300, error instanceof RateLimitError ? (error.retryAfter ?? 300) : 300) + 1) * 1000;
        await saveWait();
    }
    if (!context.signal.aborted) {
        await context.socket.setState(`${context.namespace}.info.token.cache`, {
            val: JSON.stringify(info),
            ack: true,
        });
    }
    return { info, nextAllowedAt };
}
