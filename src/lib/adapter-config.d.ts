declare global {
  namespace ioBroker {
    interface AdapterDevice {
      deviceId: string;
      sourceState: string;
      sendIntervalHours: number;
      allowRounding: boolean;
    }

    interface AdapterConfig {
      bearerToken: string;
      devices: AdapterDevice[];
    }
  }
}

export {};
