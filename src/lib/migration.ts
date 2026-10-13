export const DEFAULT_SEND_SCHEDULE = '0 0 * * 0';

/**
 * Move legacy schedules and remove obsolete retry options on this host.
 * Runs during installation and startup, before any sending or retrieval.
 *
 * @param adapter Installer with access to local instance objects
 * @returns Whether the current instance changed and must wait for the controller's configuration restart
 */
export async function migrateLegacyInstances(adapter: ioBroker.Adapter): Promise<boolean> {
    if (!adapter.host) {
        throw new Error('Cannot migrate instances without the local ioBroker host');
    }
    const instances = await adapter.getForeignObjectsAsync('system.adapter.energy-tracker.*', 'instance');
    let ownInstanceChanged = false;
    for (const [id, instance] of Object.entries(instances)) {
        if (!/^system\.adapter\.energy-tracker\.\d+$/.test(id) || instance.common.host !== adapter.host) {
            continue;
        }
        const legacySchedule = instance.common.mode === 'schedule' || typeof instance.common.schedule === 'string';
        const legacyRetries =
            Object.hasOwn(instance.native, 'timeoutRetries') || Object.hasOwn(instance.native, 'retryDelay');
        if (!legacySchedule && !legacyRetries) {
            continue;
        }
        const migrated = structuredClone(instance);
        if (legacySchedule) {
            migrated.common.mode = 'daemon';
            migrated.native.sendSchedule = instance.common.schedule ?? DEFAULT_SEND_SCHEDULE;
            migrated.native.sendEnabled =
                Array.isArray(instance.native.devices) &&
                instance.native.devices.some(device => device?.deviceId || device?.sourceState);
            delete migrated.common.schedule;
        }
        delete migrated.native.timeoutRetries;
        delete migrated.native.retryDelay;
        await adapter.setForeignObjectAsync(id, migrated);
        ownInstanceChanged ||= id === `system.adapter.${adapter.namespace}`;
        adapter.log.info(`${id}: migrated instance configuration.`);
    }
    return ownInstanceChanged;
}
