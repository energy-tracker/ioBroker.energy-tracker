import { expect } from 'chai';
import sinon from 'sinon';
import 'sinon-chai';
import { ForbiddenError, RateLimitError, EnergyTrackerClient, type DeviceSummaryDto } from '@energy-tracker/api-client';
import { DeviceList } from '../src/lib/device-list';
import type { RequestBudget } from '../src/lib/request-budget';
import { deferred } from './helpers';

describe('Configuration device selection', () => {
    let adapter: sinon.SinonStubbedInstance<ioBroker.Adapter>;
    let listStandard: sinon.SinonStub;
    let clock: sinon.SinonFakeTimers;
    let budget: { available: boolean; acquire: sinon.SinonStub; defer: sinon.SinonStub };
    let list: DeviceList;
    const devices: DeviceSummaryDto[] = [
        { id: '00000000-0000-0000-0000-000000000001', name: 'Gas', folderPath: '/Basement', lastUpdatedAt: null },
        { id: '00000000-0000-0000-0000-000000000002', name: 'Electricity', folderPath: '/', lastUpdatedAt: null },
    ];

    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: Date.parse('2026-10-12T12:00:00Z'), toFake: ['Date'] });
        adapter = { log: { warn: sinon.stub() } } as unknown as sinon.SinonStubbedInstance<ioBroker.Adapter>;
        listStandard = sinon.stub().resolves(devices);
        budget = { available: true, acquire: sinon.stub().resolves(), defer: sinon.stub().resolves() };
        list = new DeviceList(
            adapter,
            { devices: { listStandard } } as unknown as EnergyTrackerClient,
            budget as unknown as RequestBudget,
        );
    });
    afterEach(() => sinon.restore());

    it('retrieves the choices through the SDK standard-device endpoint', async () => {
        // Arrange
        const fetch = sinon.stub().resolves(Response.json(devices));
        const service = new DeviceList(
            adapter,
            new EnergyTrackerClient({ accessToken: 'test-token', fetch }),
            budget as unknown as RequestBudget,
        );

        // Act
        const options = await service.get();

        // Assert
        expect(fetch).to.have.been.calledOnce;
        expect(String(fetch.firstCall.args[0])).to.equal(
            'https://public-api.energy-tracker.best-ios-apps.de/v1/devices/standard',
        );
        expect(fetch.firstCall.args[1].method).to.equal('GET');
        expect(options.map(option => option.value)).to.deep.equal(devices.map(device => device.id));
    });

    it('returns device names and folder paths while preserving the SDK IDs', async () => {
        // Arrange
        const abort = new AbortController();

        // Act
        const options = await list.get(abort.signal);

        // Assert
        expect(options).to.deep.equal([
            { value: devices[0].id, label: `/Basement/Gas (${devices[0].id})` },
            { value: devices[1].id, label: `/Electricity (${devices[1].id})` },
        ]);
        expect(budget.acquire).to.have.been.calledWith(abort.signal);
        expect(listStandard).to.have.been.calledWith({ signal: abort.signal });
    });

    it('shares one request between simultaneous selectors and caches subsequent rows', async () => {
        // Arrange
        const pending = deferred<DeviceSummaryDto[]>();
        listStandard.returns(pending.promise);

        // Act
        const selectors = [list.get(), list.get(), list.get()];
        pending.resolve(devices);
        const results = await Promise.all(selectors);
        await list.get();

        // Assert
        expect(listStandard).to.have.been.calledOnce;
        expect(budget.acquire).to.have.been.calledOnce;
        expect(results[0]).to.deep.equal(results[1]);
        expect(results[1]).to.deep.equal(results[2]);
    });

    it('refreshes an expired list when another selector requests it', async () => {
        // Arrange
        await list.get();
        clock.tick(60_000);
        listStandard.resolves([devices[1]]);

        // Act
        const options = await list.get();

        // Assert
        expect(listStandard).to.have.been.calledTwice;
        expect(options.map(option => option.value)).to.deep.equal([devices[1].id]);
    });

    it('avoids repeated requests when the token lacks device-list permission', async () => {
        // Arrange
        listStandard.rejects(new ForbiddenError('Missing scope'));

        // Act
        const first = await list.get();
        const second = await list.get();

        // Assert
        expect(first).to.deep.equal([]);
        expect(second).to.deep.equal([]);
        expect(listStandard).to.have.been.calledOnce;
        expect(adapter.log.warn).to.have.been.calledWithMatch(sinon.match('read:measuring-device'));
    });

    it('defers all data transfers after a rate limit', async () => {
        // Arrange
        listStandard.rejects(new RateLimitError('Slow down', { retryAfter: 240 }));

        // Act
        await list.get();

        // Assert
        expect(budget.defer).to.have.been.calledWith(240);
        expect(listStandard).to.have.been.calledOnce;
    });

    it('retains cached choices without requests while the shared API budget is blocked', async () => {
        // Arrange
        const cached = await list.get();
        clock.tick(60_000);
        budget.available = false;

        // Act
        const options = await list.get();

        // Assert
        expect(options).to.deep.equal(cached);
        expect(listStandard).to.have.been.calledOnce;
    });

    it('does not request a list after unload', async () => {
        // Arrange
        const abort = new AbortController();
        abort.abort();

        // Act
        const options = await list.get(abort.signal);

        // Assert
        expect(options).to.deep.equal([]);
        expect(listStandard).not.to.have.been.called;
        expect(budget.acquire).not.to.have.been.called;
    });
});
