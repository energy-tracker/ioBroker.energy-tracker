declare global {
    namespace ioBroker {
        interface AdapterDevice {
            deviceId: string;
            sourceState: string;
            allowRounding: boolean;
        }

        interface AdapterConfig {
            bearerToken: string;
            devices: AdapterDevice[];
            sendEnabled?: boolean;
            sendSchedule?: string;
            readDevices?: AdapterReadDevice[];
            timeZone?: string;
            pollInterval?: number;
        }

        interface AdapterReadDevice {
            deviceId: string;
            unit?: string;
            extrapolationInterval: 'day' | 'week' | 'month' | 'quarter' | 'year';
            forecastPeriods?: number;
        }
    }
}

export {};
