import { createServices } from './services.js';
import { createAuditLog } from './audit.js';

export function testConfig(overrides = {}) {
  return {
    port: 0,
    nodeEnv: 'test',
    systemLabel: 'DMS OTC MT2 (test)',
    sap: {
      mode: 'mock',
      destinationName: '',
      baseUrl: '',
      defaultQuery: {},
      timeoutMs: 5000,
      csrf: true,
      auth: { type: 'none' },
      availabilityServicePath: '/sap/opu/odata4/sap/api_product_availy_info/srvd_a2x/sap/apiproductavailyinfo/0001/',
      atpServicePath: '/sap/opu/odata4/sap/api_avail_to_promise_check/srvd_a2x/sap/apiavailtopromisecheck/0001/',
      ...overrides.sap,
    },
    atp: {
      checkingRule: 'A',
      considerProductAllocation: true,
      documentPurpose: 'SLS',
      requestTimeUtc: '18:00:00',
      characteristicNames: ['SD-CUSTOMERGROUP', 'SD_I-SHIPPINGPOINT', 'SD-SALESDOCUMENTTYPE', 'SD_I_PAR_PF.WE-CUSTOMER'],
      availabilityCharacteristicNames: [],
      defaultUnit: 'EA',
    },
    rules: { gapTolerancePct: 10 },
    omp: { mode: 'mock', auth: { type: 'none' }, defaultQuery: {}, timeoutMs: 5000, csrf: false, ...overrides.omp },
    ompProjectionPath: '/projected-inventory?material={material}&plant={plant}&fromDate={fromDate}&toDate={toDate}',
    ompHorizonDays: 90,
    ai: { serviceKey: '', model: 'gpt-4o-mini', enabled: false },
    audit: { file: '', keep: 50, stdout: false },
    basicAuth: { user: '', password: '' },
    ...overrides.top,
  };
}

export function testDeps(overrides) {
  const config = testConfig(overrides);
  const services = createServices(config, { mockOptions: { latencyMs: 0 } });
  const audit = createAuditLog(config.audit);
  return { config, services, audit };
}
