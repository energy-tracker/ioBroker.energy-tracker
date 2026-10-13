![Logo](admin/energy-tracker.png)

# ioBroker.energy-tracker

[![NPM version](https://img.shields.io/npm/v/iobroker.energy-tracker.svg)](https://www.npmjs.com/package/iobroker.energy-tracker)
[![Downloads](https://img.shields.io/npm/dm/iobroker.energy-tracker.svg)](https://www.npmjs.com/package/iobroker.energy-tracker)
![Installations](https://iobroker.live/badges/energy-tracker-installed.svg)
![Stable version](https://iobroker.live/badges/energy-tracker-stable.svg)

Send meter readings to Energy Tracker and optionally retrieve extrapolations through the public API.
Calculated values are available as read-only ioBroker states for dashboards, automations and connections to other systems.

## Requirements

Requires Node.js 22 or newer, ioBroker js-controller 6.0.11 or newer and ioBroker Admin 7.6.20 or newer.

1. **Register an account:**  
   👉 [Create your account](https://www.energy-tracker.best-ios-apps.de/en-US/register)

2. **Create a personal access token** (login required)  
   👉 [Generate token](https://www.energy-tracker.best-ios-apps.de/de/login?next=%2Faccount%2Faccess-token)

3. **Save the token in the adapter**, then select your Energy Tracker devices when its permissions allow listing them, or enter their IDs directly. Choose reading sources from ioBroker's state selector.

## Configuration

Configure the token and the options for the features you enable:

- **Personal Access Token** with permissions for the operations you select (see below)
- **Send readings** (when submission is enabled) with:
    - `deviceId` (select by name and folder, or enter the Energy Tracker device ID)
    - `sourceState` (ioBroker state selected from the object browser)
    - Enable server-side rounding of values

Source states may contain numbers or plain decimal strings. Use decimal strings when exact decimal precision is required.
Values are truncated to the API limit of six decimal places before sending; `allowRounding` controls server-side rounding to the meter's precision.

### Token information and device selection

Opening the adapter configuration checks the saved token. Entering a complete personal access token (JWT) also checks it automatically after a short pause, before saving. A compact hint below the field shows the token name, expiry in UTC and granted permissions. The token’s UUID alone is not a credential. The information is displayed live and is not stored in ioBroker states or configuration. **Check again** requests an immediate update when the API allowance permits it. Checking does not submit readings or retrieve calculations, and the status endpoint is never polled. Checks are spaced at least 61 seconds apart; during this waiting time the view receives the result already held in memory. Only the request allowance, including a server `Retry-After`, is retained across restarts and token changes. Draft checks never change the saved credential or run the sending/retrieval workflows. Save token changes before selecting devices or using the token for these workflows.

When the checked token has device-read permission, the configuration offers standard devices returned by the SDK, with names, folders and their original IDs. Otherwise, enter the device ID directly; no device-list request is made. Device-read permission is optional. Both configuration lists share a cache lasting one minute and a single in-flight request. Device listing uses the same request spacing and cooldown as sending and calculation retrieval. Native ioBroker cards keep the device and source fields on separate lines. Existing device IDs and source mappings are preserved during upgrades.

### Sending readings

Select **Enable reading submission**, configure the source states under **Send readings**, and choose the **Reading submission schedule**. The adapter runs continuously and sends only at the selected CRON times, using the ioBroker host's local time zone. For example, `0 * * * *` sends hourly and `0 0 * * *` sends daily at midnight.

Submission and calculation retrieval have independent schedules. Sending does not trigger a calculation request; polling does not submit a reading. The same instance can send, retrieve, or do both. New installations have submission disabled until explicitly enabled. Restarting the adapter does not submit a reading or replay missed schedule times. Slow submission batches never overlap. Source values are sampled when their request slot is ready.

Reading submission automatically retries timeouts and HTTP 5xx errors up to five times. The waits after successive failures are 2, 5, 10, 30 and 60 seconds; shared request spacing or API cooldowns can delay an attempt further. Every attempt uses the same value and timestamp. Other errors stop the sequence, including HTTP 409 conflicts and HTTP 429 rate limits. A conflict after a retry leaves delivery uncertain and requires checking the reading in Energy Tracker. This retry policy is internal and has no configuration controls.

As with ioBroker's cloud schedules, a five-field CRON receives a random delay of 0–59 seconds. A six-field CRON keeps its explicitly configured seconds. `info.sending.nextRun` reports the next scheduled batch; `lastRun` and `available` report the last completed batch.

### Upgrading to 2.0.0

Version 2.0.0 changes the adapter from scheduled execution to continuous `daemon` mode. The install hook and the first adapter startup migrate existing instances on the local host: their previous CRON becomes **Reading submission schedule**, and existing sender configurations remain enabled. ioBroker’s scheduled initialization starts an enabled upgraded instance without waiting for its next CRON. Disabled instances remain disabled and migrate when an instance on the same host starts. Migration runs before sending or retrieval; after changing its own configuration, the adapter waits for ioBroker’s automatic restart. Empty sender configurations remain disabled. Encrypted tokens, device/source mappings, source states and enabled/disabled instance settings are retained. Obsolete retry controls are removed; reading submission uses the internal retry policy. The old instance schedule is removed after transferring it; repeated installations and later startups preserve user changes.

Extrapolation retrieval remains optional and is enabled by configuring **Retrieve extrapolations**. The previous instance schedule no longer controls the adapter process; edit the submission schedule inside the adapter configuration. An invalid migrated CRON is retained for correction and disables sending without stopping extrapolation retrieval.

### Retrieving extrapolations

1. Add your standard measuring device IDs to **Retrieve extrapolations**. Use the UUID without the `std-` prefix. No source state is required.
2. Select that device's **Calendar interval**: day, week, month, quarter or year.
3. Set that device's **Look-ahead** to 1–36 intervals (default: three). Month with three intervals requests an end date three calendar months ahead.
4. Optionally enter the device's unit, such as `kWh`, `m³` or `L`. The API does not include units; the adapter does not convert values.
5. Choose the **Polling pause** in the adapter configuration. Extrapolation retrieval runs independently of the reading submission schedule.

The polling dropdown offers 60, 120, 300, 900 and 3600 seconds, with 60 seconds as the default and minimum. The pause starts after a complete cycle; calculation cycles never overlap. Calculation requests and reading submissions share persistent spacing of at least five seconds, including timeout retries. For many resources, the pause is increased to at least five seconds per selected resource. Check `info.polling.effectiveInterval` for the current pause.

The rolling end date is recalculated when each request starts, using UTC calendar arithmetic; month ends and leap years are clamped to the last valid day. It is sent through the existing SDK's `to` option. The platform normalizes that date to a daily boundary in the device's selected time zone and forecasts through the requested end. Estimates cover complete calendar intervals, including the interval containing the end date. No lower history filter is supplied, so the complete available device history remains the calculation basis.

Each configured device makes one extrapolation request per cycle. Interval and look-ahead settings belong to each device; the polling pause is shared. Forecasting beyond recorded history requires the platform's support for `to` as the extrapolation end; the API client remains unchanged.

**Time zone** offers a searchable dropdown generated from the runtime's IANA identifiers and localized display names. Leave it empty to use each device's time zone, or select an override such as `Europe/Berlin`.

### Token permissions

| Operation       | Required permission                                            |
| --------------- | -------------------------------------------------------------- |
| Token status    | No additional permission                                       |
| Device dropdown | Optional: `read:measuring-device` or legacy `measuring-device` |
| Send readings   | `write:meter-reading` or legacy `meter-reading`                |
| Extrapolation   | `read:extrapolation`                                           |

Retrieval does not request raw meter readings or require meter-reading read permission. Device-list permission is used only for the configuration dropdowns; existing device IDs remain usable without it. The API validates the configured token and its permissions on each sending or retrieval request.

### Using the calculated states

For each configured device, states are created below:

```text
energy-tracker.0.devices.<device-id>.extrapolation.*
```

| State              | Meaning                                                                                 |
| ------------------ | --------------------------------------------------------------------------------------- |
| `json`             | Complete API result array, including terminal points with zero duration; ISO timestamps |
| `date`             | Period start of the latest usable extrapolation                                         |
| `actualValue`      | Reading-backed consumption or production for that point                                 |
| `actualDuration`   | Reading-backed duration in seconds                                                      |
| `expectedValue`    | Estimated total for the full period; do **not** add `actualValue`                       |
| `expectedDuration` | Nominal full-period duration in seconds (24 hours per calendar day)                     |
| `interval`         | Selected calendar interval                                                              |
| `available`        | Last retrieval succeeded; the result may still be empty                                 |
| `lastUpdated`      | Last successful retrieval time in Unix milliseconds                                     |

Extrapolation scalar values include forecast-only periods with a positive nominal duration, even when their actual duration is zero. Zero-duration terminal placeholders are skipped. Insufficient history produces `[]` and `null` scalar values, rather than a fabricated zero consumption. Failed or denied retrievals set `available=false` and retain the last successful data and timestamp. Removed devices have their objects removed on the next configured start.

Use `json` as a complete snapshot, or trigger on `lastUpdated` after the scalar states have been written. Check `available`, the result's `date` and its durations before acting. A successful retrieval can still describe an older or partial period; these are calculated historical values and estimates, not live power measurements. Local automations and other integrations may consume these states without additional calls to Energy Tracker.

### Request limits and recovery

The current API budget is 120 requests per five minutes per IP and API instance, shared by calculations and other endpoints using that limit. This adapter spaces calculation requests and reading submissions to stay within 60 per five minutes per adapter instance. Other adapter instances and other applications behind the same IP also consume server capacity; the adapter cannot guarantee that HTTP 429 will never occur.

On HTTP 429, the remaining data transfers are skipped and the server's `Retry-After` is persisted across restarts, with a one-second margin (five minutes when unspecified). Calculation polling increases its pause after unsuccessful cycles, up to 15 minutes or the configured interval if longer, and returns to the configured interval after recovery. Calculations are not immediately retried. Authentication and permission failures are reported through availability and logs.

## Security

- The access token is stored encrypted.
- Optional retrieval uses the token's calculation read permissions and the API's device ownership checks.
- The token remains in encrypted adapter configuration.
- Retrieved values stay in the local ioBroker states; the adapter does not forward them to another service.

## Changelog

### 2.0.0

- Retry reading submissions automatically after timeouts or HTTP 5xx errors with waits of 2, 5, 10, 30 and 60 seconds.
- Check tokens automatically on input and when opening the configuration, with live name, expiry and permission hints and an explicit recheck button.
- Offer device selection when permitted by the token, with manual IDs otherwise, and an ioBroker source-state selector in readable cards.
- Change to continuous operation and migrate existing reading schedules during installation or upgrade.
- Retrieve calculated values independently of the existing reading submission schedule.
- Retrieve extrapolations with individual calendar intervals and rolling look-ahead horizons, read-only states and complete JSON arrays.
- Select time zones from searchable IANA identifiers with localized display names.
- Add continuous retrieval with a configurable pause of at least one minute, sequential requests, rate-limit cooldown and error backoff.
- Distinguish empty results, failed retrievals, reading-backed values and full-period estimates.

### 1.0.0

**Before upgrading:** Node.js 22 or newer, ioBroker js-controller 6.0.11 or newer and ioBroker Admin 7.6.20 or newer are required.

- Send readings through the Energy Tracker SDK and API v3.
- Truncate readings to six decimal places before sending.
- Fix connection status for failed or incomplete batches.
- Add optional timeout retries with a fixed reading timestamp.
- Require Node.js 22 or newer and test on Node.js 22, 24 and 26.
- Update dependencies, release tools and adapter metadata.
- Publish releases through npm trusted publishing.

### 0.3.1

- Cleaned up dev dependencies and updated the admin adapter to version 7.6.17.

### 0.3.0

- Updated all adapter dependencies to current stable versions.
- Updated the API endpoint for submitting meter readings to the new v2 API.
- General maintenance and compatibility improvements.

### 0.2.8

- Improved API reliability, added request timeout, and addressed review feedback.

### 0.2.7

- Updated ESLint to v9, fixed repository URL in package.json, and improved test coverage.

[Older changes](https://github.com/energy-tracker/ioBroker.energy-tracker/blob/main/CHANGELOG_OLD.md)

## License

MIT – see [LICENSE](LICENSE).

Copyright (c) 2017-2026 Bluefox <dogafox@gmail.com>  
Copyright (c) 2015-2026 energy-tracker support@energy-tracker.app
