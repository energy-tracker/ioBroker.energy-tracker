"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.energyTrackerAxios = void 0;
const axios_1 = __importDefault(require("axios"));
exports.energyTrackerAxios = axios_1.default.create({
    baseURL: 'https://public-api.energy-tracker.best-ios-apps.de',
    timeout: 10000,
});
