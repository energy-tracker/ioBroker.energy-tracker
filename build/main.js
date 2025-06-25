"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
const utils = __importStar(require("@iobroker/adapter-core"));
const energy_tracker_api_1 = require("./lib/energy-tracker-api");
class EnergyTracker extends utils.Adapter {
    api;
    constructor(options = {}) {
        super({
            ...options,
            name: 'energy-tracker',
        });
        this.on('ready', this.onReady.bind(this));
    }
    async onReady() {
        this.api = new energy_tracker_api_1.EnergyTrackerApi(this);
        await this.setState('info.connection', { val: false, ack: true });
        if (!this.config.bearerToken) {
            this.terminate('Missing bearer token in adapter configuration – skipping adapter start.');
            return;
        }
        if (!Array.isArray(this.config.devices) || this.config.devices.length === 0) {
            this.terminate('No devices configured in adapter settings – skipping adapter start.');
            return;
        }
        for (const device of this.config.devices) {
            if (!device.deviceId || !device.sourceState) {
                this.log.warn(`[${device.sourceState}] Device config incomplete – skipping.`);
                continue;
            }
            void this.api.sendReading(device);
        }
        await this.setState('info.connection', { val: true, ack: true });
        this.terminate('Terminating scheduled adapter instance.');
    }
}
if (require.main !== module) {
    module.exports = (options) => new EnergyTracker(options);
}
else {
    (() => new EnergyTracker())();
}
