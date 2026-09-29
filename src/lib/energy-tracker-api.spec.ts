import { expect } from 'chai';
import sinon from 'sinon';
import 'sinon-chai';
import { EnergyTrackerClient, TimeoutError, ConflictError, ValidationError } from '@energy-tracker/api-client';
import { EnergyTrackerApi } from './energy-tracker-api';

const stateBase = { ack: true, ts: 1, lc: 1, from: 'test.0' };
const device: ioBroker.AdapterDevice = { deviceId: 'device-1', sourceState: 'meter.total', allowRounding: false };

describe('EnergyTrackerApi', () => {
    let adapter: sinon.SinonStubbedInstance<ioBroker.Adapter>;
    let fetchMock: sinon.SinonStub;
    let client: EnergyTrackerClient;
    let api: EnergyTrackerApi;

    beforeEach(() => {
        adapter = {
            getForeignStateAsync: sinon.stub().resolves({ ...stateBase, val: 123.456 }),
            log: { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() },
        } as unknown as sinon.SinonStubbedInstance<ioBroker.Adapter>;
        fetchMock = sinon.stub().callsFake(() => Promise.resolve(new Response(null, { status: 204 })));
        client = new EnergyTrackerClient({ accessToken: 'test-token', fetch: fetchMock });
        api = new EnergyTrackerApi(adapter, client);
    });

    afterEach(() => sinon.restore());

    it('uses SDK v3 with a decimal string, explicit rounding and a 204 success', async () => {
        expect(await api.sendReading(device)).to.equal(true);
        const [url, init] = fetchMock.firstCall.args as [string, RequestInit];
        expect(String(url)).to.equal(
            'https://public-api.energy-tracker.best-ios-apps.de/v3/devices/standard/device-1/meter-readings?allowRounding=false',
        );
        expect(init.method).to.equal('POST');
        expect(new Headers(init.headers).get('authorization')).to.equal('Bearer test-token');
        expect(JSON.parse(init.body as string)).to.deep.equal({ value: '123.456' });
    });

    it('passes rounding to the server without rounding the value locally', async () => {
        adapter.getForeignStateAsync.resolves({ ...stateBase, val: '123.456789' });
        expect(await api.sendReading({ ...device, allowRounding: true })).to.equal(true);
        expect(String(fetchMock.firstCall.args[0])).to.include('allowRounding=true');
        expect(JSON.parse(fetchMock.firstCall.args[1].body).value).to.equal('123.456789');
    });

    it('preserves decimal strings without converting them to a JavaScript number', async () => {
        adapter.getForeignStateAsync.resolves({ ...stateBase, val: '9999999999.123456' });
        expect(await api.sendReading(device)).to.equal(true);
        expect(JSON.parse(fetchMock.firstCall.args[1].body).value).to.equal('9999999999.123456');
    });

    it('accepts a numeric zero', async () => {
        adapter.getForeignStateAsync.resolves({ ...stateBase, val: 0 });
        expect(await api.sendReading(device)).to.equal(true);
        expect(JSON.parse(fetchMock.firstCall.args[1].body).value).to.equal('0');
    });

    for (const value of [null, true, NaN, Infinity, -Infinity, '', 'bad', '1,23', '1e3']) {
        it(`does not send an invalid state value: ${String(value)}`, async () => {
            adapter.getForeignStateAsync.resolves({ ...stateBase, val: value });
            expect(await api.sendReading(device)).to.equal(false);
            expect(fetchMock).not.to.have.been.called;
            expect(adapter.log.warn).to.have.been.calledOnce;
        });
    }

    it('does not send a missing state', async () => {
        adapter.getForeignStateAsync.resolves(null);
        expect(await api.sendReading(device)).to.equal(false);
        expect(fetchMock).not.to.have.been.called;
    });

    for (const [status, level, message] of [
        [200, 'warn', 'HTTP 200'],
        [400, 'warn', 'Invalid reading'],
        [401, 'error', 'Unauthorized'],
        [403, 'error', 'Forbidden'],
        [404, 'warn', 'HTTP 404'],
        [409, 'warn', 'HTTP 409'],
        [429, 'warn', 'Retry after 42 seconds'],
        [500, 'warn', 'HTTP 500'],
        [503, 'warn', 'HTTP 503'],
    ] as const) {
        it(`reports HTTP ${status} without retrying it`, async () => {
            api = new EnergyTrackerApi(adapter, client, 2, 1);
            fetchMock.callsFake(() =>
                Promise.resolve(
                    new Response(JSON.stringify({ message: 'Invalid reading' }), {
                        status,
                        headers: { 'retry-after': '42', 'content-type': 'application/json' },
                    }),
                ),
            );
            expect(await api.sendReading(device)).to.equal(false);
            expect(fetchMock).to.have.been.calledOnce;
            expect(adapter.log[level]).to.have.been.calledWithMatch(message);
            expect(adapter.log.info).not.to.have.been.called;
        });
    }

    it('does not retry network errors', async () => {
        api = new EnergyTrackerApi(adapter, client, 2, 1);
        fetchMock.rejects(new Error('Network down'));
        expect(await api.sendReading(device)).to.equal(false);
        expect(fetchMock).to.have.been.calledOnce;
        expect(adapter.log.error).to.have.been.calledWithMatch('Network error');
    });

    it('reports a source state read error', async () => {
        adapter.getForeignStateAsync.rejects(new Error('State read failed'));
        expect(await api.sendReading(device)).to.equal(false);
        expect(fetchMock).not.to.have.been.called;
        expect(adapter.log.error).to.have.been.calledWithMatch('State read failed');
    });

    it('does not retry timeouts by default', async () => {
        const create = sinon.stub(client.meterReadings, 'create').rejects(new TimeoutError('timeout'));
        expect(await api.sendReading(device)).to.equal(false);
        expect(create).to.have.been.calledOnce;
        expect(adapter.log.error).to.have.been.calledWithMatch('may already be saved');
    });

    it('lets the SDK time out an unresponsive request after ten seconds', async () => {
        const clock = sinon.useFakeTimers();
        fetchMock.callsFake(
            (_url: unknown, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                }),
        );
        const result = api.sendReading(device);
        await clock.tickAsync(9999);
        expect(adapter.log.error).not.to.have.been.called;
        await clock.tickAsync(1);
        expect(await result).to.equal(false);
        expect(fetchMock).to.have.been.calledOnce;
        expect(adapter.log.error).to.have.been.calledWithMatch('timed out after 10 seconds');
    });

    it('aborts an in-flight SDK request without an error log on unload', async () => {
        const clock = sinon.useFakeTimers();
        fetchMock.callsFake(
            (_url: unknown, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                }),
        );
        const abort = new AbortController();
        const result = api.sendReading(device, abort.signal);
        await clock.tickAsync(1);
        abort.abort();
        expect(await result).to.equal(false);
        expect(adapter.log.error).not.to.have.been.called;
        expect(adapter.log.info).not.to.have.been.called;
    });

    it('keeps value and timestamp identical when retrying after the configured delay', async () => {
        const clock = sinon.useFakeTimers();
        const create = sinon.stub(client.meterReadings, 'create');
        create.onFirstCall().rejects(new TimeoutError('timeout'));
        create.onSecondCall().resolves();
        api = new EnergyTrackerApi(adapter, client, 1, 2);
        const result = api.sendReading(device);
        await clock.tickAsync(1999);
        expect(create).to.have.been.calledOnce;
        adapter.getForeignStateAsync.resolves({ ...stateBase, val: 999 });
        await clock.tickAsync(1);
        expect(await result).to.equal(true);
        expect(create).to.have.been.calledTwice;
        expect(create.firstCall.args[1].timestamp).to.be.instanceOf(Date);
        expect(create.secondCall.args).to.deep.equal(create.firstCall.args);
        expect(adapter.getForeignStateAsync).to.have.been.calledOnce;
    });

    it('stops after two retries', async () => {
        const clock = sinon.useFakeTimers();
        const create = sinon.stub(client.meterReadings, 'create').rejects(new TimeoutError('timeout'));
        api = new EnergyTrackerApi(adapter, client, 2, 1);
        const result = api.sendReading(device);
        await clock.tickAsync(2000);
        expect(await result).to.equal(false);
        expect(create.callCount).to.equal(3);
    });

    it('does not claim success or retry a conflict after a timeout', async () => {
        const clock = sinon.useFakeTimers();
        const create = sinon.stub(client.meterReadings, 'create');
        create.onFirstCall().rejects(new TimeoutError('timeout'));
        create.onSecondCall().rejects(new ConflictError('Conflict', { statusCode: 409 }));
        api = new EnergyTrackerApi(adapter, client, 2, 1);
        const result = api.sendReading(device);
        await clock.tickAsync(1000);
        expect(await result).to.equal(false);
        expect(create).to.have.been.calledTwice;
        expect(adapter.log.warn).to.have.been.calledWithMatch('submission outcome is uncertain');
        expect(adapter.log.info).not.to.have.been.called;
    });

    it('aborts a pending retry on unload', async () => {
        const clock = sinon.useFakeTimers();
        const create = sinon.stub(client.meterReadings, 'create').rejects(new TimeoutError('timeout'));
        api = new EnergyTrackerApi(adapter, client, 2, 2);
        const abort = new AbortController();
        const result = api.sendReading(device, abort.signal);
        await clock.tickAsync(1);
        abort.abort();
        expect(await result).to.equal(false);
        await clock.tickAsync(10000);
        expect(create).to.have.been.calledOnce;
        expect(adapter.log.error).not.to.have.been.called;
    });

    it('does not start a request when already aborted', async () => {
        expect(await api.sendReading(device, AbortSignal.abort())).to.equal(false);
        expect(fetchMock).not.to.have.been.called;
    });

    for (const retries of [-1, 3, 0.5, NaN]) {
        it(`rejects invalid retry count ${retries}`, () => {
            expect(() => new EnergyTrackerApi(adapter, client, retries)).to.throw(ValidationError);
        });
    }
    for (const seconds of [0, 61, NaN, Infinity]) {
        it(`rejects invalid retry delay ${seconds}`, () => {
            expect(() => new EnergyTrackerApi(adapter, client, 1, seconds)).to.throw(ValidationError);
        });
    }
});
