# Backorder Reliability Agent (ATP promise chat)

A chat assistant for J&J MedTech customer service and planners. Ask *"Can we promise 20 EA of material X at plant 1000 by Nov 20?"* and the agent:

1. **Captures context** - material, plant/DC, quantity, unit, requested date (from free text or the structured form; follow-ups like *"what about 50?"* reuse the previous values).
2. **Reads Product Availability** - `API_PRODUCT_AVAILY_INFO` (`ProductMRPArea/DetmAvailabilityTimeSeries`).
3. **Runs a read-only aATP simulation** - `API_AVAIL_TO_PROMISE_CHECK` (`RlvtProductPlant/CheckAvailabilityWithoutResvn`, nothing is reserved).
4. **Adds OMP planned supply** - projected available inventory and planned orders (mocked until the OMP API exists).
5. **Rates reliability High / Medium / Low** with deterministic rules, then explains it and recommends an action: confirmed date, next available date, partial shipment ("X now, Y later").

SAP AI Core (orchestration, `gpt-4o-mini`) handles the conversation and calls the tools. **The model never sets the rating** - it comes from `server/reliability.js` and is shown with its evidence, timestamp and a reference id. Without AI Core the agent falls back to a built-in rule-based parser.

Target system: **DMS - OTC MT2** (MedTech S/4HANA), client 100.

## Run locally

Requires Node 20+.

```bash
npm install
cp .env.example .env      # defaults to mock mode; add AICORE_SERVICE_KEY to use AI Core
npm run dev               # UI http://localhost:5173 (API on :3000)
npm test                  # backend tests
```

Production-style: `npm run build && npm start` and open http://localhost:3000.

### Sample data (mock mode)

Mock mode simulates the two OData services (including CSRF handling and SAP error payloads) and OMP. Dates are relative to today.

| Material / plant | Scenario | Expected rating |
|---|---|---|
| 1000001 / 1000 | Healthy stock, full confirmation | High |
| 1000002 / 1000 | Low stock, receipt in ~2 weeks - partial | Medium |
| 1000003 / 1000 | Backordered, full qty on a later date | Medium |
| 1000004 / 1000 | Stock available but product allocation caps the confirmation | Medium |
| 1000005 / 1000 | No SAP supply, only an OMP planned order | Low |
| 1000006 / 2000 | aATP service returns 503 - fail-safe | Low |
| 1000007 / 1000 | Availability and ATP disagree - needs a documented assumption | Medium |

## Reliability rules

From the proposal, with `RULE_GAP_TOLERANCE_PCT` (default 10%) as the "material gap" threshold. Thresholds need business approval.

| Rating | When |
|---|---|
| **High** | aATP confirms the full quantity on or before the requested date, and availability on that date is consistent with ATP (difference within tolerance). |
| **Medium** | Partial quantity on time, full quantity only on a later date, or a full confirmation that needs a documented assumption (availability and ATP disagree). |
| **Low** | Nothing confirmable, an API failed or is unavailable, a response is empty/incomplete/inconsistent (unit mismatch, more confirmed than requested), or inputs are missing. |

OMP planned orders are shown as information ("not yet in SAP execution") and never raise a rating. Assumptions are listed on every card - by default the requested date is used as the material availability date and the MRP area equals the plant.

## Connecting to DMS OTC MT2

`mtdev.jnj.com` only resolves inside the J&J network, so a laptop outside it cannot call SAP directly. Choose one of three connection modes with `SAP_CONNECTION_MODE`:

### Option A - BTP Destination + Cloud Connector (recommended)

The architecture in the proposal. The app uses the destination **`MT_TRANSCEND_S4_BASIC`** (override with `SAP_DESTINATION_NAME`). If it already exists in the J&J subaccount, only check that the Cloud Connector allows the two service paths in step 1. Otherwise, in the subaccount that has the Cloud Connector to MT dev:

1. **Cloud Connector** - add a system mapping: back-end type *ABAP System*, protocol HTTPS, internal host `mtdev.jnj.com:443`, virtual host e.g. `dms-mt2:443`. Allow resources (path and all sub-paths):
   - `/sap/opu/odata4/sap/api_product_availy_info/`
   - `/sap/opu/odata4/sap/api_avail_to_promise_check/`
