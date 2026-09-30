import { expect } from 'chai';
import sinon from 'sinon';
import 'sinon-chai';
import proxyquire from 'proxyquire';
import { EventEmitter } from 'node:events';

const device: ioBroker.AdapterDevice = { deviceId: 'device-1', sourceState: 'meter.total', allowRounding: true };

describe('Scheduled adapter', () => {
    let config: Partial<ioBroker.AdapterConfig>;
    let sendReading: sinon.SinonStub;
    let clientConstructor: sinon.SinonStub;
    let apiConstructor: sinon.SinonStub;
    let createAdapter: () => FakeAdapter;

    class FakeAdapter extends EventEmitter {
        config = config;
        log = { info: sinon.stub(), warn: sinon.stub(), error: sinon.stub() };
        setStateAsync = sinon.stub().resolves();
        terminate = sinon.stub();

        async ready(): Promise<void> {
            await this.listeners('ready')[0].call(this);
        }
    }

    beforeEach(() => {
        config = { bearerToken: 'test-token', devices: [device] };
        sendReading = sinon.stub().resolves(true);
        clientConstructor = sinon.stub().returns({});
        apiConstructor = sinon.stub().returns({ sendReading });
        createAdapter = proxyquire.noCallThru().load('../src/main', {
            '@iobroker/adapter-core': { Adapter: FakeAdapter },
            '@energy-tracker/api-client': { EnergyTrackerClient: clientConstructor },
            './lib/energy-tracker-api': { EnergyTrackerApi: apiConstructor },
        });
    });

    afterEach(() => sinon.restore());

    it('uses a 10 second timeout and disables retries for existing configurations', async () => {
        const adapter = createAdapter();
        await adapter.ready();
        expect(clientConstructor).to.have.been.calledWith({ accessToken: 'test-token', timeout: 10 });
        expect(apiConstructor.firstCall.args.slice(2)).to.deep.equal([0, 2]);
        expect(adapter.setStateAsync.firstCall.args).to.deep.equal(['info.connection', { val: false, ack: true }]);
        expect(adapter.setStateAsync.lastCall.args).to.deep.equal(['info.connection', { val: true, ack: true }]);
        expect(adapter.terminate).to.have.been.calledOnce;
    });

    it('passes configured retry settings to the sender', async () => {
        config.timeoutRetries = 2;
        config.retryDelay = 5;
        await createAdapter().ready();
        expect(apiConstructor.firstCall.args.slice(2)).to.deep.equal([2, 5]);
    });

    for (const successFirst of [true, false]) {
        it(`keeps connection false for a mixed batch (success first: ${successFirst})`, async () => {
            config.devices = [device, { ...device, deviceId: 'device-2' }];
            let resolveSuccess!: (value: boolean) => void;
            let resolveFailure!: (value: boolean) => void;
            sendReading.onFirstCall().returns(new Promise<boolean>(resolve => (resolveSuccess = resolve)));
            sendReading.onSecondCall().returns(new Promise<boolean>(resolve => (resolveFailure = resolve)));
            const adapter = createAdapter();
            const ready = adapter.ready();
            if (successFirst) {
                resolveSuccess(true);
                await Promise.resolve();
                resolveFailure(false);
            } else {
                resolveFailure(false);
                await Promise.resolve();
                resolveSuccess(true);
            }
            await ready;
            expect(adapter.setStateAsync.lastCall.args).to.deep.equal(['info.connection', { val: false, ack: true }]);
            expect(adapter.terminate).to.have.been.calledOnce;
        });
    }

    it('does not report a batch of incomplete devices as connected', async () => {
        config.devices = [{ ...device, deviceId: '' }];
        const adapter = createAdapter();
        await adapter.ready();
        expect(sendReading).not.to.have.been.called;
        expect(adapter.setStateAsync.lastCall.args[1].val).to.equal(false);
    });

    it('keeps connection false if one configured device is skipped', async () => {
        config.devices = [device, { ...device, sourceState: '' }];
        const adapter = createAdapter();
        await adapter.ready();
        expect(sendReading).to.have.been.calledOnce;
        expect(adapter.setStateAsync.lastCall.args[1].val).to.equal(false);
    });

    for (const missing of ['token', 'devices'] as const) {
        it(`terminates without sending when ${missing} are missing`, async () => {
            if (missing === 'token') {
                config.bearerToken = '';
            } else {
                config.devices = [];
            }
            const adapter = createAdapter();
            await adapter.ready();
            expect(sendReading).not.to.have.been.called;
            expect(adapter.setStateAsync.lastCall.args[1].val).to.equal(false);
            expect(adapter.terminate).to.have.been.calledOnce;
        });
    }

    it('logs initialization failures and still terminates', async () => {
        apiConstructor.throws(new Error('Invalid retry setting'));
        const adapter = createAdapter();
        await adapter.ready();
        expect(adapter.log.error).to.have.been.calledWithMatch('Invalid retry setting');
        expect(adapter.setStateAsync.lastCall.args[1].val).to.equal(false);
        expect(adapter.terminate).to.have.been.calledOnce;
    });

    it('terminates when writing the initial connection state fails', async () => {
        const adapter = createAdapter();
        adapter.setStateAsync.rejects(new Error('State write failed'));
        await adapter.ready();
        expect(sendReading).not.to.have.been.called;
        expect(adapter.log.error).to.have.been.calledWithMatch('State write failed');
        expect(adapter.terminate).to.have.been.calledOnce;
    });

    it('aborts requests and avoids reporting success after unload', async () => {
        let finish!: (value: boolean) => void;
        sendReading.returns(new Promise<boolean>(resolve => (finish = resolve)));
        const adapter = createAdapter();
        const ready = adapter.ready();
        await Promise.resolve();
        const signal = sendReading.firstCall.args[1] as AbortSignal;
        const callback = sinon.stub();
        adapter.emit('unload', callback);
        expect(signal.aborted).to.equal(true);
        expect(callback).to.have.been.calledOnce;
        finish(true);
        await ready;
        expect(adapter.setStateAsync).to.have.been.calledOnce;
        expect(adapter.terminate).not.to.have.been.called;
    });
});
