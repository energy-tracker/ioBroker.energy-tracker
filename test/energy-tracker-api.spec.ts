import { expect } from 'chai';
import sinon from 'sinon';
import 'sinon-chai';
import { EnergyTrackerClient, TimeoutError, ConflictError, EnergyTrackerAPIError } from '@energy-tracker/api-client';
import { EnergyTrackerApi } from '../src/lib/energy-tracker-api';
import { RequestBudget } from '../src/lib/request-budget';

const stateBase = { ack: true, ts: 1, lc: 1, from: 'test.0' };
const device: ioBroker.AdapterDevice = { deviceId: 'device-1', sourceState: 'meter.total', allowRounding: false };

describe('EnergyTrackerApi', () => {
    let adapter: sinon.SinonStubbedInstance<ioBroker.Adapter>;
    let fetchMock: sinon.SinonStub;
    let client: EnergyTrackerClient;
    let api: EnergyTrackerApi;
    let log: { info: sinon.SinonStub; warn: sinon.SinonStub; error: sinon.SinonStub };

    beforeEach(() => {
        log = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
        adapter = {
            getForeignStateAsync: sinon.stub().resolves({ ...stateBase, val: 123.456 }),
            setStateAsync: sinon.stub().resolves(),
            log,
        } as unknown as sinon.SinonStubbedInstance<ioBroker.Adapter>;
        fetchMock = sinon.stub().callsFake(() => Promise.resolve(new Response(null, { status: 204 })));
        client = new EnergyTrackerClient({ accessToken: 'test-token', fetch: fetchMock });
        api = new EnergyTrackerApi(adapter, client);
    });

    afterEach(() => sinon.restore());

    it('uses SDK v3 with a decimal string, explicit rounding and a 204 success', async () => {
        // Arrange: defaults are initialized in beforeEach.

        // Act
        const outcome = await api.sendReading(device);

        // Assert
        expect(outcome).to.equal(true);
        const [url, init] = fetchMock.firstCall.args as [string, RequestInit];
        expect(String(url)).to.equal(
            'https://public-api.energy-tracker.best-ios-apps.de/v3/devices/standard/device-1/meter-readings?allowRounding=false',
        );
        expect(init.method).to.equal('POST');
        expect(new Headers(init.headers).get('authorization')).to.equal('Bearer test-token');
        const reading = JSON.parse(init.body as string);
        expect(reading.value).to.equal('123.456');
        expect(new Date(reading.timestamp).toISOString()).to.equal(reading.timestamp);
    });

    it('preserves six decimal places and delegates meter precision rounding to the server', async () => {
        // Arrange
        adapter.getForeignStateAsync.resolves({ ...stateBase, val: '123.456789' });

        // Act
        const outcome = await api.sendReading({ ...device, allowRounding: true });

        // Assert
        expect(outcome).to.equal(true);
        expect(String(fetchMock.firstCall.args[0])).to.include('allowRounding=true');
        expect(JSON.parse(fetchMock.firstCall.args[1].body).value).to.equal('123.456789');
    });

    it('reserves the shared request budget before submitting through the SDK', async () => {
        // Arrange
        const acquire = sinon.stub().resolves();
        const budget = { available: true, acquire, defer: sinon.stub().resolves() } as unknown as RequestBudget;
        api = new EnergyTrackerApi(adapter, client, budget);

        // Act
        const outcome = await api.sendReading(device);

        // Assert
        expect(outcome).to.equal(true);
        expect(acquire).to.have.been.calledBefore(fetchMock);
    });

    it('samples the source state after waiting for a shared request slot', async () => {
        // Arrange
        const budget = {
            available: true,
            acquire: sinon.stub().callsFake(() => {
                adapter.getForeignStateAsync.resolves({ ...stateBase, val: 999 });
                return Promise.resolve();
            }),
            defer: sinon.stub().resolves(),
        } as unknown as RequestBudget;
        api = new EnergyTrackerApi(adapter, client, budget);

        // Act
        const outcome = await api.sendReading(device);

        // Assert
        expect(outcome).to.equal(true);
        expect(JSON.parse(fetchMock.firstCall.args[1].body).value).to.equal('999');
    });

    it('persists a submission rate limit through the shared budget', async () => {
        // Arrange
        const defer = sinon.stub().resolves();
        const budget = { available: true, acquire: sinon.stub().resolves(), defer } as unknown as RequestBudget;
        api = new EnergyTrackerApi(adapter, client, budget);
        fetchMock.resolves(new Response('{}', { status: 429, headers: { 'Retry-After': '42' } }));

        // Act
        const outcome = await api.sendReading(device);

        // Assert
        expect(outcome).to.equal(false);
        expect(defer).to.have.been.calledWith(42);
        expect(fetchMock).to.have.been.calledOnce;
    });

    it('skips reading submission during a shared API cooldown', async () => {
        // Arrange
        const acquire = sinon.stub().resolves();
        const budget = { available: false, acquire, defer: sinon.stub().resolves() } as unknown as RequestBudget;
        api = new EnergyTrackerApi(adapter, client, budget);

        // Act
        const outcome = await api.sendReading(device);

        // Assert
        expect(outcome).to.equal(false);
        expect(acquire).not.to.have.been.called;
        expect(fetchMock).not.to.have.been.called;
    });

    it('reports authentication rejection from the submission API', async () => {
        // Arrange
        fetchMock.callsFake(() => Promise.resolve(new Response('{}', { status: 401 })));

        // Act
        const outcome = await api.sendReading(device);

        // Assert
        expect(outcome).to.equal(false);
        expect(adapter.log.error).to.have.been.calledWithMatch('Unauthorized');
    });

    it('allows a later successful submission after an authentication rejection', async () => {
        // Arrange
        fetchMock.onFirstCall().resolves(new Response('{}', { status: 401 }));
        await api.sendReading(device);

        // Act
        const outcome = await api.sendReading(device);

        // Assert
        expect(outcome).to.equal(true);
    });

    it('preserves decimal strings without converting them to a JavaScript number', async () => {
        // Arrange
        adapter.getForeignStateAsync.resolves({ ...stateBase, val: '9999999999.123456' });

        // Act
        const outcome = await api.sendReading(device);

        // Assert
        expect(outcome).to.equal(true);
        expect(JSON.parse(fetchMock.firstCall.args[1].body).value).to.equal('9999999999.123456');
    });

    it('accepts a numeric zero', async () => {
        // Arrange
        adapter.getForeignStateAsync.resolves({ ...stateBase, val: 0 });

        // Act
        const outcome = await api.sendReading(device);

        // Assert
        expect(outcome).to.equal(true);
        expect(JSON.parse(fetchMock.firstCall.args[1].body).value).to.equal('0');
    });

    for (const [value, expected] of [
        [0.1 + 0.2, '0.3'],
        [1e-7, '0'],
        [Number.MIN_VALUE, '0'],
        [0.1234564, '0.123456'],
        [0.1234565, '0.123456'],
        ['0.9999995', '0.999999'],
        ['9999999999.1234564', '9999999999.123456'],
        ['9999999999.1234565', '9999999999.123456'],
    ] as const) {
        for (const allowRounding of [true, false]) {
            it(`truncates ${value} to six decimals independently of meter rounding (${allowRounding})`, async () => {
                // Arrange
                adapter.getForeignStateAsync.resolves({ ...stateBase, val: value });

                // Act
                const outcome = await api.sendReading({ ...device, allowRounding });

                // Assert
                expect(outcome).to.equal(true);
                expect(JSON.parse(fetchMock.firstCall.args[1].body).value).to.equal(expected);
                expect(String(fetchMock.firstCall.args[0])).to.include(`allowRounding=${allowRounding}`);
            });
        }
    }

    for (const value of [null, true, NaN, Infinity, -Infinity, -1e-7, '-0.0000001', '', 'bad', '1,23', '1e3', '0xff']) {
        it(`does not send an invalid state value: ${String(value)}`, async () => {
            // Arrange
            adapter.getForeignStateAsync.resolves({ ...stateBase, val: value });

            // Act
            const outcome = await api.sendReading(device);

            // Assert
            expect(outcome).to.equal(false);
            expect(fetchMock).not.to.have.been.called;
            expect(log.warn).to.have.been.calledOnce;
        });
    }

    it('does not send a missing state', async () => {
        // Arrange
        adapter.getForeignStateAsync.resolves(null);

        // Act
        const outcome = await api.sendReading(device);

        // Assert
        expect(outcome).to.equal(false);
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
    ] as const) {
        it(`reports HTTP ${status} without retrying it`, async () => {
            // Arrange
            api = new EnergyTrackerApi(adapter, client);
            fetchMock.callsFake(() =>
                Promise.resolve(
                    new Response(JSON.stringify({ message: 'Invalid reading' }), {
                        status,
                        headers: { 'retry-after': '42', 'content-type': 'application/json' },
                    }),
                ),
            );

            // Act
            const outcome = await api.sendReading(device);

            // Assert
            expect(outcome).to.equal(false);
            expect(fetchMock).to.have.been.calledOnce;
            expect(log[level]).to.have.been.calledWithMatch(message);
            expect(log.info).not.to.have.been.called;
        });
    }

    it('does not retry network errors', async () => {
        // Arrange
        api = new EnergyTrackerApi(adapter, client);
        fetchMock.rejects(new Error('Network down'));

        // Act
        const outcome = await api.sendReading(device);

        // Assert
        expect(outcome).to.equal(false);
        expect(fetchMock).to.have.been.calledOnce;
        expect(log.error).to.have.been.calledWithMatch('Network error');
    });

    for (const status of [500, 502, 503, 504, 599]) {
        it(`automatically retries HTTP ${status} and accepts only a confirmed success`, async () => {
            // Arrange
            const clock = sinon.useFakeTimers();
            fetchMock.onFirstCall().resolves(new Response(null, { status }));
            fetchMock.onSecondCall().resolves(new Response(null, { status: 204 }));

            // Act
            const result = api.sendReading(device);
            await clock.tickAsync(1999);
            const prematureCalls = fetchMock.callCount;
            await clock.tickAsync(1);
            const outcome = await result;

            // Assert
            expect(outcome).to.equal(true);
            expect(prematureCalls).to.equal(1);
            expect(fetchMock).to.have.been.calledTwice;
            expect(fetchMock.secondCall.args[1].body).to.equal(fetchMock.firstCall.args[1].body);
        });
    }

    it('retains the HTTP 503 classification and retries when the error body times out', async () => {
        // Arrange
        const clock = sinon.useFakeTimers();
        fetchMock.onFirstCall().callsFake((_url: unknown, init: RequestInit) =>
            Promise.resolve(
                new Response(
                    new ReadableStream({
                        start(controller) {
                            init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                                once: true,
                            });
                        },
                    }),
                    { status: 503 },
                ),
            ),
        );
        fetchMock.onSecondCall().resolves(new Response(null, { status: 204 }));

        // Act
        const result = api.sendReading(device);
        await clock.tickAsync(11999);
        const prematureCalls = fetchMock.callCount;
        await clock.tickAsync(1);
        const outcome = await result;

        // Assert
        expect(prematureCalls).to.equal(1);
        expect(outcome).to.equal(true);
        expect(fetchMock).to.have.been.calledTwice;
    });

    it('respects the shared API spacing without resampling a reading during a retry', async () => {
        // Arrange
        const clock = sinon.useFakeTimers();
        const budget = new RequestBudget(adapter);
        api = new EnergyTrackerApi(adapter, client, budget);
        const times: number[] = [];
        fetchMock.callsFake(() => {
            times.push(Date.now());
            if (times.length === 1) {
                adapter.getForeignStateAsync.resolves({ ...stateBase, val: 999 });
                return Promise.resolve(new Response(null, { status: 500 }));
            }
            return Promise.resolve(new Response(null, { status: 204 }));
        });

        // Act
        const result = api.sendReading(device);
        await clock.tickAsync(5000);
        const outcome = await result;

        // Assert
        expect(outcome).to.equal(true);
        expect(times).to.deep.equal([0, 5000]);
        expect(fetchMock.secondCall.args[1].body).to.equal(fetchMock.firstCall.args[1].body);
        expect(adapter.getForeignStateAsync).to.have.been.calledTwice;
    });

    it('stops the retry sequence when a subsequent attempt returns HTTP 429', async () => {
        // Arrange
        const clock = sinon.useFakeTimers();
        const defer = sinon.stub().resolves();
        const budget = { available: true, acquire: sinon.stub().resolves(), defer } as unknown as RequestBudget;
        api = new EnergyTrackerApi(adapter, client, budget);
        fetchMock.onFirstCall().resolves(Response.json({}, { status: 500 }));
        fetchMock.onSecondCall().resolves(Response.json({}, { status: 429, headers: { 'Retry-After': '42' } }));

        // Act
        const result = api.sendReading(device);
        await clock.tickAsync(107000);
        const outcome = await result;

        // Assert
        expect(outcome).to.equal(false);
        expect(fetchMock).to.have.been.calledTwice;
        expect(defer).to.have.been.calledOnceWith(42);
    });

    for (const status of [401, 403, 409, 429]) {
        it(`does not retry HTTP ${status} when its response body times out`, async () => {
            // Arrange
            const clock = sinon.useFakeTimers();
            api = new EnergyTrackerApi(adapter, client);
            fetchMock.callsFake((_url: unknown, init: RequestInit) =>
                Promise.resolve(
                    new Response(
                        new ReadableStream({
                            start(controller) {
                                init.signal?.addEventListener('abort', () => controller.error(init.signal?.reason), {
                                    once: true,
                                });
                            },
                        }),
                        { status, headers: { 'retry-after': '42' } },
                    ),
                ),
            );

            // Act
            const result = api.sendReading(device);
            await clock.tickAsync(40000);
            const outcome = await result;

            // Assert
            expect(outcome).to.equal(false);
            expect(fetchMock).to.have.been.calledOnce;
            expect(log.info).not.to.have.been.called;
        });
    }

    it('reports a source state read error', async () => {
        // Arrange
        adapter.getForeignStateAsync.rejects(new Error('State read failed'));

        // Act
        const outcome = await api.sendReading(device);

        // Assert
        expect(outcome).to.equal(false);
        expect(fetchMock).not.to.have.been.called;
        expect(log.error).to.have.been.calledWithMatch('State read failed');
    });

    it('stops after five retries when every attempt times out', async () => {
        // Arrange
        const clock = sinon.useFakeTimers();
        const create = sinon.stub(client.meterReadings, 'create').rejects(new TimeoutError('timeout'));

        // Act
        const result = api.sendReading(device);
        await clock.tickAsync(107000);
        const outcome = await result;

        // Assert
        expect(outcome).to.equal(false);
        expect(create.callCount).to.equal(6);
        expect(log.error).to.have.been.calledWithMatch('may already be saved');
    });

    it('lets the SDK time out an unresponsive request after ten seconds', async () => {
        // Arrange
        const clock = sinon.useFakeTimers();
        fetchMock.callsFake(
            (_url: unknown, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                }),
        );

        // Act
        const result = api.sendReading(device);
        await clock.tickAsync(9999);
        const errorsBeforeDeadline = log.error.callCount;
        await clock.tickAsync(1);
        const requestsAtDeadline = fetchMock.callCount;
        await clock.tickAsync(157000);
        const outcome = await result;

        // Assert
        expect(outcome).to.equal(false);
        expect(requestsAtDeadline).to.equal(1);
        expect(fetchMock.callCount).to.equal(6);
        expect(errorsBeforeDeadline).to.equal(0);
        expect(log.error).to.have.been.calledWithMatch('timed out after 10 seconds');
    });

    it('aborts an in-flight SDK request without an error log on unload', async () => {
        // Arrange
        const clock = sinon.useFakeTimers();
        fetchMock.callsFake(
            (_url: unknown, init: RequestInit) =>
                new Promise<Response>((_resolve, reject) => {
                    init.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                }),
        );
        const abort = new AbortController();

        // Act
        const result = api.sendReading(device, abort.signal);
        await clock.tickAsync(1);
        abort.abort();
        const outcome = await result;

        // Assert
        expect(outcome).to.equal(false);
        expect(log.error).not.to.have.been.called;
        expect(log.info).not.to.have.been.called;
    });

    it('keeps value and timestamp identical when retrying after two seconds', async () => {
        // Arrange
        const clock = sinon.useFakeTimers();
        const create = sinon.stub(client.meterReadings, 'create');
        create.onFirstCall().rejects(new TimeoutError('timeout'));
        create.onSecondCall().resolves();
        api = new EnergyTrackerApi(adapter, client);
        adapter.getForeignStateAsync.onSecondCall().resolves({ ...stateBase, val: 999 });

        // Act
        const result = api.sendReading(device);
        await clock.tickAsync(1999);
        const callsBeforeRetry = create.callCount;
        await clock.tickAsync(1);
        const outcome = await result;

        // Assert
        expect(outcome).to.equal(true);
        expect(create).to.have.been.calledTwice;
        expect(callsBeforeRetry).to.equal(1);
        expect(create.firstCall.args[1].timestamp).to.be.instanceOf(Date);
        expect(create.secondCall.args).to.deep.equal(create.firstCall.args);
        expect(adapter.getForeignStateAsync).to.have.been.calledOnce;
    });

    it('uses the exact backoff sequence across timeout and server failures', async () => {
        // Arrange
        const clock = sinon.useFakeTimers();
        const times: number[] = [];
        const create = sinon.stub(client.meterReadings, 'create').callsFake(() => {
            times.push(Date.now());
            return create.callCount % 2
                ? Promise.reject(new TimeoutError('timeout'))
                : Promise.reject(new EnergyTrackerAPIError('server failure', { statusCode: 502 }));
        });
        api = new EnergyTrackerApi(adapter, client);

        // Act
        const result = api.sendReading(device);
        await clock.tickAsync(107000);
        const outcome = await result;

        // Assert
        expect(outcome).to.equal(false);
        expect(times).to.deep.equal([0, 2000, 7000, 17000, 47000, 107000]);
        expect(create.getCalls().every(call => call.args[1] === create.firstCall.args[1])).to.equal(true);
    });

    it('does not claim success or retry a conflict after a timeout', async () => {
        // Arrange
        const clock = sinon.useFakeTimers();
        const create = sinon.stub(client.meterReadings, 'create');
        create.onFirstCall().rejects(new TimeoutError('timeout'));
        create.onSecondCall().rejects(new ConflictError('Conflict', { statusCode: 409 }));
        api = new EnergyTrackerApi(adapter, client);

        // Act
        const result = api.sendReading(device);
        await clock.tickAsync(2000);
        const outcome = await result;

        // Assert
        expect(outcome).to.equal(false);
        expect(create).to.have.been.calledTwice;
        expect(log.warn).to.have.been.calledWithMatch('submission outcome is uncertain');
        expect(log.info).not.to.have.been.called;
    });

    it('aborts a pending retry on unload', async () => {
        // Arrange
        const clock = sinon.useFakeTimers();
        const create = sinon.stub(client.meterReadings, 'create').rejects(new TimeoutError('timeout'));
        api = new EnergyTrackerApi(adapter, client);
        const abort = new AbortController();

        // Act
        const result = api.sendReading(device, abort.signal);
        await clock.tickAsync(1);
        abort.abort();
        await clock.tickAsync(10000);
        const outcome = await result;

        // Assert
        expect(outcome).to.equal(false);
        expect(create).to.have.been.calledOnce;
        expect(log.error).not.to.have.been.called;
    });

    it('does not start a request when already aborted', async () => {
        // Arrange
        const signal = AbortSignal.abort();

        // Act
        const outcome = await api.sendReading(device, signal);

        // Assert
        expect(outcome).to.equal(false);
        expect(adapter.getForeignStateAsync).not.to.have.been.called;
        expect(fetchMock).not.to.have.been.called;
    });
});
