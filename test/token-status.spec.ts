import { expect } from 'chai';
import sinon from 'sinon';
import 'sinon-chai';
import { AuthenticationError, EnergyTrackerClient, ForbiddenError, RateLimitError } from '@energy-tracker/api-client';
import { TokenStatus } from '../src/lib/token-status';
import { deferred, TEST_ACCESS_TOKEN } from './helpers';

describe('Live token information', () => {
    let adapter: sinon.SinonStubbedInstance<ioBroker.Adapter>;
    let status: sinon.SinonStub;
    let clock: sinon.SinonFakeTimers;
    let states: Map<string, ioBroker.StateValue>;
    const metadata = { displayName: 'ioBroker', scopes: ['read:daily-values', 'future:scope'], expiresAt: null };
    const create = (): TokenStatus =>
        new TokenStatus(adapter, () => ({ token: { status } }) as unknown as EnergyTrackerClient);

    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: Date.parse('2026-10-12T12:00:00Z'), toFake: ['Date'] });
        states = new Map();
        adapter = {
            getStateAsync: sinon.stub().callsFake((id: string) => Promise.resolve({ val: states.get(id) })),
            setStateAsync: sinon.stub().callsFake((id: string, state: ioBroker.SettableState) => {
                states.set(id, state.val ?? null);
                return Promise.resolve();
            }),
            log: { warn: sinon.stub() },
        } as unknown as sinon.SinonStubbedInstance<ioBroker.Adapter>;
        status = sinon.stub().resolves(metadata);
    });
    afterEach(() => sinon.restore());

    it('does not query the endpoint until a configuration request arrives', () => {
        // Arrange
        const service = create();

        // Act
        clock.tick(600_000);

        // Assert
        expect(service).to.be.instanceOf(TokenStatus);
        expect(status).not.to.have.been.called;
        expect(adapter.getStateAsync).not.to.have.been.called;
        expect(adapter.setStateAsync).not.to.have.been.called;
    });

    it('returns the live SDK metadata without storing status, expiry or permissions', async () => {
        // Arrange
        const fetch = sinon.stub().resolves(Response.json(metadata));
        const service = new TokenStatus(adapter, accessToken => new EnergyTrackerClient({ accessToken, fetch }));

        // Act
        const information = await service.get(TEST_ACCESS_TOKEN);

        // Assert
        expect(fetch).to.have.been.calledOnce;
        expect(String(fetch.firstCall.args[0])).to.contain('/v1/token/status');
        expect(fetch.firstCall.args[1].method).to.equal('GET');
        expect(information.status).to.equal('valid');
        expect(information.token).to.deep.equal(metadata);
        expect([...states.keys()]).to.deep.equal(['info.tokenCheckNextRequestAt']);
        expect([...states.values()]).to.deep.equal([Date.now() + 61_000]);
    });

    it('serializes SDK dates for the message transport', async () => {
        // Arrange
        status.resolves({ ...metadata, expiresAt: new Date('2026-12-01T00:00:00Z') });

        // Act
        const information = await create().get(TEST_ACCESS_TOKEN);

        // Assert
        expect(information.token?.expiresAt).to.equal('2026-12-01T00:00:00.000Z');
    });

    it('passes draft credentials to the SDK without persisting them', async () => {
        // Arrange
        const fetch = sinon.stub().resolves(Response.json(metadata));
        const client = sinon.stub().callsFake(accessToken => new EnergyTrackerClient({ accessToken, fetch }));
        const service = new TokenStatus(adapter, client);

        // Act
        await service.get(TEST_ACCESS_TOKEN);

        // Assert
        expect(client).to.have.been.calledOnceWith(TEST_ACCESS_TOKEN);
        expect(new Headers(fetch.firstCall.args[1].headers).get('authorization')).to.equal(
            `Bearer ${TEST_ACCESS_TOKEN}`,
        );
        expect([...states.keys()]).to.deep.equal(['info.tokenCheckNextRequestAt']);
    });

    it('shares the allowance across different draft tokens without returning another token’s metadata', async () => {
        // Arrange
        const service = create();
        await service.get(TEST_ACCESS_TOKEN);
        status.resetHistory();

        // Act
        const information = await service.get('another-draft-token');

        // Assert
        expect(status).not.to.have.been.called;
        expect(information.token).to.equal(null);
        expect(information.error).to.equal('tokenCheckWait');
        expect(information.nextCheckAt).to.equal(Date.now() + 61_000);
    });

    it('serializes simultaneous checks for different tokens into the shared request allowance', async () => {
        // Arrange
        const pending = deferred<typeof metadata>();
        status.returns(pending.promise);
        const service = create();
        const first = service.get(TEST_ACCESS_TOKEN);
        const second = service.get('another-draft-token');

        // Act
        pending.resolve(metadata);
        const results = await Promise.all([first, second]);

        // Assert
        expect(status).to.have.been.calledOnce;
        expect(results[0].token).to.deep.equal(metadata);
        expect(results[1].token).to.equal(null);
        expect(results[1].error).to.equal('tokenCheckWait');
    });

    it('reuses the in-memory response while the API requires waiting', async () => {
        // Arrange
        const service = create();
        const previous = await service.get(TEST_ACCESS_TOKEN);

        // Act
        const information = await service.get(TEST_ACCESS_TOKEN);

        // Assert
        expect(information).to.deep.equal(previous);
        expect(status).to.have.been.calledOnce;
    });

    it('fetches fresh information when the view requests it after the waiting time', async () => {
        // Arrange
        const service = create();
        await service.get(TEST_ACCESS_TOKEN);
        clock.tick(61_000);
        status.resolves({ ...metadata, scopes: ['write:meter-reading'] });

        // Act
        const information = await service.get(TEST_ACCESS_TOKEN);

        // Assert
        expect(status).to.have.been.calledTwice;
        expect(information.token?.scopes).to.deep.equal(['write:meter-reading']);
    });

    it('keeps the request allowance across restarts without restoring token metadata', async () => {
        // Arrange
        await create().get(TEST_ACCESS_TOKEN);
        status.resetHistory();

        // Act
        const information = await create().get(TEST_ACCESS_TOKEN);

        // Assert
        expect(status).not.to.have.been.called;
        expect(information.error).to.equal('tokenCheckWait');
        expect(information.token).to.equal(null);
        expect(information.nextCheckAt).to.equal(Date.now() + 61_000);
    });

    it('coalesces requests from the information view and device selector', async () => {
        // Arrange
        const pending = deferred<typeof metadata>();
        status.returns(pending.promise);
        const service = create();
        let ready = false;
        const info = service.get(TEST_ACCESS_TOKEN);
        const access = service.allowsDeviceListing(TEST_ACCESS_TOKEN).then(allowed => {
            ready = true;
            return allowed;
        });
        await new Promise(resolve => setImmediate(resolve));
        const readyBeforeCompletion = ready;

        // Act
        pending.resolve({ ...metadata, scopes: ['read:measuring-device'] });
        await info;
        const allowed = await access;

        // Assert
        expect(readyBeforeCompletion).to.equal(false);
        expect(allowed).to.equal(true);
        expect(status).to.have.been.calledOnce;
    });

    for (const [error, expected] of [
        [new AuthenticationError('secret must not be logged'), 'invalid'],
        [new ForbiddenError('secret must not be logged'), 'blocked'],
        [new Error('secret must not be logged'), 'error'],
    ] as const) {
        it(`reports ${expected} without retaining rejected metadata`, async () => {
            // Arrange
            const service = create();
            await service.get(TEST_ACCESS_TOKEN);
            clock.tick(61_000);
            status.rejects(error);

            // Act
            const information = await service.get(TEST_ACCESS_TOKEN);

            // Assert
            expect(information.status).to.equal(expected);
            expect(information.token).to.equal(null);
            expect(adapter.log.warn).not.to.have.been.calledWithMatch(sinon.match('secret'));
            expect([...states.keys()]).to.deep.equal(['info.tokenCheckNextRequestAt']);
        });
    }

    for (const [retryAfter, milliseconds] of [
        [600, 601_000],
        [null, 301_000],
    ] as const) {
        it(`preserves the server cooldown with Retry-After ${retryAfter}`, async () => {
            // Arrange
            status.rejects(new RateLimitError('Slow down', { retryAfter }));
            await create().get(TEST_ACCESS_TOKEN);
            status.resetHistory();
            clock.tick(milliseconds - 1);

            // Act
            const information = await create().get(TEST_ACCESS_TOKEN);

            // Assert
            expect(information.error).to.equal('tokenCheckWait');
            expect(status).not.to.have.been.called;
            expect(information.nextCheckAt - Date.now()).to.equal(1);
        });
    }

    it('does not publish a successful response after adapter unload', async () => {
        // Arrange
        const pending = deferred<typeof metadata>();
        status.returns(pending.promise);
        const abort = new AbortController();
        const response = create().get(TEST_ACCESS_TOKEN, abort.signal);
        await new Promise(resolve => setImmediate(resolve));

        // Act
        abort.abort();
        pending.resolve(metadata);
        const information = await response;

        // Assert
        expect(status.firstCall.args[0].signal).to.equal(abort.signal);
        expect(information.token).to.equal(null);
        expect(information.error).to.equal('tokenCheckUnavailable');
    });

    for (const permission of ['read:measuring-device', 'measuring-device']) {
        it(`allows device selection with ${permission} without another status query`, async () => {
            // Arrange
            status.resolves({ ...metadata, scopes: [permission] });
            const service = create();
            await service.get(TEST_ACCESS_TOKEN);
            status.resetHistory();
            clock.tick(61_000);

            // Act
            const allowed = await service.allowsDeviceListing(TEST_ACCESS_TOKEN);

            // Assert
            expect(allowed).to.equal(true);
            expect(status).not.to.have.been.called;
        });
    }

    it('uses manual IDs for a write-only token without requesting extra permissions', async () => {
        // Arrange
        status.resolves({ ...metadata, scopes: ['write:meter-reading'] });
        const service = create();
        await service.get(TEST_ACCESS_TOKEN);
        status.resetHistory();

        // Act
        const allowed = await service.allowsDeviceListing(TEST_ACCESS_TOKEN);

        // Assert
        expect(allowed).to.equal(false);
        expect(status).not.to.have.been.called;
    });

    it('does not offer device selection for an expired token', async () => {
        // Arrange
        status.resolves({ ...metadata, scopes: ['read:measuring-device'], expiresAt: new Date(Date.now() + 1000) });
        const service = create();
        await service.get(TEST_ACCESS_TOKEN);
        clock.tick(2000);
        status.resetHistory();

        // Act
        const allowed = await service.allowsDeviceListing(TEST_ACCESS_TOKEN);

        // Assert
        expect(allowed).to.equal(false);
        expect(status).not.to.have.been.called;
    });
});