2. **Destination** (Connectivity > Destinations):

   | Property | Value |
   |---|---|
   | Name | `MT_TRANSCEND_S4_BASIC` |
   | Type | HTTP |
   | URL | `http://dms-mt2:443` (the virtual host) |
   | Proxy Type | OnPremise |
   | Authentication | BasicAuthentication (technical user) - Principal Propagation later |
   | Location ID | only if the Cloud Connector uses one |
   | Additional property `sap-client` | `100` |

3. Deploy (below). The manifest sets `SAP_CONNECTION_MODE=destination`. If the destination does not carry `sap-client`, run `cf set-env atp-promise-agent SAP_CLIENT 100`.

### Option B - Cloud Integration (CPI) proxy

The OAuth client we received (`sb-c23d3b46-...|it-rt-dev-sfdc-rq24o0we!b56186`) works - the token call returns 200 - but its only scope is `ESBMessaging.send`. It is a **CPI runtime key**, so it can only call an iFlow, not S/4 itself. With an iFlow that proxies both service roots to S/4 (and passes through the `X-CSRF-Token` and cookie headers):

```bash
SAP_CONNECTION_MODE=direct
SAP_BASE_URL=https://<cpi-runtime-host>/http/<iflow-path>
SAP_AUTH_TYPE=oauth2_client_credentials
SAP_TOKEN_URL=https://dev-sfdc-rq24o0we.authentication.us10.hana.ondemand.com/oauth/token
SAP_CLIENT_ID=...
SAP_CLIENT_SECRET=...
# SAP_CSRF=false   if the iFlow fetches the CSRF token itself
```

If the iFlow exposes different paths, set `SAP_AVAILABILITY_SERVICE_PATH` / `SAP_ATP_SERVICE_PATH`.

### Option C - Direct (on the J&J network or VPN)

```bash
SAP_CONNECTION_MODE=direct
SAP_BASE_URL=https://mtdev.jnj.com
SAP_AUTH_TYPE=basic
SAP_USERNAME=...
SAP_PASSWORD=...
SAP_CLIENT=100
```

Note: the service URL in the email ended in `/001`; the one that worked in DMS-100 ends in `/0001`, which is the default here. The earlier HTTPS call returned an HTML login page, which the app reports as "intercepted by a login/SSO page" instead of failing silently.

### Testing the connection

In the app, click the SAP pill > **Test SAP connection**, or:

```bash
curl -X POST http://localhost:3000/api/v1/diagnostics/connectivity
```

This only reads the two service documents and should list the `ProductMRPArea` and `RlvtProductPlant` entity sets.

### SAP-side prerequisites

- Both OData V4 services published in `/IWFND/V4_ADMIN` (service groups for `API_PRODUCT_AVAILY_INFO` and `API_AVAIL_TO_PROMISE_CHECK`).
- The technical (or named) user needs `S_SERVICE` for both services plus read authorization for ATP on the relevant plants and materials (Basis/security to confirm the exact roles).
- The aATP check sends the characteristic catalog values `SD-CUSTOMERGROUP`, `SD_I-SHIPPINGPOINT` (mandatory, SAP KBA 3691877), `SD-SALESDOCUMENTTYPE`, `SD_I_PAR_PF.WE-CUSTOMER`; adjust with `ATP_CHARACTERISTICS` to match the DMS configuration (supply protection, PAL).

## OMP planned supply (proposed contract)

OMP has not published its API yet. The adapter expects the Base MVP fields from the "second call" e-mail, and is easy to change in `server/omp/planned-supply.js`:

```
GET {OMP_BASE_URL}/projected-inventory?material=1000002&plant=1000&fromDate=2026-11-05&toDate=2027-02-03

{ "items": [
  { "material": "1000002", "plant": "1000", "date": "2026-11-09",
    "projectedAvailableInventory": 8, "plannedOrderQuantity": 0, "plannedOrderAvailabilityDate": null },
  { "material": "1000002", "plant": "1000", "date": "2026-12-05",
    "projectedAvailableInventory": 148, "plannedOrderQuantity": 100, "plannedOrderAvailabilityDate": "2026-12-05" }
] }
```

