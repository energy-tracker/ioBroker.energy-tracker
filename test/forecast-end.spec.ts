import { expect } from 'chai';
import { forecastEnd } from '../src/lib/forecast-end';
import { captureError } from './helpers';

describe('Rolling forecast horizon', () => {
    for (const [interval, now, periods, expected] of [
        ['day', '2026-10-24T12:30:00Z', 3, '2026-10-27T12:30:00.000Z'],
        ['week', '2026-12-20T12:30:00Z', 3, '2027-01-10T12:30:00.000Z'],
        ['month', '2026-10-12T12:30:00Z', 3, '2027-01-12T12:30:00.000Z'],
        ['month', '2026-01-31T12:30:00Z', 1, '2026-02-28T12:30:00.000Z'],
        ['month', '2024-01-31T12:30:00Z', 1, '2024-02-29T12:30:00.000Z'],
        ['quarter', '2026-08-31T12:30:00Z', 1, '2026-11-30T12:30:00.000Z'],
        ['year', '2024-02-29T12:30:00Z', 1, '2025-02-28T12:30:00.000Z'],
    ] as const) {
        it(`adds ${periods} ${interval} units to ${now} without calendar overflow`, () => {
            // Arrange
            const start = new Date(now);

            // Act
            const end = forecastEnd(interval, periods, start);

            // Assert
            expect(end.toISOString()).to.equal(expected);
            expect(start.toISOString()).to.equal(new Date(now).toISOString());
        });
    }

    for (const periods of [0, -1, 1.5, 37, NaN, Infinity]) {
        it(`rejects invalid horizon ${periods}`, () => {
            // Arrange
            const interval = 'month';

            // Act
            const error = captureError(() => forecastEnd(interval, periods));

            // Assert
            expect(error).to.be.instanceOf(Error);
        });
    }
});
