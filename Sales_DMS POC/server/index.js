import { config } from './config.js';
import { createApp } from './app.js';
import { isAiConfigured } from './agent/ai-core.js';

const app = createApp(config);

app.listen(config.port, () => {
  const sapTarget = config.sap.mode === 'destination' ? `destination ${config.sap.destinationName}` : config.sap.mode === 'direct' ? config.sap.baseUrl : 'sample data';
  console.log('==============================================');
  console.log('  Backorder Reliability Agent');
  console.log(`  http://localhost:${config.port}`);
  console.log(`  SAP : ${config.sap.mode} (${sapTarget})`);
  console.log(`  OMP : ${config.omp.mode}`);
  console.log(`  AI  : ${isAiConfigured(config.ai) ? `SAP AI Core (${config.ai.model})` : 'not configured - rule-based parser'}`);
  console.log('==============================================');
});
