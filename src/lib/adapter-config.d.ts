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
        }
    }
}

export {};
