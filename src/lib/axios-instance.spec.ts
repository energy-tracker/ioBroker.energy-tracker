import { expect } from 'chai';
import { energyTrackerAxios } from './axios-instance';

describe('energyTrackerAxios', () => {
    it('should have the correct baseURL', () => {
        expect(energyTrackerAxios.defaults.baseURL).to.equal('https://public-api.energy-tracker.best-ios-apps.de');
    });

    it('should have the correct timeout', () => {
        expect(energyTrackerAxios.defaults.timeout).to.equal(10000);
    });
});
