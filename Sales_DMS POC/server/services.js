import { createTransport } from './http/transport.js';
import { createODataClient } from './sap/odata.js';
import { createMockTransport } from './sap/mock-dms.js';
import { createAvailabilityService, createAtpService } from './sap/services.js';
import { createPlannedSupplyService } from './omp/planned-supply.js';

/** Wires the SAP and OMP services for the configured connection modes. */
export function createServices(config, { mockOptions } = {}) {
  const mockPaths = {
    availabilityServicePath: config.sap.availabilityServicePath,
    atpServicePath: config.sap.atpServicePath,
    ompProjectionPath: config.ompProjectionPath,
  };

  const sapTransport = config.sap.mode === 'mock' ? createMockTransport(mockPaths, mockOptions) : createTransport(config.sap);
  const odata = createODataClient(sapTransport, { csrf: config.sap.csrf });

  let ompTransport = null;
  if (config.omp.mode === 'mock') ompTransport = createMockTransport(mockPaths, mockOptions);
  else if (config.omp.mode !== 'off') ompTransport = createTransport(config.omp);

  return {
    sapMode: config.sap.mode,
    ompMode: config.omp.mode,
    sapTransport,
    odata,
    availability: createAvailabilityService({ odata, servicePath: config.sap.availabilityServicePath, atpConfig: config.atp }),
    atp: createAtpService({ odata, servicePath: config.sap.atpServicePath, atpConfig: config.atp }),
    plannedSupply: createPlannedSupplyService({
      transport: ompTransport,
      projectionPath: config.ompProjectionPath,
      horizonDays: config.ompHorizonDays,
      mode: config.omp.mode,
    }),
    describe() {
      return {
        sap: { ...sapTransport.describe(), system: config.systemLabel },
        omp: ompTransport ? ompTransport.describe() : { mode: 'off', target: 'Not connected' },
      };
    },
  };
}
