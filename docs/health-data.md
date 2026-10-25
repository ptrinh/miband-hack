# Health data

The **Health data** section of the webapp reads what the band has recorded (activity, heart rate,
sleep, SpO₂, stress, workouts), turns it into one documented JSON format, and lets you:

1. **Download** it as JSON, as CSV (one file per kind), and as the raw band files (.zip).
2. Let **your own AI agent** query the JSON locally through an MCP server
   ([`tools/health-mcp`](../tools/health-mcp/README.md)).

**Nothing is stored anywhere but your machine.** The data goes from the band to your browser and
into the files you download; the site has no server-side storage and never receives health data.

> **Verification status.** None of this has run against a real band yet. The protocol and the file
> layouts are reimplemented from Gadgetbridge. The fetch flow is tested against the simulated band in
> `test/fake-band.ts`. Workout summaries and manual SpO₂/stress samples are also checked against
> **real captures** taken from Gadgetbridge's test suite. Everything else is checked only against
> synthetic files written from the same understanding of the format. See [Untested](#untested).

## How fetching works

Reimplemented from Gadgetbridge's `XiaomiHealthService` and `XiaomiActivityFileFetcher` (AGPL-3.0,
read on 25/10/2026), which serve as the protocol reference. Command type **8** (health):

| Step | Phone → band | Band → phone |
|---|---|---|
| list today | `8/1 health.activitySyncRequestToday{unknown1: 0}` | `8/1 health.activityRequestFileIds` (n × 7 bytes) |
| list past | `8/2` | `8/2 health.activityRequestFileIds` |
| fetch one | `8/3 health.activityRequestFileIds = <7-byte id>` | the file, on the **activity channel** |
| ack (optional) | `8/5 health.activitySyncAckFileIds = <id>` | — |

- **Activity channel**: SPP V2 / BLE V2 channel 5, SPP V1 channel 3, BLE V1 characteristic `0x0053`.
  It is encrypted exactly like the proto channel. Each chunk is `u16 total | u16 index (1-based) | data`.
- **File**: `id(7) | 00 | body | crc32 LE` of everything before the CRC.
- **File id**: `u32 LE unix time | i8 timezone (15 min units) | u8 version | flags`. In `flags`,
  bit 7 is the type (0 activity, 1 sports), bits 2-6 are the subtype and bits 0-1 the detail type
  (0 details, 1 summary, 2 GPS track).
- Files are fetched oldest first, summaries before details. A file with a bad CRC, or that stops
  arriving for 10 s, is skipped and reported; the others still come through.
- **Ack is off by default.** Gadgetbridge acks each file, after which the band may delete it, so
  Mi Fitness would not get it any more. The webapp acks only if you tick the box.
- The band only lists files that its companion app has **not synced yet**. If Mi Fitness or Zepp
  synced recently, there may be little or nothing left to fetch. Turn off Bluetooth on the phone
  before connecting.
- The date range skips files that start after the end date or more than 36 h before the start date.
  It then filters the decoded records to the exact range.

## What is decoded

| Band file | Version(s) | Decoded into | Status |
|---|---|---|---|
| activity / daily / details | 1-4 | `activity` (per minute: steps, distance, active kcal, HR, SpO₂, stress, "energy"), plus `heartRate`, `spo2`, `stress` | full layout as in Gadgetbridge; synthetic test only |
| activity / daily / summary | 3, 4, 5 | `daily` | full; synthetic test only |
| activity / sleep_stages / details | 2 | `sleep` (totals + stage changes) | full; synthetic test only |
| activity / sleep (details or summary) | 1-5 | `sleep`; HR and SpO₂ samples during sleep; breathing rate | header, sample blocks and stage packets 16/17/0x0a. RR-interval packets (type 1) and snore levels are **not** decoded (they stay in the raw file). Synthetic test only |
| activity / manual_samples / details | 1, 2 | `heartRate`, `spo2`, `stress`, `temperature` (source `manual`) | v1 checked against **real captures**; v2 synthetic. An unknown record type ends decoding of that file (record sizes depend on the type) |
| sports / * / summary | see `workoutLayout()` in `src/health/parsers.ts` | `workouts`: start, end, active seconds, kcal, distance, steps, HR avg/max/min | **leading fields only**, checked against **real captures** (rowing v8, indoor cycling v9, outdoor cycling v3, outdoor walking v3, treadmill v9). Training effect, HR zones, pace, swim and other fields are not decoded. Unknown sport/version: start time and sport only (`decoded: false`) |
| sports / * / details, GPS track | all | — | **raw only** |
| anything else | — | — | **raw only** |

Every fetched file is always in the **raw .zip** byte for byte, with an `index.json` listing them.
Nothing is lost if a decoder is wrong or missing. The `files` array of the JSON says per file
whether it was decoded `full`, `partial` or kept `raw`, with a note.

Assumptions you should know about:

