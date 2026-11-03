# ACI Baltic Proxy

Cloudflare Worker — Elering dashboard API (Estonian electricity and gas)
and ENTSOG Transparency Platform (Finnish–Baltic gas transmission). Both
upstreams are public; no API key.

A relay, not an interpreter: parameters are forwarded unchanged, values are
not modified. Two known silent failure modes are detected and reported in
`_warnings`, without changing the request.

## Routes

    /                               route index
    ?el=<group>/<path>&start=..&end=..   Elering: /api/<group>/<path>
    ?el_spec=1                      Elering OpenAPI path list (tries known spec URLs)
    ?eg=<endpoint>&...              ENTSOG: /api/v1/<endpoint>
    ?eg_points=<term>               ENTSOG operatorPointDirections filtered by term

Elering groups (first path segment): nps, system, balance, transmission,
gas_system, gas_transmission, gas_trade, gas_balance, gas_border_trade,
capacity, nominations, green, umm (hyphenated variants also accepted).

ENTSOG endpoints (user manual v3.0, 1.10.2025): operationalDatas,
aggregatedData, connectionPoints, interconnections, aggregateInterconnections,
operatorPointDirections, operators, balancingZones, cmp*, interruptions,
urgentMarketMessages. Endpoint casing is normalised to the manual's spelling.

## Traps

- **ENTSOG `limit` defaults to 100.** Without `limit=-1` the response is
  silently truncated. The proxy warns but does not add it.
- **ENTSOG time zone:** the manual promises consistent conversion only for
  `timezone=WET`. Others are warned.
- **ENTSOG indicators are case-sensitive** (`Physical Flow`, `Firm Technical`).
  Spaces are encoded as `%20`, not `+`, matching the manual's examples.
- **Elering `start`/`end` without an offset are read as UTC.** Warned.
- **Elering paths are not documented here as verified.** Get them from
  `?el_spec=1` first. Group names come from the elering-py library docs.
- **ENTSOG pointDirection codes are not guessable.** Find them with
  `?eg_points=balticconnector`. Use the returned `pointDirection`
  (operatorKey+pointKey+directionKey), **not** `id` — `id` returns 404.
  Direction is from the operator's view: at a storage point `exit` = grid →
  storage (injection), `entry` = storage → grid (withdrawal).
- Upstream errors (including 429) are returned as errors, never as empty data.

## Storage levels

Inčukalns stock and fill level are not in ENTSOG transmission data. They are
in GIE AGSI+ (agsi.gie.eu), which needs a free API key — not included here.

## Status

Live-tested 3.11.2026.

- `?el_spec=1` finds the spec at `/v3/api-docs`, 64 paths. Groups use
  hyphens (`gas-system`, `gas-transmission`, `gas-neutrality`).
- Verified Elering paths: `system/with-plan`, `transmission/cross-border`
  (fields `finland`, `latvia`, `estlink_1`, `estlink_2`; negative = import
  to Estonia), `gas-transmission/cross-border` (`bc` = Balticconnector,
  `volume` per hour, `direction`).
- Verified ENTSOG point codes: Balticconnector `FI-TSO-0003ITP-00550exit|entry`
  (Gasgrid), `EE-TSO-0001ITP-00550exit|entry` (Elering); Inčukalns
  `LV-TSO-0001UGS-00029exit|entry` (Conexus). Values in kWh/d.

## Cache

Workers Cache (`wrangler.toml` `[cache] enabled = true`). Data 15 min,
catalogues and specs 24 h.
