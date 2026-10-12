import { accessTokenInput } from '../src/lib/token-input';
import type { TokenInformation } from '../src/lib/token-status';

/** Ephemeral state of one token hint. */
export interface TokenCheckView {
    /** Metadata received for this credential only. */
    info: TokenInformation | null;
    /** Debounce or a configuration request is in progress. */
    busy: boolean;
    /** The shared API allowance prevents another request. */
    waiting: boolean;
}

/** One configuration-view check, debounced while entering a credential. */
export class TokenCheck {
    private timer?: ReturnType<typeof setTimeout>;
    private disposed = false;
    private pending = false;
    private view: TokenCheckView = { info: null, busy: false, waiting: false };

    /**
     * @param credential Credential being inspected; never saved by this control
     * @param send Configuration message transport
     * @param update Receives view-local state
     */
    constructor(
        private readonly credential: string,
        private readonly send: (
            command: 'getTokenInfo' | 'checkToken',
            token: string,
        ) => Promise<TokenInformation | { error: string }>,
        private readonly update: (view: TokenCheckView) => void,
    ) {}

    /** @param delay Debounce for draft input; zero when opening a saved configuration */
    start(delay: number): void {
        if (this.disposed || !accessTokenInput(this.credential)) {
            return;
        }
        this.publish({ ...this.view, busy: true });
        this.timer = setTimeout(() => void this.check('getTokenInfo'), delay);
    }

    /** @param command Automatic view check or explicit recheck */
    async check(command: 'getTokenInfo' | 'checkToken' = 'checkToken'): Promise<void> {
        if (this.disposed || this.pending || this.view.waiting || !accessTokenInput(this.credential)) {
            return;
        }
        clearTimeout(this.timer);
        this.pending = true;
        this.publish({ ...this.view, busy: true });
        let info: TokenInformation;
        try {
            const response = await this.send(command, this.credential);
            info =
                'status' in response
                    ? response
                    : { status: 'unknown', token: null, nextCheckAt: 0, error: response.error };
        } catch {
            info = { status: 'error', token: null, nextCheckAt: 0, error: 'tokenCheckUnavailable' };
        }
        this.pending = false;
        if (this.disposed) {
            return;
        }
        const wait = info.nextCheckAt - Date.now();
        this.publish({ info, busy: false, waiting: wait > 0 });
        if (wait > 0) {
            this.timer = setTimeout(
                () => {
                    this.publish({ ...this.view, waiting: false });
                    // Complete a deferred opening/input check once allowed; successful checks are never polled.
                    if (info.status === 'unknown' && info.error === 'tokenCheckWait') {
                        void this.check('getTokenInfo');
                    }
                },
                Math.min(wait + 1, 2_147_483_647),
            );
        }
    }

    /** Ignore late responses and cancel view-local timers when input changes or the view closes. */
    dispose(): void {
        this.disposed = true;
        clearTimeout(this.timer);
    }

    private publish(view: TokenCheckView): void {
        this.view = view;
        this.update(view);
    }
}
