const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { fork } = require('node:child_process');
const { tests } = require('@iobroker/testing');

const adapterRoot = path.join(__dirname, '..');
const packageName = require(path.join(adapterRoot, 'package.json')).name;

async function runInstaller() {
    const testAdapterDir = path.join(os.tmpdir(), `test-${packageName}`, 'node_modules', packageName);
    const installer = fork(path.join(testAdapterDir, 'build', 'main.js'), ['--install'], {
        cwd: testAdapterDir,
        silent: true,
        signal: AbortSignal.timeout(15000),
    });
    let output = '';
    installer.stdout.on('data', chunk => (output += chunk));
    installer.stderr.on('data', chunk => (output += chunk));
    const code = await new Promise((resolve, reject) => {
        installer.once('error', reject);
        installer.once('exit', resolve);
    });
    return { code, output };
}

tests.integration(adapterRoot, {
    defineAdditionalTests({ suite }) {
        for (const enabled of [true, false]) {
            suite(`Upgrade scheduled installations (enabled: ${enabled})`, getHarness => {
                it('migrates through the install hook and preserves later configuration changes', async function () {
                    // Arrange
                    this.timeout(30000);
                    const harness = getHarness();
                    const sourceId = '0_userdata.0.energyTrackerMigrationMeter';
                    await harness.changeAdapterConfig('energy-tracker', {
                        common: { enabled, mode: 'schedule', schedule: '15 3 * * *' },
                        native: {
                            bearerToken: 'local-migration-test-token',
                            devices: [{ deviceId: 'old-device', sourceState: sourceId, allowRounding: false }],
                            timeoutRetries: 2,
                            retryDelay: 5,
                        },
                    });
                    const original = await harness.objects.getObjectAsync('system.adapter.energy-tracker.0');
                    const disabled = structuredClone(original);
                    disabled._id = 'system.adapter.energy-tracker.1';
                    disabled.common.enabled = false;
                    disabled.common.schedule = '30 4 * * *';
                    await harness.objects.setObjectAsync(disabled._id, disabled);
                    const sourceObject = {
                        _id: sourceId,
                        type: 'state',
                        common: {
                            name: 'Existing meter',
                            type: 'number',
                            role: 'value',
                            unit: 'kWh',
                            read: true,
                            write: true,
                        },
                        native: {},
                    };
                    await harness.objects.setObjectAsync(sourceId, sourceObject);
                    await harness.states.setStateAsync(sourceId, { val: 1234.56789, ack: true });
                    await harness.states.setStateAsync('energy-tracker.0.info.connection', { val: true, ack: true });
                    const sourceBefore = await harness.objects.getObjectAsync(sourceId);
                    const readingBefore = await harness.states.getStateAsync(sourceId);
                    const connectionBefore = await harness.states.getStateAsync('energy-tracker.0.info.connection');

                    // Act
                    const first = await runInstaller();
                    const migrated = await harness.getAdapterConfig();
                    const rawMigrated = await harness.objects.getObjectAsync(original._id);
                    const disabledAfter = await harness.objects.getObjectAsync(disabled._id);
                    await harness.changeAdapterConfig('energy-tracker', {
                        native: { sendEnabled: false, sendSchedule: '0 8 * * *' },
                    });
                    const repeated = await runInstaller();
                    const configured = await harness.getAdapterConfig();
                    const sourceAfter = await harness.objects.getObjectAsync(sourceId);
                    const readingAfter = await harness.states.getStateAsync(sourceId);
                    const connectionAfter = await harness.states.getStateAsync('energy-tracker.0.info.connection');

                    // Assert
                    assert.equal(first.code, 0, first.output);
                    assert.equal(repeated.code, 0, repeated.output);
                    assert.equal(migrated.common.install, true);
                    assert.equal(migrated.common.mode, 'daemon');
                    assert.equal(migrated.common.enabled, enabled);
                    assert.equal(migrated.common.schedule, undefined);
                    assert.equal(migrated.native.sendSchedule, '15 3 * * *');
                    assert.equal(migrated.native.bearerToken, 'local-migration-test-token');
                    assert.equal(rawMigrated.native.bearerToken, original.native.bearerToken);
                    assert.equal(migrated.native.devices[0].sourceState, sourceId);
                    assert.equal(Object.hasOwn(migrated.native, 'timeoutRetries'), false);
                    assert.equal(Object.hasOwn(migrated.native, 'retryDelay'), false);
                    assert.equal(disabledAfter.common.mode, 'daemon');
                    assert.equal(disabledAfter.common.enabled, false);
                    assert.equal(disabledAfter.common.schedule, undefined);
                    assert.equal(disabledAfter.native.sendSchedule, '30 4 * * *');
                    assert.equal(configured.native.sendSchedule, '0 8 * * *');
                    assert.equal(configured.native.sendEnabled, false);
                    assert.deepEqual(sourceAfter, sourceBefore);
                    assert.deepEqual(readingAfter, readingBefore);
                    assert.deepEqual(connectionAfter, connectionBefore);
                });
            });
        }
        suite('Run daemon configuration', getHarness => {
            it('stays available without migrating or submitting at startup', async function () {
                // Arrange
                this.timeout(10000);
                const harness = getHarness();
                await harness.changeAdapterConfig('energy-tracker', {
                    common: { mode: 'daemon' },
                    native: { bearerToken: '', sendEnabled: true, sendSchedule: '15 3 * * *' },
                });

                // Act
                await harness.startAdapterAndWait();
                const configured = await harness.getAdapterConfig();
                const tokenInformation = await new Promise(resolve =>
                    harness.sendTo('energy-tracker.0', 'getTokenInfo', null, resolve),
                );
                const tokenCheck = await new Promise(resolve =>
                    harness.sendTo('energy-tracker.0', 'checkToken', null, resolve),
                );
                const deviceChoices = await new Promise(resolve =>
                    harness.sendTo('energy-tracker.0', 'getDevices', null, resolve),
                );
                const timeZones = await new Promise(resolve =>
                    harness.sendTo('energy-tracker.0', 'getTimeZones', null, resolve),
                );

                // Assert
                assert.equal(harness.didAdapterStop(), false);
                assert.equal(configured.native.sendSchedule, '15 3 * * *');
                assert.deepEqual(tokenInformation, { error: 'tokenCheckFormat' });
                assert.deepEqual(tokenCheck, { error: 'tokenCheckFormat' });
                assert.deepEqual(deviceChoices, []);
                assert.equal(
                    timeZones.some(zone => zone.value === 'Europe/Berlin'),
                    true,
                );
            });
        });
    },
});
