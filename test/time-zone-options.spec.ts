import { expect } from 'chai';
import { timeZoneOptions } from '../src/lib/time-zone-options';

describe('Time zone selection', () => {
    it('offers device defaults, UTC and searchable IANA identifiers without duplicates', () => {
        // Arrange
        const language = 'de';

        // Act
        const options = timeZoneOptions(language);

        // Assert
        expect(options[0]).to.deep.equal({ value: '', label: 'timeZoneDevice' });
        expect(options.some(option => option.value === 'UTC')).to.equal(true);
        expect(options.find(option => option.value === 'Europe/Berlin')?.label).to.include('Europe/Berlin');
        expect(new Set(options.map(option => option.value)).size).to.equal(options.length);
    });

    it('localizes display names while retaining the same stored identifier', () => {
        // Arrange
        const zone = 'Europe/Berlin';

        // Act
        const german = timeZoneOptions('de').find(option => option.value === zone);
        const english = timeZoneOptions('en').find(option => option.value === zone);

        // Assert
        expect(german?.value).to.equal(english?.value);
        expect(german?.label).to.include('Mitteleuropäische Zeit');
        expect(english?.label).to.include('Central European Time');
    });

    it('preserves a valid saved alias without offering invalid identifiers', () => {
        // Arrange
        const alias = 'US/Eastern';

        // Act
        const retained = timeZoneOptions('en', alias);
        const invalid = timeZoneOptions('en', 'invalid/timezone');

        // Assert
        expect(retained.some(option => option.value === alias)).to.equal(true);
        expect(invalid.some(option => option.value === 'invalid/timezone')).to.equal(false);
    });

    it('uses English when ioBroker has no configured language yet', () => {
        // Arrange
        const language = '';

        // Act
        const options = timeZoneOptions(language);

        // Assert
        expect(options.find(option => option.value === 'Europe/Berlin')?.label).to.include('Central European Time');
    });
});
