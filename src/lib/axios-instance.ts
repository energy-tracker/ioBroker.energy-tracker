import axios from 'axios';

export const energyTrackerAxios = axios.create({
    baseURL: 'https://public-api.energy-tracker.best-ios-apps.de',
    timeout: 10000,
});