Configure with `OMP_CONNECTION_MODE=direct|destination`, `OMP_BASE_URL` / `OMP_DESTINATION_NAME`, `OMP_AUTH_TYPE`, and `OMP_PROJECTION_PATH`. `OMP_CONNECTION_MODE=off` disables it.

## Deploy to SAP BTP (Cloud Foundry)

Uses the Node.js buildpack (no Docker image). Prerequisites: the destination from Option A, entitlements for **Destination (lite)** and **Connectivity (lite)**, and optionally an **AI Core** instance in the same space.

```bash
cf login -a https://api.cf.us10.hana.ondemand.com --sso     # J&J subaccount org/space
APP_BASIC_AUTH_USER=atp APP_BASIC_AUTH_PASSWORD='<strong password>' ./scripts/deploy-cf.sh
```

The script checks the CF target with you, runs the tests and build, creates and binds the destination and connectivity instances, binds the first `aicore` instance in the space (or `AICORE_INSTANCE=<name>`), sets the shared login, and starts the app. Audit lines appear in `cf logs atp-promise-agent` as `[AUDIT] {...}`.

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/chat` | `{ message, history[], context }` -> reply text, assessments, context for follow-ups |
| POST | `/api/v1/assess` | Structured check `{ material, plant, quantity, unit?, requestedDate }` -> assessment (400 with `missing` if incomplete). Suitable as a Joule Studio / SAP Build action. |
| GET | `/api/v1/availability?material=&plant=` | Availability time series only |
| GET | `/api/v1/planned-supply?material=&plant=` | OMP planned supply only |
| GET | `/api/v1/status` | Connection modes, AI Core status, sample materials |
| POST | `/api/v1/diagnostics/connectivity` | Read-only check of both SAP service documents |
| GET | `/api/v1/audit?limit=50` | Recent audit entries |
| GET | `/api/v1/health` | Health check (no login) |

## Guardrails

- **Read-only.** Only `CheckAvailabilityWithoutResvn` and the availability determination actions are called, so nothing is reserved. The agent has no write tools and declines requests to change orders.
- **Decision support.** Every result is labelled as decision support and shows its timestamp, inputs, API results and assumptions.
- **Fails safe.** Errors, timeouts, login pages and inconsistent data produce a Low rating with the reason; nothing is guessed.
- **Audit.** Each check is logged with its inputs, API calls, rule outcome and reference id (stdout, `data/audit.jsonl`, and the in-app audit log).
- **User authorization (MVP).** All SAP calls use the destination's technical user. Principal Propagation is the next step to enforce each user's own SAP authorizations.

## Open questions for the J&J team

1. Which BTP subaccount / CF org and space holds the destination `MT_TRANSCEND_S4_BASIC` (and the Cloud Connector to MT dev), so we can deploy there? Does the destination carry `sap-client=100`, and does its Cloud Connector mapping allow the two ATP service paths?
2. If CPI is the intended path (the OAuth key we received is a CPI runtime key): which iFlow URL proxies the two ATP services?
3. Technical user for DMS-100 and its roles for both services.
4. Test materials, plants and quantities in DMS-100 with known stock and ATP behaviour (also requested by Pramod).
5. Is the characteristic catalog / supply protection active, and which characteristics must be sent (shipping point, customer group, sales document type, ship-to)?
6. OMP API contract and timeline (Chandra).
7. AI Core instance and model access in the target subaccount.
8. Business sign-off on the High/Medium/Low thresholds and the 10% gap tolerance.

## Project layout

```
server/
  index.js, app.js          Express server, REST API, static UI
  config.js                 all settings from environment variables
  http/transport.js         direct (basic/OAuth2) and BTP Destination transports
  sap/odata.js              OData V4 client: CSRF handshake, ETag retry, SAP error parsing
  sap/services.js           availability + aATP adapters and response normalization
  sap/mock-dms.js           simulated DMS system and sample materials
  omp/planned-supply.js     OMP adapter
  reliability.js            High/Medium/Low rules
  assessment.js             end-to-end workflow, input validation, audit records
  agent/                    AI Core tool-calling agent, rule-based fallback parser
src/                        React chat UI (assessment cards, chart, audit/connection panel)
scripts/deploy-cf.sh        Cloud Foundry deployment
```
