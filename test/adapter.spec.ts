import { expect } from 'chai';
import sinon from 'sinon';
import 'sinon-chai';
import proxyquire from 'proxyquire';
import { EventEmitter } from 'node:events';
import { EnergyTrackerClient } from '@energy-tracker/api-client';
import { deferred, TEST_ACCESS_TOKEN } from './helpers';

const device: ioBroker.AdapterDevice = { deviceId: 'device-1', sourceState: 'meter.total', allowRounding: true };
const readDevice: ioBroker.AdapterReadDevice = {
    deviceId: 'device-1',
    extrapolationInterval: 'month',
};
const flush = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

describe('Daemon adapter', () => {
    let config: Partial<ioBroker.AdapterConfig>;
    let sendReading: sinon.SinonStub;
    let clientConstructor: sinon.SinonStub;
    let apiConstructor: sinon.SinonStub;
    let read: sinon.SinonStub;
    let configure: sinon.SinonStub;
    let checkToken: sinon.SinonStub;
    let getDevices: sinon.SinonStub;
    let allowsDeviceListing: sinon.SinonStub;
    let migrate: sinon.SinonStub;
    let pollDelay: sinon.SinonStub;
    let schedule: sinon.SinonStub;
    let submit: () => Promise<void>;
    let job: { cancel: sinon.SinonStub; on: sinon.SinonStub; nextInvocation: sinon.SinonStub };
    let budget: { restore: sinon.SinonStub; nextAllowedAt: number };
    let createAdapter: () => FakeAdapter;
    let adapters: FakeAdapter[];

    class FakeAdapter extends EventEmitter {
        config = config;
        namespace = 'energy-tracker.0';
        host = 'test-host';
        common = { mode: 'daemon' };
        log = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
        setStateAsync = sinon.stub().resolves();
        getStatesAsync = sinon.stub().resolves({});
        terminate = sinon.stub();
        sendTo = sinon.stub();
        async ready(): Promise<void> {
            await this.listeners('ready')[0].call(this);
        }
        async install(): Promise<void> {
            await this.listeners('install')[0].call(this);
        }
        async message(command: string, message: unknown = null): Promise<void> {
            await this.listeners('message')[0].call(this, {
                command,
                from: 'system.adapter.admin.0',
                message,
                callback: { id: 1, ack: false, time: 0 },
            });
        }
        connection(): boolean {
            return this.setStateAsync
                .getCalls()
                .filter(call => call.args[0] === 'info.connection')
                .at(-1)?.args[1].val;
        }
    }

    beforeEach(() => {
        adapters = [];
        config = { bearerToken: 'test-token', devices: [device], sendEnabled: true, sendSchedule: '0 * * * *' };
        sendReading = sinon.stub().resolves(true);
        clientConstructor = sinon.stub().returns({});
        apiConstructor = sinon.stub().returns({ sendReading });
        read = sinon.stub().resolves(true);
        configure = sinon.stub().resolves();
        checkToken = sinon.stub();
        checkToken.resolves({
            status: 'valid',
            token: { displayName: 'ioBroker', scopes: [], expiresAt: null },
            nextCheckAt: 0,
        });
        getDevices = sinon.stub().resolves([{ value: 'device-1', label: 'Meter' }]);
        allowsDeviceListing = sinon.stub().resolves(true);
        migrate = sinon.stub().resolves(false);
        job = {
            cancel: sinon.stub(),
            on: sinon.stub(),
            nextInvocation: sinon.stub().returns(new Date(2_000_000_000_000)),
        };
        schedule = sinon.stub().callsFake((_expression: string, callback: () => Promise<void>) => {
            submit = callback;
            return job;
        });
        pollDelay = sinon.stub().callsFake(
            (_ms: number, _value: unknown, options: { signal: AbortSignal }) =>
                new Promise((_resolve, reject) => {
                    options.signal.addEventListener('abort', () => reject(new Error('Adapter unloaded')), {
                        once: true,
                    });
                }),
        );
        budget = { restore: sinon.stub().resolves(), nextAllowedAt: 0 };
        const factory = proxyquire.noCallThru().load('../src/main', {
            '@iobroker/adapter-core': { Adapter: FakeAdapter, EXIT_CODES: { INVALID_ADAPTER_CONFIG: 32 } },
            '@energy-tracker/api-client': { EnergyTrackerClient: clientConstructor },
            './lib/energy-tracker-api': { EnergyTrackerApi: apiConstructor },
            './lib/data-reader': { DataReader: sinon.stub().returns({ read, configure }) },
            './lib/migration': { migrateLegacyInstances: migrate, DEFAULT_SEND_SCHEDULE: '0 0 * * 0' },
            './lib/submission-schedule': { submissionSchedule: schedule },
            './lib/token-status': {
                TokenStatus: sinon.stub().returns({ get: checkToken, allowsDeviceListing }),
            },
            './lib/device-list': { DeviceList: sinon.stub().returns({ get: getDevices }) },
            './lib/request-budget': {
                RequestBudget: sinon.stub().returns(budget),
                pollingInterval: (selected: number) => selected,
            },
            'node:timers/promises': { setTimeout: pollDelay },
        });
        createAdapter = () => {
            const adapter = factory();
            adapters.push(adapter);
            return adapter;
        };
    });
    afterEach(() => {
        for (const adapter of adapters) {
            adapter.emit('unload', () => undefined);
        }
        sinon.restore();
    });

    it('arms the submission schedule without submitting or retrieving readings on startup', async () => {
        // Arrange
        const fetchMock = sinon.stub();
        clientConstructor.returns(new EnergyTrackerClient({ accessToken: 'test-token', fetch: fetchMock }));
        const adapter = createAdapter();

        // Act
        await adapter.ready();

        // Assert
        expect(clientConstructor).to.have.been.calledWith({ accessToken: 'test-token', timeout: 10 });
        expect(schedule.firstCall.args[0]).to.equal('0 * * * *');
        expect(fetchMock).not.to.have.been.called;
        expect(sendReading).not.to.have.been.called;
        expect(read).not.to.have.been.called;
        expect(checkToken).not.to.have.been.called;
        expect(adapter.terminate).not.to.have.been.called;
        expect(adapter.setStateAsync).to.have.been.calledWith('info.sending.nextRun', {
            val: 2_000_000_000_000,
            ack: true,
        });
    });

    it('waits for the controller restart after migrating its own configuration', async () => {
        // Arrange
        migrate.resolves(true);
        const adapter = createAdapter();

        // Act
        await adapter.ready();

        // Assert
        expect(migrate).to.have.been.calledOnceWith(adapter);
        expect(schedule).not.to.have.been.called;
        expect(clientConstructor).not.to.have.been.called;
        expect(read).not.to.have.been.called;
        expect(sendReading).not.to.have.been.called;
        expect(adapter.terminate).not.to.have.been.called;
    });

    it('offers time zones without a saved token or any public API request', async () => {
        // Arrange
        config.bearerToken = '';
        const adapter = createAdapter();
        await adapter.ready();

        // Act
        await adapter.message('getTimeZones');

        // Assert
        const options = adapter.sendTo.firstCall.args[2] as { value: string; label: string }[];
        expect(options.some(option => option.value === 'Europe/Berlin')).to.equal(true);
        expect(checkToken).not.to.have.been.called;
        expect(getDevices).not.to.have.been.called;
        expect(clientConstructor).not.to.have.been.called;
    });

    for (const command of ['getTokenInfo', 'checkToken']) {
        it(`handles ${command} immediately without running either workflow`, async () => {
            // Arrange
            const adapter = createAdapter();
            await adapter.ready();
            checkToken.resetHistory();

            // Act
            await adapter.message(command);

            // Assert
            expect(checkToken).to.have.been.calledOnce;
            expect(adapter.sendTo).to.have.been.calledWith(
                'system.adapter.admin.0',
                command,
                await checkToken.firstCall.returnValue,
            );
            expect(sendReading).not.to.have.been.called;
            expect(read).not.to.have.been.called;
            expect(getDevices).not.to.have.been.called;
        });
    }

    it('checks a draft token before saving without changing either workflow credential', async () => {
        // Arrange
        const adapter = createAdapter();
        await adapter.ready();
        const savedToken = config.bearerToken;

        // Act
        await adapter.message('getTokenInfo', { token: TEST_ACCESS_TOKEN });

        // Assert
        expect(checkToken).to.have.been.calledOnceWith(TEST_ACCESS_TOKEN, sinon.match.instanceOf(AbortSignal));
        expect(config.bearerToken).to.equal(savedToken);
        expect(sendReading).not.to.have.been.called;
        expect(read).not.to.have.been.called;
        expect(getDevices).not.to.have.been.called;
    });

    it('checks a draft token in a fresh installation with no saved credential', async () => {
        // Arrange
        config.bearerToken = '';
        const adapter = createAdapter();
        await adapter.ready();

        // Act
        await adapter.message('getTokenInfo', { token: TEST_ACCESS_TOKEN });

        // Assert
        expect(checkToken).to.have.been.calledOnceWith(TEST_ACCESS_TOKEN, sinon.match.instanceOf(AbortSignal));
        expect(config.bearerToken).to.equal('');
        expect(clientConstructor).not.to.have.been.called;
        expect(sendReading).not.to.have.been.called;
    });

    for (const token of [undefined, 42, '', 'partial-token', '89d4f886-7eec-4f47-a8b2-41251b083d42']) {
        it(`rejects an incomplete draft credential (${String(token)}) without checking the saved token`, async () => {
            // Arrange
            const adapter = createAdapter();
            await adapter.ready();

            // Act
            await adapter.message('getTokenInfo', { token });

            // Assert
            expect(checkToken).not.to.have.been.called;
            expect(adapter.sendTo).to.have.been.calledWith('system.adapter.admin.0', 'getTokenInfo', {
                error: 'tokenCheckFormat',
            });
        });
    }

    it('returns fetched device choices without submitting readings or polling calculations', async () => {
        // Arrange
        const adapter = createAdapter();
        await adapter.ready();

        // Act
        await adapter.message('getDevices');

        // Assert
        expect(getDevices).to.have.been.calledOnce;
        expect(adapter.sendTo).to.have.been.calledWith('system.adapter.admin.0', 'getDevices', [
            { value: 'device-1', label: 'Meter' },
        ]);
        expect(sendReading).not.to.have.been.called;
        expect(read).not.to.have.been.called;
        expect(checkToken).not.to.have.been.called;
    });

    it('responds to configuration requests even when no token is saved', async () => {
        // Arrange
        config.bearerToken = '';
        const adapter = createAdapter();
        await adapter.ready();

        // Act
        await adapter.message('getTokenInfo');
        await adapter.message('checkToken');
        await adapter.message('getDevices');

        // Assert
        expect(adapter.sendTo).to.have.been.calledWith('system.adapter.admin.0', 'getTokenInfo', {
            error: 'tokenCheckFormat',
        });
        expect(adapter.sendTo).to.have.been.calledWith('system.adapter.admin.0', 'checkToken', {
            error: 'tokenCheckFormat',
        });
        expect(adapter.sendTo).to.have.been.calledWith('system.adapter.admin.0', 'getDevices', []);
        expect(clientConstructor).not.to.have.been.called;
    });

    it('keeps device IDs editable without requesting devices for a write-only token', async () => {
        // Arrange
        const adapter = createAdapter();
        await adapter.ready();
        allowsDeviceListing.resolves(false);

        // Act
        await adapter.message('getDevices');

        // Assert
        expect(adapter.sendTo).to.have.been.calledWith('system.adapter.admin.0', 'getDevices', []);
        expect(getDevices).not.to.have.been.called;
        expect(checkToken).not.to.have.been.called;
        expect(sendReading).not.to.have.been.called;
    });

    it('returns a check error when the configuration handler cannot persist its result', async () => {
        // Arrange
        const adapter = createAdapter();
        await adapter.ready();
        checkToken.rejects(new Error('Storage unavailable'));

        // Act
        await adapter.message('checkToken');

        // Assert
        expect(adapter.sendTo).to.have.been.calledWith('system.adapter.admin.0', 'checkToken', {
            error: 'tokenCheckUnavailable',
        });
        expect(sendReading).not.to.have.been.called;
    });

    it('submits readings only when the independent schedule fires', async () => {
        // Arrange
        const adapter = createAdapter();
        await adapter.ready();

        // Act
        await submit();

        // Assert
        expect(sendReading).to.have.been.calledOnce;
        expect(apiConstructor.firstCall.args.slice(2)).to.deep.equal([budget]);
        expect(adapter.connection()).to.equal(true);
        expect(read).not.to.have.been.called;
    });

    it('sends batches sequentially and skips overlapping schedule ticks', async () => {
        // Arrange
        config.devices = [device, { ...device, deviceId: 'device-2' }];
        const pendingReading = deferred<boolean>();
        sendReading.onFirstCall().returns(pendingReading.promise);
        sendReading.onSecondCall().resolves(false);
        const adapter = createAdapter();
        await adapter.ready();

        // Act
        const firstBatch = submit();
        await flush();
        const callsBeforeOverlap = sendReading.callCount;
        await submit();
        const callsAfterOverlap = sendReading.callCount;
        pendingReading.resolve(true);
        await firstBatch;

        // Assert
        expect(callsBeforeOverlap).to.equal(1);
        expect(callsAfterOverlap).to.equal(1);
        expect(sendReading).to.have.been.calledTwice;
        expect(adapter.connection()).to.equal(false);
    });

    it('reports incomplete configured senders as failed', async () => {
        // Arrange
        config.devices = [device, { ...device, sourceState: '' }];
        const adapter = createAdapter();
        await adapter.ready();

        // Act
        await submit();

        // Assert
        expect(sendReading).to.have.been.calledOnce;
        expect(adapter.connection()).to.equal(false);
    });

    it('does not enable sending for an empty sender table', async () => {
        // Arrange
        config.devices = [{ deviceId: '', sourceState: '', allowRounding: true }];
        const adapter = createAdapter();

        // Act
        await adapter.ready();

        // Assert
        expect(schedule).not.to.have.been.called;
        expect(sendReading).not.to.have.been.called;
    });

    it('keeps an unconfigured daemon alive without making API requests', async () => {
        // Arrange
        config.bearerToken = '';
        const adapter = createAdapter();

        // Act
        await adapter.ready();

        // Assert
        expect(clientConstructor).not.to.have.been.called;
        expect(schedule).not.to.have.been.called;
        expect(adapter.connection()).to.equal(false);
        expect(adapter.terminate).not.to.have.been.called;
        expect(adapter.setStateAsync).to.have.been.calledWith('info.polling.effectiveInterval', {
            val: 0,
            ack: true,
        });
    });

    it('migrates installation objects without starting either workflow', async () => {
        // Arrange
        const adapter = createAdapter();

        // Act
        await adapter.install();

        // Assert
        expect(migrate).to.have.been.calledWith(adapter);
        expect(clientConstructor).not.to.have.been.called;
        expect(schedule).not.to.have.been.called;
        expect(adapter.terminate).to.have.been.calledOnce;
    });

    it('rejects a scheduled instance when its migration could not identify a stored configuration', async () => {
        // Arrange
        const adapter = createAdapter();
        adapter.common.mode = 'schedule';

        // Act
        await adapter.ready();

        // Assert
        expect(clientConstructor).not.to.have.been.called;
        expect(sendReading).not.to.have.been.called;
        expect(read).not.to.have.been.called;
        expect(adapter.terminate).to.have.been.calledWithMatch('Install or upgrade', 32);
        expect(migrate).to.have.been.calledOnceWith(adapter);
    });

    it('reports a failed installation migration through its exit code', async () => {
        // Arrange
        migrate.rejects(new Error('Migration write failed'));
        const adapter = createAdapter();

        // Act
        await adapter.install();

        // Assert
        expect(clientConstructor).not.to.have.been.called;
        expect(adapter.terminate).to.have.been.calledWith('Instance migration failed.', 1);
    });

    it('handles state storage failures without an unhandled rejection', async () => {
        // Arrange
        const adapter = createAdapter();
        adapter.setStateAsync.rejects(new Error('State write failed'));

        // Act
        await adapter.ready();

        // Assert
        expect(sendReading).not.to.have.been.called;
        expect(adapter.log.error).to.have.been.calledWithMatch('State write failed');
    });

    it('aborts a pending submission and cancels future schedule ticks on unload', async () => {
        // Arrange
        const pendingReading = deferred<boolean>();
        sendReading.returns(pendingReading.promise);
        const adapter = createAdapter();
        await adapter.ready();
        const pendingBatch = submit();
        await flush();
        const signal = sendReading.firstCall.args[1] as AbortSignal;
        const writesBeforeUnload = adapter.setStateAsync.callCount;
        const callback = sinon.stub();

        // Act
        adapter.emit('unload', callback);
        pendingReading.resolve(true);
        await pendingBatch;
        await submit();

        // Assert
        expect(signal.aborted).to.equal(true);
        expect(callback).to.have.been.calledOnce;
        expect(job.cancel).to.have.been.calledOnce;
        expect(adapter.setStateAsync.callCount).to.equal(writesBeforeUnload);
        expect(sendReading).to.have.been.calledOnce;
    });

    it('retrieves without enabling submission, and marks old data unavailable', async () => {
        // Arrange
        config.sendEnabled = false;
        config.readDevices = [readDevice];
        const adapter = createAdapter();
        adapter.getStatesAsync.resolves({ 'energy-tracker.0.devices.device-1.extrapolation.available': { val: true } });

        // Act
        const ready = adapter.ready();
        await flush();
        const connected = adapter.connection();
        adapter.emit('unload', sinon.stub());
        await ready;

        // Assert
        expect(schedule).not.to.have.been.called;
        expect(sendReading).not.to.have.been.called;
        expect(read.firstCall.args[0]).to.equal(readDevice);
        expect(read.firstCall.args[1]).to.include({
            timeZone: '',
        });
        expect(adapter.setStateAsync).to.have.been.calledWith(
            'energy-tracker.0.devices.device-1.extrapolation.available',
            { val: false, ack: true },
        );
        expect(read.firstCall.args[1].signal).to.be.instanceOf(AbortSignal);
        expect(connected).to.equal(true);
    });

    it('does not trigger retrieval when a reading submission schedule fires', async () => {
        // Arrange
        config.readDevices = [readDevice];
        const adapter = createAdapter();
        const ready = adapter.ready();
        await flush();
        const readsBeforeSubmission = read.callCount;
        const sendsBeforeSubmission = sendReading.callCount;

        // Act
        await submit();
        await submit();
        adapter.emit('unload', sinon.stub());
        await ready;

        // Assert
        expect(readsBeforeSubmission).to.equal(1);
        expect(sendsBeforeSubmission).to.equal(0);
        expect(sendReading).to.have.been.calledTwice;
        expect(read).to.have.been.calledOnce;
        expect(pollDelay).to.have.been.calledOnce;
    });

    it('continues polling when the submission schedule is invalid', async () => {
        // Arrange
        config.readDevices = [readDevice];
        schedule.returns(null);
        const adapter = createAdapter();

        // Act
        const ready = adapter.ready();
        await flush();
        const connected = adapter.connection();
        adapter.emit('unload', sinon.stub());
        await ready;

        // Assert
        expect(read).to.have.been.calledOnce;
        expect(sendReading).not.to.have.been.called;
        expect(adapter.log.error).to.have.been.calledWithMatch('Invalid reading submission CRON');
        expect(connected).to.equal(false);
    });

    it('continues polling after a submission initialization error', async () => {
        // Arrange
        config.readDevices = [readDevice];
        apiConstructor.throws(new Error('Sender initialization failed'));
        const adapter = createAdapter();
        const ready = adapter.ready();
        await flush();

        // Act
        await submit();
        adapter.emit('unload', sinon.stub());
        await ready;

        // Assert
        expect(adapter.log.error).to.have.been.calledWithMatch('Sender initialization failed');
        expect(read).to.have.been.calledOnce;
        expect(adapter.terminate).not.to.have.been.called;
    });

    it('waits for a slow calculation cycle before starting its polling pause', async () => {
        // Arrange
        config.readDevices = [readDevice];
        const pendingRead = deferred<boolean>();
        read.returns(pendingRead.promise);
        const adapter = createAdapter();

        // Act
        const ready = adapter.ready();
        await flush();
        const readsWhilePending = read.callCount;
        const pausesWhilePending = pollDelay.callCount;
        pendingRead.resolve(true);
        await flush();
        adapter.emit('unload', sinon.stub());
        await ready;

        // Assert
        expect(readsWhilePending).to.equal(1);
        expect(pausesWhilePending).to.equal(0);
        expect(pollDelay.firstCall.args[0]).to.equal(60_000);
        expect(sendReading).not.to.have.been.called;
        expect(adapter.log.error).not.to.have.been.called;
    });

    it('backs off failed retrievals without changing the submission schedule', async () => {
        // Arrange
        config.readDevices = [readDevice];
        pollDelay.resolves();
        read.onFirstCall().resolves(false);
        read.onSecondCall().resolves(true);
        const adapter = createAdapter();
        read.onThirdCall().callsFake(() => {
            adapter.emit('unload', sinon.stub());
            return Promise.resolve(false);
        });

        // Act
        await adapter.ready();

        // Assert
        expect(pollDelay.firstCall.args[0]).to.equal(120_000);
        expect(pollDelay.secondCall.args[0]).to.equal(60_000);
        expect(schedule).to.have.been.calledOnce;
        expect(sendReading).not.to.have.been.called;
    });

    it('respects API cooldown before the next calculation cycle', async () => {
        // Arrange
        config.readDevices = [readDevice];
        budget.nextAllowedAt = Date.now() + 600_000;
        read.resolves(false);
        const adapter = createAdapter();

        // Act
        const ready = adapter.ready();
        await flush();
        adapter.emit('unload', sinon.stub());
        await ready;

        // Assert
        expect(pollDelay.firstCall.args[0]).to.be.greaterThan(599_000);
    });
});
