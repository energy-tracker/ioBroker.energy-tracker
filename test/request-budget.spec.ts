import { expect } from 'chai';
import sinon from 'sinon';
import 'sinon-chai';
import proxyquire from 'proxyquire';
import type { RequestBudget as BudgetType } from '../src/lib/request-budget';
import { pollingInterval } from '../src/lib/request-budget';
import { captureError } from './helpers';

describe('Shared data request budget', () => {
    let adapter: sinon.SinonStubbedInstance<ioBroker.Adapter>;
    let clock: sinon.SinonFakeTimers;
    let wait: sinon.SinonStub;
    let Budget: new (adapter: ioBroker.Adapter) => BudgetType;
    let states: Map<string, ioBroker.StateValue>;

    beforeEach(() => {
        clock = sinon.useFakeTimers({ now: Date.parse('2026-10-11T12:00:00Z'), toFake: ['Date'] });
        states = new Map();
        adapter = {
            getStateAsync: sinon.stub().callsFake((id: string) => Promise.resolve({ val: states.get(id) })),
            setStateAsync: sinon.stub().callsFake((id: string, state: ioBroker.SettableState) => {
                states.set(id, state.val ?? null);
                return Promise.resolve();
            }),
        } as unknown as sinon.SinonStubbedInstance<ioBroker.Adapter>;
        wait = sinon.stub().callsFake((ms: number) => {
            clock.tick(ms);
            return Promise.resolve();
        });
        Budget = proxyquire
            .noCallThru()
            .load('../src/lib/request-budget', { 'node:timers/promises': { setTimeout: wait } }).RequestBudget;
    });
    afterEach(() => sinon.restore());

    it('restores the five-second request spacing after restart', async () => {
        // Arrange
        const previous = new Budget(adapter);
        await previous.acquire();
        const restarted = new Budget(adapter);
        await restarted.restore();

        // Act
        await restarted.acquire();

        // Assert
        expect(wait).to.have.been.calledWith(5000);
        expect(states.get('info.polling.nextRequestAt')).to.equal(Date.now() + 5000);
    });

    it('limits a busy instance to at most 60 requests within a five-minute window', async () => {
        // Arrange
        const budget = new Budget(adapter);
        const start = Date.now();

        // Act
        for (let i = 0; i < 61; i++) {
            await budget.acquire();
        }

        // Assert
        expect(Date.now() - start).to.be.at.least(300_000);
    });

    it('serializes simultaneous reservations from polling and submission', async () => {
        // Arrange
        const budget = new Budget(adapter);
        const start = Date.now();

        // Act
        await Promise.all([budget.acquire(), budget.acquire(), budget.acquire()]);

        // Assert
        expect(Date.now() - start).to.equal(10_000);
        expect(wait).to.have.been.calledTwice;
        expect(states.get('info.polling.nextRequestAt')).to.equal(start + 15_000);
    });

    it('rechecks a cooldown added while another request is waiting for spacing', async () => {
        // Arrange
        const budget = new Budget(adapter);
        await budget.acquire();
        wait.onFirstCall().callsFake(async (ms: number) => {
            clock.tick(ms);
            await budget.defer(600);
        });

        // Act
        await budget.acquire();

        // Assert
        expect(wait.firstCall.args[0]).to.equal(5000);
        expect(wait.secondCall.args[0]).to.equal(601_000);
        expect(budget.available).to.equal(true);
    });

    it('respects a persistent HTTP 429 cooldown after restart', async () => {
        // Arrange
        await new Budget(adapter).defer(600);
        const restarted = new Budget(adapter);
        await restarted.restore();
        const availableBeforeWaiting = restarted.available;

        // Act
        await restarted.acquire();

        // Assert
        expect(availableBeforeWaiting).to.equal(false);
        expect(wait).to.have.been.calledWith(601_000);
        expect(restarted.available).to.equal(true);
    });

    it('uses a five-minute cooldown when Retry-After is absent', async () => {
        // Arrange
        const budget = new Budget(adapter);

        // Act
        await budget.defer(null);

        // Assert
        expect(states.get('info.polling.nextAllowedAt')).to.equal(Date.now() + 301_000);
    });

    it('never shortens a longer cooldown reported by another in-flight transfer', async () => {
        // Arrange
        const budget = new Budget(adapter);
        await budget.defer(600);
        const deadline = budget.nextAllowedAt;
        clock.tick(1000);

        // Act
        await budget.defer(42);

        // Assert
        expect(budget.nextAllowedAt).to.equal(deadline);
        expect(states.get('info.polling.nextAllowedAt')).to.equal(deadline);
    });

    it('cancels request spacing without reserving another request', async () => {
        // Arrange
        const budget = new Budget(adapter);
        await budget.acquire();
        const reservation = states.get('info.polling.nextRequestAt');
        const controller = new AbortController();
        wait.callsFake(() => {
            controller.abort();
            return Promise.resolve();
        });

        // Act
        const error = await budget.acquire(controller.signal).catch((failure: unknown) => failure);

        // Assert
        expect(error).to.equal(controller.signal.reason);
        expect(states.get('info.polling.nextRequestAt')).to.equal(reservation);
    });

    it('allows a new reservation after a queued request was cancelled', async () => {
        // Arrange
        const budget = new Budget(adapter);
        const signal = AbortSignal.abort();

        // Act
        const error = await budget.acquire(signal).catch((failure: unknown) => failure);
        await budget.acquire();

        // Assert
        expect(error).to.equal(signal.reason);
        expect(adapter.setStateAsync).to.have.been.calledOnce;
        expect(states.get('info.polling.nextRequestAt')).to.equal(Date.now() + 5000);
    });

    it('uses the one-minute minimum for an empty calculation configuration', () => {
        // Arrange
        const devices: ioBroker.AdapterReadDevice[] = [];

        // Act
        const interval = pollingInterval(60, devices);

        // Assert
        expect(interval).to.equal(60);
    });

    it('increases the polling pause for many calculation resources', () => {
        // Arrange
        const device: ioBroker.AdapterReadDevice = {
            deviceId: 'device',
            extrapolationInterval: 'month',
        };
        const devices = Array(20).fill(device);

        // Act
        const interval = pollingInterval(60, devices);

        // Assert
        expect(interval).to.equal(100);
    });

    it('rejects a polling pause below the selectable minimum', () => {
        // Arrange
        const devices: ioBroker.AdapterReadDevice[] = [];

        // Act
        const error = captureError(() => pollingInterval(20, devices));

        // Assert
        expect(error).to.be.instanceOf(Error);
        expect(String(error)).to.include('Polling interval');
    });
});
