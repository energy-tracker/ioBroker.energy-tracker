import { React, Material, I18n } from './host';
import { TokenCheck, type TokenCheckView } from './token-check';
import { accessTokenInput } from '../src/lib/token-input';
import type { TokenInformation } from '../src/lib/token-status';

interface Props {
    alive: boolean;
    disabled?: boolean;
    data: { bearerToken?: string };
    originalData?: { bearerToken?: string };
    oContext: {
        adapterName: string;
        instance: number;
        socket: {
            sendTo(instance: string, command: string, message: object): Promise<TokenInformation | { error: string }>;
        };
    };
}

/**
 * @param props Configuration view supplied by JSONConfig
 * @returns Live token hints below the credential field
 */
export function TokenInfo(props: Props): unknown {
    const empty: TokenCheckView = { info: null, busy: false, waiting: false };
    const [snapshot, setSnapshot] = React.useState({ credential: '', view: empty });
    const check = React.useRef<TokenCheck | null>(null);
    const token = accessTokenInput(props.data.bearerToken);
    const namespace = `${props.oContext.adapterName}.${props.oContext.instance}`;
    const available = props.alive && !props.disabled;
    React.useEffect(() => {
        setSnapshot({ credential: token ?? '', view: empty });
        if (!token || !available) {
            return;
        }
        const current = new TokenCheck(
            token,
            (command, credential) => props.oContext.socket.sendTo(namespace, command, { token: credential }),
            view => setSnapshot({ credential: token, view }),
        );
        check.current = current;
        current.start(token === props.originalData?.bearerToken?.trim() ? 0 : 500);
        return () => {
            current.dispose();
            check.current = null;
        };
    }, [namespace, token, available]);

    const h = React.createElement;
    const t = (key: string): string => I18n.t(key);
    const { info, busy, waiting } = snapshot.credential === token ? snapshot.view : empty;
    let hint = !token ? t('tokenCheckFormat') : !available ? t('tokenCheckUnavailable') : '';
    if (info?.token && token && available) {
        hint = [
            `${t('infoTokenName')}: ${info.token.displayName}`,
            `${t('infoTokenExpiry')}: ${
                info.token.expiresAt
                    ? new Date(info.token.expiresAt).toLocaleString(I18n.getLanguage(), { timeZone: 'UTC' })
                    : t('tokenNoExpiry')
            }`,
            `${t('infoTokenPermissions')}: ${info.token.scopes.join(', ') || t('tokenNoPermissions')}`,
        ].join('\n');
    } else if (info && token && available) {
        hint =
            info.error && info.error !== 'tokenCheckWait'
                ? t(info.error)
                : info.status === 'invalid'
                  ? t('tokenInvalid')
                  : info.status === 'blocked'
                    ? t('tokenBlocked')
                    : '';
    }
    return h(
        Material.Stack,
        { spacing: 0.5, sx: { width: '100%' } },
        h(
            Material.FormHelperText,
            {
                error: !!token && !!info && ['invalid', 'blocked', 'error'].includes(info.status),
                sx: { m: 0, whiteSpace: 'pre-line', overflowWrap: 'anywhere' },
            },
            busy && token && available ? t('tokenCheckRunning') : hint,
        ),
        waiting && token && available
            ? h(
                  Material.FormHelperText,
                  { sx: { m: 0 } },
                  I18n.t('tokenCheckWait', new Date(info!.nextCheckAt).toISOString()),
              )
            : null,
        token && available
            ? h(
                  Material.Button,
                  {
                      variant: 'text',
                      size: 'small',
                      disabled: busy || waiting,
                      onClick: () => void check.current?.check(),
                      sx: { alignSelf: 'flex-start', px: 0 },
                  },
                  t('labelTokenRecheck'),
              )
            : null,
    );
}
