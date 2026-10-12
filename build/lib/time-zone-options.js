"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.timeZoneOptions = timeZoneOptions;
function timeZoneOptions(language = 'en', selected) {
    const locale = language || 'en';
    const zones = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);
    if (typeof selected === 'string' && selected) {
        try {
            new Intl.DateTimeFormat(locale, { timeZone: selected });
            zones.add(selected);
        }
        catch {
        }
    }
    return [
        { value: '', label: 'timeZoneDevice' },
        ...[...zones].sort().map(value => {
            const name = new Intl.DateTimeFormat(locale, { timeZone: value, timeZoneName: 'longGeneric' })
                .formatToParts()
                .find(part => part.type === 'timeZoneName')?.value;
            return { value, label: `${value} — ${name}` };
        }),
    ];
}
