/**
 * @param language ioBroker's configured language
 * @param selected Existing IANA identifier, including valid aliases
 * @returns Searchable time zones with localized names, without a maintained zone list
 */
export function timeZoneOptions(language = 'en', selected?: unknown): { value: string; label: string }[] {
    const locale = language || 'en';
    const zones = new Set(['UTC', ...Intl.supportedValuesOf('timeZone')]);
    if (typeof selected === 'string' && selected) {
        try {
            new Intl.DateTimeFormat(locale, { timeZone: selected });
            zones.add(selected);
        } catch {
            // Invalid saved values must be corrected using the supported choices.
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
