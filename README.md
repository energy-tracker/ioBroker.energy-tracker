![Logo](admin/energy-tracker.png)

# ioBroker.energy-tracker

[![NPM version](https://img.shields.io/npm/v/iobroker.energy-tracker.svg)](https://www.npmjs.com/package/iobroker.energy-tracker)
[![Downloads](https://img.shields.io/npm/dm/iobroker.energy-tracker.svg)](https://www.npmjs.com/package/iobroker.energy-tracker)
![Installations](https://iobroker.live/badges/energy-tracker-installed.svg)
![Stable version](https://iobroker.live/badges/energy-tracker-stable.svg)

Adapter for sending meter readings to the Energy Tracker platform.  
It periodically transfers values from configured ioBroker states using the public REST API.

## Requirements

- Create a personal access token at
  👉 [https://www.energy-tracker.best-ios-apps.de](https://www.energy-tracker.best-ios-apps.de)
- Obtain your standard device IDs via the public API
  👉 [View API documentation](https://www.energy-tracker.best-ios-apps.de/)

## Configuration

The following fields must be configured in the adapter:

- **Personal Access Token**
- **Device list** with:
  - `deviceId` (Energy Tracker device ID)
  - `sourceState` (ioBroker state that provides the reading)
  - Transmission interval (in hours)
  - Enable rounding of values

## Security

- The access token is stored encrypted.
- Data is only **sent** – no readings are retrieved.

## Changelog

### 0.1.2

- Fixed repository metadata and performed required minor adjustments

### 0.1.1

- Fixed repository metadata

### 0.1.0

- Initial version with full Admin UI configuration
- Supports multiple devices and configurable intervals

## Copyright

Copyright (c) 2025 energy-tracker support@best-ios-apps.de

## License

MIT – see [LICENSE](LICENSE).
