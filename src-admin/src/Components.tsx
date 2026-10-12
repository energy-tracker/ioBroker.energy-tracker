import { React, Button, I18n, InfoBox } from '../host';
import {
    checkToken,
    loadTokenInfo,
    type TokenContext,
    type TokenInfo as SavedTokenInfo,
    type TokenSocket,
} from '../token-info';

/** JSONConfig context used by the token information control. */
export interface TokenInfoProps {
    /** Block checks until configuration changes have been saved. */
    changed: boolean;
    /** Respect an explicitly disabled configuration control. */
    disabled?: boolean;
    /** Decrypted credentials supplied by Admin. */
    data: { bearerToken?: string };
    /** Authenticated Admin connection and instance identity. */
    oContext: { adapterName: string; instance: number; socket: TokenSocket };
}

/**
 * @param props Saved configuration and Admin connection
 * @returns Last known token information and an immediate, token-only check action
 */
export function TokenInfo(props: TokenInfoProps): JSX.Element {
    const { useState, useEffect, useRef } = React;
    const [info, setInfo] = useState<SavedTokenInfo | null>(null);
    const [nextAllowedAt, setNextAllowedAt] = useState(0);
    const [clock, setClock] = useState(Date.now());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState(false);
    const context = useRef<TokenContext | null>(null);
    const inFlight = useRef(false);
    const loadVersion = useRef(0);
    const { socket, adapterName, instance } = props.oContext;
    const namespace = `${adapterName}.${instance}`;
    const token = props.data.bearerToken ?? '';
    const apply = (snapshot: { info: SavedTokenInfo | null; nextAllowedAt: number }): void => {
        setInfo(snapshot.info);
        setNextAllowedAt(snapshot.nextAllowedAt);
        setClock(Date.now());
    };

    useEffect(() => {
        const abort = new AbortController();
        const saved = {
            socket,
            namespace,
            token,
            fingerprint: token ? window.CryptoJS.SHA256(token).toString() : '',
            signal: abort.signal,
        };
        context.current = saved;
        inFlight.current = false;
        setInfo(null);
        setBusy(false);
        setError(false);
        setNextAllowedAt(0);
        const ids = [`${namespace}.info.token.cache`, `${namespace}.info.token.nextAllowedAt`];
        const refresh = (): void => {
            const version = ++loadVersion.current;
            void loadTokenInfo(saved)
                .then(result => !abort.signal.aborted && version === loadVersion.current && apply(result))
                .catch(() => !abort.signal.aborted && setError(true));
        };
        if (token && !props.changed) {
            refresh();
            void socket
                .subscribeState(ids, refresh)
                .then(() => {
                    if (abort.signal.aborted) {
                        socket.unsubscribeState(ids, refresh);
                    }
                })
                .catch(() => !abort.signal.aborted && setError(true));
        }
        return () => {
            abort.abort();
            socket.unsubscribeState(ids, refresh);
        };
    }, [socket, namespace, token, props.changed]);

    const expiry = info?.token?.expiresAt?.getTime() ?? 0;
    useEffect(() => {
        const deadlines = [nextAllowedAt, expiry].filter(time => time > Date.now());
        if (!deadlines.length) {
            return;
        }
        // Update the local display only; no API polling or automatic retries.
        const timer = setTimeout(
            () => setClock(Date.now()),
            Math.min(Math.min(...deadlines) - Date.now(), 2_147_483_647),
        );
        return () => clearTimeout(timer);
    }, [nextAllowedAt, expiry, clock]);

    const check = async (): Promise<void> => {
        const saved = context.current;
        if (!saved || saved.signal.aborted || props.changed || !token || inFlight.current) {
            return;
        }
        inFlight.current = true;
        setBusy(true);
        setError(false);
        try {
            const result = await checkToken(saved);
            if (!saved.signal.aborted) {
                loadVersion.current++;
                apply(result);
                setError(result.info?.status === 'unknown');
            }
        } catch {
            if (!saved.signal.aborted) {
                setError(true);
            }
        } finally {
            if (!saved.signal.aborted) {
                inFlight.current = false;
                setBusy(false);
            }
        }
    };
    const status = info?.status === 'valid' && expiry && expiry <= clock ? 'invalid' : (info?.status ?? 'unknown');
    const labels = { valid: 'tokenValid', invalid: 'tokenInvalid', blocked: 'tokenBlocked', unknown: 'tokenUnknown' };
    const date = (value: Date | number): string =>
        new Date(typeof value === 'number' ? value : value.getTime())
            .toISOString()
            .replace('T', ' ')
            .replace(/\.\d{3}Z$/, ' UTC');
    return (
        <div style={{ width: '100%' }}>
            <InfoBox type="info">
                <span style={{ display: 'block' }}>
                    <b>{I18n.t('infoTokenStatus')}:</b> {I18n.t(labels[status])}
                </span>
                <span style={{ display: 'block' }}>
                    <b>{I18n.t('infoTokenExpiry')}:</b>{' '}
                    {info?.token
                        ? info.token.expiresAt
                            ? date(info.token.expiresAt)
                            : I18n.t('tokenNoExpiry')
                        : I18n.t('tokenUnknown')}
                </span>
                <span style={{ display: 'block' }}>
                    <b>{I18n.t('infoTokenPermissions')}:</b>{' '}
                    {info?.token
                        ? info.token.scopes.join(', ') || I18n.t('tokenNoPermissions')
                        : I18n.t('tokenUnknown')}
                </span>
            </InfoBox>
            <Button
                variant="contained"
                disabled={busy || props.changed || !token || nextAllowedAt > clock || props.disabled}
                onClick={() => void check()}
            >
                {I18n.t(busy ? 'tokenCheckRunning' : 'labelTokenRecheck')}
            </Button>
            <p>{I18n.t('helpTokenRecheck')}</p>
            {props.changed ? <p>{I18n.t('tokenCheckSaveFirst')}</p> : null}
            {nextAllowedAt > clock ? <p>{I18n.t('tokenCheckWait', date(nextAllowedAt))}</p> : null}
            {error ? <p>{I18n.t('tokenCheckUnavailable')}</p> : null}
        </div>
    );
}
