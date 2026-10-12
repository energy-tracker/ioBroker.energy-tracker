import { expect } from 'chai';
import sinon from 'sinon';
import { createHash } from 'node:crypto';
import { checkToken, ensureTokenObjects, loadTokenInfo, type TokenContext } from '../src-admin/token-info';

const namespace = 'energy-tracker.0';
const cacheId = `${namespace}.info.token.cache`;
const waitId = `${namespace}.info.token.nextAllowedAt`;
const metadata = {
    displayName: 'ioBroker',
    scopes: ['write:meter-reading', 'future:scope'],
    expiresAt: '2030-01-01T00:00:00Z',
};

describe('Explicit Admin token information', () => {
    let states: Map<string, ioBroker.StateValue>;
    let context: TokenContext;
    let fetchMock: sinon.SinonStub;
    let clock: sinon.SinonFakeTimers;
    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: Date.parse('2026-10-12T12:00:00Z'), toFake: ['Date'] });
        states = new Map();
        context = {
            namespace,
            token: 'test-token',
            fingerprint: createHash('sha256').update('test-token').digest('hex'),
            signal: new AbortController().signal,
            socket: {
                getState: id =>
                    Promise.resolve(states.has(id) ? ({ val: states.get(id), ack: true } as ioBroker.State) : null),
                setState: (id, state) => {
                    states.set(id, state.val);
                    return Promise.resolve();
                },
                getObject: sinon.stub().resolves(null),
                setObject: sinon.stub().resolves(),
                subscribeState: sinon.stub().resolves(),
                unsubscribeState: sinon.stub(),
            },
        };
        fetchMock = sinon.stub(globalThis, 'fetch').callsFake(() => Promise.resolve(Response.json(metadata)));
    });
    afterEach(() => sinon.restore());

    it('uses the SDK GET and stores its complete DTO without credentials or other API calls', async () => {
        // Arrange
        const expectedExpiry = new Date(metadata.expiresAt);
        // Act
        const result = await checkToken(context);
        const stored = await loadTokenInfo(context);
        // Assert
        expect(fetchMock).to.have.been.calledOnce;
        expect(String(fetchMock.firstCall.args[0])).to.equal(
            'https://public-api.energy-tracker.best-ios-apps.de/v1/token/status',
        );
        expect(fetchMock.firstCall.args[1]).to.include({ method: 'GET', credentials: 'omit', redirect: 'error' });
        expect(fetchMock.firstCall.args[1].headers).to.deep.equal({ Authorization: 'Bearer test-token' });
        expect(result.info?.token).to.deep.equal({ ...metadata, expiresAt: expectedExpiry });
        expect(stored.info?.token).to.deep.equal(result.info?.token);
        expect(result.nextAllowedAt).to.equal(Date.now() + 61_000);
        expect([...states.keys()]).to.have.members([cacheId, waitId]);
        expect(String(states.get(cacheId))).not.to.include('"test-token"');
    });

    it('loads an existing result without another request, and hides it after a token change', async () => {
        // Arrange
        await checkToken(context);
        // Act
        const cached = await loadTokenInfo(context);
        const changed = await loadTokenInfo({ ...context, fingerprint: 'another-hash' });
        // Assert
        expect(cached.info?.status).to.equal('valid');
        expect(changed.info).to.equal(null);
        expect(changed.nextAllowedAt).to.equal(cached.nextAllowedAt);
        expect(fetchMock).to.have.been.calledOnce;
    });

    it('respects the saved wait across reloads and token changes', async () => {
        // Arrange
        await checkToken(context);
        // Act
        const same = await checkToken(context);
        const changed = await checkToken({ ...context, token: 'another-token', fingerprint: 'another-hash' });
        // Assert
        expect(same.info?.status).to.equal('valid');
        expect(changed.info).to.equal(null);
        expect(changed.nextAllowedAt).to.equal(same.nextAllowedAt);
        expect(fetchMock).to.have.been.calledOnce;
    });

    it('makes another request only on an explicit check after the wait', async () => {
        // Arrange
        await checkToken(context);
        fetchMock.onSecondCall().resolves(Response.json({ ...metadata, scopes: [], expiresAt: null }));
        // Act
        clock.setSystemTime(Date.now() + 61_000);
        const beforeClick = await loadTokenInfo(context);
        const result = await checkToken(context);
        // Assert
        expect(beforeClick.info?.token?.scopes).to.deep.equal(metadata.scopes);
        expect(result.info?.token?.scopes).to.deep.equal([]);
        expect(result.info?.token?.expiresAt).to.equal(null);
        expect(fetchMock).to.have.been.calledTwice;
    });

    for (const [httpStatus, status] of [
        [401, 'invalid'],
        [403, 'blocked'],
        [503, 'unknown'],
    ] as const) {
        it(`records HTTP ${httpStatus} and waits without automatic retries`, async () => {
            // Arrange
            fetchMock.resolves(Response.json({}, { status: httpStatus }));
            // Act
            const result = await checkToken(context);
            clock.setSystemTime(result.nextAllowedAt + 1);
            const cached = await loadTokenInfo(context);
            // Assert
            expect(result.info?.status).to.equal(status);
            expect(result.info?.token).to.equal(null);
            expect(result.nextAllowedAt).to.equal(result.info!.checkedAt + 301_000);
            expect(cached.info?.status).to.equal(status);
            expect(fetchMock).to.have.been.calledOnce;
        });
    }

    it('persists a longer server Retry-After and cannot bypass it by changing the token', async () => {
        // Arrange
        fetchMock.resolves(Response.json({}, { status: 429, headers: { 'Retry-After': '600' } }));
        // Act
        const result = await checkToken(context);
        await checkToken({ ...context, fingerprint: 'another-hash' });
        // Assert
        expect(result.nextAllowedAt).to.equal(Date.now() + 601_000);
        expect(states.get(waitId)).to.equal(result.nextAllowedAt);
        expect(fetchMock).to.have.been.calledOnce;
    });

    it('does not publish a cancelled response', async () => {
        // Arrange
        const abort = new AbortController();
        fetchMock.callsFake(() => {
            abort.abort();
            return Promise.resolve(Response.json(metadata));
        });
        // Act
        await checkToken({ ...context, signal: abort.signal });
        // Assert
        expect(states.has(cacheId)).to.equal(false);
        expect(states.get(waitId)).to.equal(Date.now() + 61_000);
    });

    it('does not call the API if persisting the allowance fails', async () => {
        // Arrange
        context.socket.setState = sinon.stub().rejects(new Error('Storage unavailable'));
        let failure: unknown;
        // Act
        try {
            await checkToken(context);
        } catch (error) {
            failure = error;
        }
        // Assert
        expect(failure).to.be.instanceOf(Error);
        expect(fetchMock).not.to.have.been.called;
    });

    it('creates only missing token diagnostic objects without changing the instance', async () => {
        // Arrange
        const existing = new Set([`${namespace}.info.token`]);
        context.socket.getObject = sinon.stub().callsFake(id => Promise.resolve(existing.has(id) ? {} : null));
        const setObject = context.socket.setObject as sinon.SinonStub;
        // Act
        await ensureTokenObjects(context);
        // Assert
        expect(setObject.getCalls().map(call => call.args[0])).to.have.members([cacheId, waitId]);
        expect(fetchMock).not.to.have.been.called;
    });

    it('shows damaged cached JSON as unknown without querying the API', async () => {
        // Arrange
        states.set(cacheId, '{broken');
        // Act
        const result = await loadTokenInfo(context);
        // Assert
        expect(result.info).to.equal(null);
        expect(fetchMock).not.to.have.been.called;
    });
});
