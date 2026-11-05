import 'dotenv/config';

function str(name, fallback = '') {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value.trim();
}

function bool(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

function num(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && process.env[name] !== '' ? value : fallback;
}

function list(name, fallback) {
  const value = str(name);
  return value ? value.split(',').map((s) => s.trim()).filter(Boolean) : fallback;
}

/**
 * Connection settings for one upstream (SAP S/4HANA or OMP), read from env vars sharing a prefix.
 * mode: mock | destination | direct  (OMP additionally supports: off)
 */
function upstream(prefix, defaults) {
  return {
    mode: str(`${prefix}_CONNECTION_MODE`, defaults.mode).toLowerCase(),
    destinationName: str(`${prefix}_DESTINATION_NAME`, defaults.destinationName || ''),
    baseUrl: str(`${prefix}_BASE_URL`).replace(/\/+$/, ''),
    defaultQuery: defaults.defaultQuery || {},
    timeoutMs: num(`${prefix}_TIMEOUT_MS`, 20000),
    csrf: bool(`${prefix}_CSRF`, defaults.csrf ?? true),
    auth: {
      type: str(`${prefix}_AUTH_TYPE`, 'none').toLowerCase(),
      username: str(`${prefix}_USERNAME`),
      password: str(`${prefix}_PASSWORD`),
      tokenUrl: str(`${prefix}_TOKEN_URL`),
      clientId: str(`${prefix}_CLIENT_ID`),
      clientSecret: str(`${prefix}_CLIENT_SECRET`),
      scope: str(`${prefix}_SCOPE`),
    },
  };
}

const sapClient = str('SAP_CLIENT');

export const config = {
  port: num('PORT', 3000),
  nodeEnv: str('NODE_ENV', 'development'),
  systemLabel: str('SAP_SYSTEM_LABEL', 'DMS OTC MT2 (client 100)'),

  sap: {
    ...upstream('SAP', {
      mode: 'mock',
      destinationName: 'DMS_MT2_S4',
      defaultQuery: sapClient ? { 'sap-client': sapClient } : {},
    }),
    availabilityServicePath: str(
      'SAP_AVAILABILITY_SERVICE_PATH',
      '/sap/opu/odata4/sap/api_product_availy_info/srvd_a2x/sap/apiproductavailyinfo/0001/'
    ),
    atpServicePath: str(
      'SAP_ATP_SERVICE_PATH',
      '/sap/opu/odata4/sap/api_avail_to_promise_check/srvd_a2x/sap/apiavailtopromisecheck/0001/'
    ),
  },

  atp: {
    checkingRule: str('ATP_CHECKING_RULE', 'A'),
    considerProductAllocation: bool('ATP_CONSIDER_PRODUCT_ALLOCATION', true),
    documentPurpose: str('ATP_DOCUMENT_PURPOSE', 'SLS'),
    // Time of day (UTC) sent with the requested date as ProductAvailabilityUTCDateTime.
    requestTimeUtc: str('ATP_REQUEST_TIME_UTC', '18:00:00'),
    characteristicNames: list('ATP_CHARACTERISTICS', [
      'SD-CUSTOMERGROUP',
      'SD_I-SHIPPINGPOINT',
      'SD-SALESDOCUMENTTYPE',
      'SD_I_PAR_PF.WE-CUSTOMER',
    ]),
    // Characteristics sent to the availability time series call (supply protection matching). Empty = none sent.
    availabilityCharacteristicNames: list('AVAILABILITY_CHARACTERISTICS', []),
    defaultUnit: str('DEFAULT_UNIT', 'EA'),
  },

  rules: {
    // A difference between the availability snapshot and the ATP confirmation above this share of the
    // requested quantity counts as a "material gap".
    gapTolerancePct: num('RULE_GAP_TOLERANCE_PCT', 10),
  },

  omp: upstream('OMP', { mode: 'mock', csrf: false }),
  ompProjectionPath: str(
    'OMP_PROJECTION_PATH',
    '/projected-inventory?material={material}&plant={plant}&fromDate={fromDate}&toDate={toDate}'
  ),
  ompHorizonDays: num('OMP_HORIZON_DAYS', 90),

  ai: {
    serviceKey: str('AICORE_SERVICE_KEY'),
    model: str('AICORE_MODEL', 'gpt-4o-mini'),
    enabled: bool('AI_ENABLED', true),
  },

  audit: {
    file: str('AUDIT_LOG_FILE', 'data/audit.jsonl'),
    keep: num('AUDIT_MEMORY_ENTRIES', 200),
  },

  basicAuth: {
    user: str('APP_BASIC_AUTH_USER'),
    password: str('APP_BASIC_AUTH_PASSWORD'),
  },
};
