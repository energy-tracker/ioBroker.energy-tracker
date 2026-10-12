import { expect } from 'chai';
import sinon from 'sinon';
import { migrateLegacyInstances } from '../src/lib/migration';

const legacyInstance = (id: number, enabled = true, host = 'local'): ioBroker.InstanceObject => ({
    _id: `system.adapter.energy-tracker.${id}`,
    type: 'instance',
    instanceObjects: [],
    objects: [],
    common: {
        name: 'energy-tracker',
        version: '1.0.0',
        installedVersion: '1.0.0',
        materialize: true,
        platform: 'Javascript/Node.js',
        mode: 'schedule',
        host,
        enabled,
        schedule: '15 3 * * *',
    },
    native: {
        bearerToken: 'encrypted-original-token',
        devices: [{ deviceId: 'old-device', sourceState: 'meter.total', allowRounding: false }],
        timeoutRetries: 2,
        retryDelay: 5,
        sendEnabled: false,
        sendSchedule: '0 0 * * 0',
    },
});

describe('Instance migration during installation and startup', () => {
    let instances: Record<string, ioBroker.InstanceObject>;
    let adapter: ioBroker.Adapter;
    let write: sinon.SinonStub;

    beforeEach(() => {
        instances = { 'system.adapter.energy-tracker.0': legacyInstance(0) };
        write = sinon.stub().callsFake((id: string, object: ioBroker.InstanceObject) => {
            instances[id] = object;
            return Promise.resolve();
        });
        adapter = {
            host: 'local',
            namespace: 'energy-tracker.0',
            getForeignObjectsAsync: sinon.stub().callsFake(() => Promise.resolve(instances)),
            setForeignObjectAsync: write,
            log: { info: sinon.stub() },
        } as unknown as ioBroker.Adapter;
    });
    afterEach(() => sinon.restore());

    it('moves the legacy CRON and preserves credentials, devices and instance state', async () => {
        // Arrange
        const original = structuredClone(instances['system.adapter.energy-tracker.0']);

        // Act
        const ownChanged = await migrateLegacyInstances(adapter);
        const updated = instances[original._id];

        // Assert
        const expected = structuredClone(original);
        expected.common.mode = 'daemon';
        delete expected.common.schedule;
        expected.native.sendSchedule = '15 3 * * *';
        expected.native.sendEnabled = true;
        delete expected.native.timeoutRetries;
        delete expected.native.retryDelay;
        expect(updated).to.deep.equal(expected);
        expect(write).to.have.been.calledOnce;
        expect(ownChanged).to.equal(true);
    });

    it('migrates disabled local instances without enabling them', async () => {
        // Arrange
        instances['system.adapter.energy-tracker.1'] = legacyInstance(1, false);

        // Act
        await migrateLegacyInstances(adapter);

        // Assert
        expect(instances['system.adapter.energy-tracker.1'].common.mode).to.equal('daemon');
        expect(instances['system.adapter.energy-tracker.1'].common.enabled).to.equal(false);
        expect(instances['system.adapter.energy-tracker.1'].native.sendSchedule).to.equal('15 3 * * *');
        expect(write).to.have.been.calledTwice;
    });

    it('leaves remote instances and new daemon configurations untouched', async () => {
        // Arrange
        instances['system.adapter.energy-tracker.1'] = legacyInstance(1, true, 'remote');
        const fresh = legacyInstance(2);
        fresh.common.mode = 'daemon';
        delete fresh.common.schedule;
        delete fresh.native.timeoutRetries;
        delete fresh.native.retryDelay;
        instances[fresh._id] = fresh;
        const unchanged = structuredClone([instances['system.adapter.energy-tracker.1'], fresh]);

        // Act
        await migrateLegacyInstances(adapter);

        // Assert
        expect(write).to.have.been.calledOnce;
        expect([instances['system.adapter.energy-tracker.1'], instances[fresh._id]]).to.deep.equal(unchanged);
    });

    it('copies a remaining legacy schedule even if the mode was already updated', async () => {
        // Arrange
        instances['system.adapter.energy-tracker.0'].common.mode = 'daemon';

        // Act
        await migrateLegacyInstances(adapter);

        // Assert
        expect(instances['system.adapter.energy-tracker.0'].native.sendSchedule).to.equal('15 3 * * *');
        expect(instances['system.adapter.energy-tracker.0'].common).not.to.have.property('schedule');
    });

    it('removes obsolete retry controls without changing an existing daemon sender', async () => {
        // Arrange
        const instance = instances['system.adapter.energy-tracker.0'];
        instance.common.mode = 'daemon';
        delete instance.common.schedule;
        instance.native.sendEnabled = false;
        instance.native.sendSchedule = '0 8 * * *';
        const expected = structuredClone(instance);
        delete expected.native.timeoutRetries;
        delete expected.native.retryDelay;

        // Act
        await migrateLegacyInstances(adapter);

        // Assert
        expect(instances[instance._id]).to.deep.equal(expected);
        expect(write).to.have.been.calledOnce;
    });

    it('is idempotent and retains later sender configuration changes', async () => {
        // Arrange
        await migrateLegacyInstances(adapter);
        instances['system.adapter.energy-tracker.0'].native.sendSchedule = '0 8 * * *';
        instances['system.adapter.energy-tracker.0'].native.sendEnabled = false;
        write.resetHistory();
        const changed = structuredClone(instances['system.adapter.energy-tracker.0']);

        // Act
        const ownChanged = await migrateLegacyInstances(adapter);

        // Assert
        expect(write).not.to.have.been.called;
        expect(ownChanged).to.equal(false);
        expect(instances[changed._id]).to.deep.equal(changed);
    });

    it('does not enable an empty legacy sender placeholder', async () => {
        // Arrange
        instances['system.adapter.energy-tracker.0'].native.devices = [
            { deviceId: '', sourceState: '', allowRounding: true },
        ];

        // Act
        await migrateLegacyInstances(adapter);

        // Assert
        expect(instances['system.adapter.energy-tracker.0'].native.sendEnabled).to.equal(false);
    });

    it('uses the previous default schedule when a legacy schedule is absent', async () => {
        // Arrange
        delete instances['system.adapter.energy-tracker.0'].common.schedule;

        // Act
        await migrateLegacyInstances(adapter);

        // Assert
        expect(instances['system.adapter.energy-tracker.0'].common.mode).to.equal('daemon');
        expect(instances['system.adapter.energy-tracker.0'].native.sendSchedule).to.equal('0 0 * * 0');
        expect(instances['system.adapter.energy-tracker.0'].native.sendEnabled).to.equal(true);
    });

    it('preserves an invalid legacy CRON for correction', async () => {
        // Arrange
        instances['system.adapter.energy-tracker.0'].common.schedule = 'broken';

        // Act
        await migrateLegacyInstances(adapter);

        // Assert
        expect(instances['system.adapter.energy-tracker.0'].native.sendSchedule).to.equal('broken');
    });

    it('does not modify objects returned by the database', async () => {
        // Arrange
        const snapshot = instances['system.adapter.energy-tracker.0'];
        const before = structuredClone(snapshot);

        // Act
        await migrateLegacyInstances(adapter);

        // Assert
        expect(snapshot).to.deep.equal(before);
    });

    it('fails without changing instance settings when storage is unavailable', async () => {
        // Arrange
        write.rejects(new Error('Database unavailable'));
        const before = structuredClone(instances);

        // Act
        const error = await migrateLegacyInstances(adapter).catch((failure: unknown) => failure);

        // Assert
        expect(error).to.be.instanceOf(Error);
        expect(instances).to.deep.equal(before);
    });

    it('rejects an unknown local host before reading or writing instances', async () => {
        // Arrange
        adapter.host = undefined;

        // Act
        const error = await migrateLegacyInstances(adapter).catch((failure: unknown) => failure);

        // Assert
        expect(error).to.be.instanceOf(Error);
        expect(adapter.getForeignObjectsAsync).not.to.have.been.called;
        expect(write).not.to.have.been.called;
    });
});
