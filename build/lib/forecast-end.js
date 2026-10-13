"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.forecastEnd = forecastEnd;
function forecastEnd(interval, periods, now = new Date()) {
    if (!Number.isInteger(periods) || periods < 1 || periods > 36 || !Number.isFinite(now.getTime())) {
        throw new Error('Forecast horizon must be an integer between 1 and 36');
    }
    const end = new Date(now.getTime());
    if (interval === 'day' || interval === 'week') {
        end.setUTCDate(end.getUTCDate() + periods * (interval === 'week' ? 7 : 1));
    }
    else {
        const months = { month: 1, quarter: 3, year: 12 }[interval];
        if (!months) {
            throw new Error('Invalid forecast interval');
        }
        const day = end.getUTCDate();
        end.setUTCDate(1);
        end.setUTCMonth(end.getUTCMonth() + periods * months);
        const lastDay = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 1, 0)).getUTCDate();
        end.setUTCDate(Math.min(day, lastDay));
    }
    return end;
}