- **Temperature** (`manual_samples` type 0x44): Gadgetbridge keeps it as an opaque int. We export the
  first u16 / 100 as °C (e.g. `5a0e` → 36.74) and keep the 4 raw bytes in `raw`. The scaling is a
  guess.
- **Sleep HR/SpO₂ samples**: the interval field is assumed to be in seconds.
- **`energy`** in the minute records: the meaning is unknown and it is exported as is.
- HR values 0 and 255, and SpO₂ 0 or above 100, are treated as "not measured". Stress 255 is "not
  measured".

## JSON format: `miband-health/1`

One document, the same for the download and the local MCP server. Types are in
[`src/health/schema.ts`](../src/health/schema.ts).

- **Time**: every timestamp (`t`, `start`, `end`, `…At`) is an ISO 8601 UTC string. The band's own
  timezone is in `timezone.bandOffsetMinutes` (from the newest file), and per daily summary in
  `tzOffsetMinutes`. Daily summaries carry `date`, the band's local calendar day.
- **Units** are listed in the document itself (`units`): steps; metres; kcal; bpm; SpO₂ %; stress
  0-100 (band score); breaths/min; sleep durations in minutes; workout durations in seconds.

```jsonc
{
  "schema": "miband-health/1",
  "exportedAt": "2026-10-25T09:00:00.000Z",
  "generator": "miband-hack",
  "timezone": { "timestamps": "UTC", "bandOffsetMinutes": 420 },
  "range": { "from": "…", "to": "…" },
  "device": { "model": "Xiaomi Smart Band 9", "firmware": "2.3.93" },
  "units": { "heartRate": "beats per minute", "…": "…" },
  "files": [{ "name": "2026/activity/daily/details/20261024T000000Z_00_00_00_v4.bin", "type": "activity", "subtype": "daily", "detail": "details", "version": 4, "t": "…", "tzOffsetMinutes": 420, "size": 2410, "decoded": "full" }],
  "activity": [{ "t": "2026-10-24T00:00:00.000Z", "steps": 12, "distanceM": 9, "activeKcal": 1, "heartRate": 71, "spo2": 97, "stress": 22 }],
  "heartRate": [{ "t": "…", "value": 71, "source": "minute" }],   // source: minute | manual | sleep
  "spo2": [], "stress": [], "respiratoryRate": [],
  "temperature": [{ "t": "…", "value": 36.74, "source": "manual", "raw": "5a0e0000" }],
  "daily": [{ "date": "2026-10-24", "t": "…", "tzOffsetMinutes": 420, "steps": 8421, "hrResting": 58, "standingHours": [8, 9, 14], "…": "…" }],
  "sleep": [{ "start": "…", "end": "…", "inBed": "…", "totalMin": 420, "deepMin": 90, "lightMin": 250, "remMin": 80, "awakeMin": 25, "quality": 85,
              "stages": [{ "t": "…", "stage": "light" }], "source": "sleep_details", "file": "…" }],
  "workouts": [{ "start": "…", "end": "…", "sport": "rowing", "sportCode": 13, "activeSec": 147, "kcal": 14, "hrAvg": 129, "hrMax": 145, "hrMin": 106, "decoded": true, "file": "…" }]
}
```

Heart rate, SpO₂ and stress appear both inside the minute records and as flat series (which also
hold manual and sleep samples). Use the flat series for analysis.

**CSV**: `activity, heartRate, spo2, stress, respiratoryRate, temperature, daily, sleep,
sleepStages, workouts`. Each has a header row, RFC 4180 quoting and the same field names and units
as the JSON.

## Local MCP server

See [`tools/health-mcp/README.md`](../tools/health-mcp/README.md). Tools: `data_info`, `summary`,
`heart_rate`, `steps`, `sleep`, `workouts`, `spo2`, `stress`, `records` (raw query by kind, paged).
They take `from`/`to` (YYYY-MM-DD or ISO 8601) or `days`, and `resolution` (`raw, minute, 5min,
15min, hour, day, auto`). Responses are capped at 5000 points. The queries live in
[`src/health/query.ts`](../src/health/query.ts).

## Untested

- **Everything on a real band**: the `8/1` / `8/2` / `8/3` commands, the activity channel on SPP V2,
  SPP V1, BLE V1 (`0x0053`) and BLE V2, chunk sizes, whether a Mi Band 9/10 answers the "past" list
  at all, the 10 s chunk timeout, and the ack behaviour.
- File layouts against real Mi Band 8/9/10 firmware: daily details, daily summary, sleep stages,
  sleep details, manual samples v2 (tested with synthetic files only). Workout summaries and manual
  samples v1 are tested on real captures from other Xiaomi devices via Gadgetbridge's test suite.
- Temperature scaling, the sleep sample interval unit, the "energy" field.
- The webapp UI was rendered headless; it was never clicked through with a band.
