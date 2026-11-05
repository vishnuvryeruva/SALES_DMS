export type Rating = 'High' | 'Medium' | 'Low';

export interface Driver {
  tone: 'positive' | 'warning' | 'negative' | 'info';
  text: string;
}

export interface Period {
  start: string;
  end: string | null;
  availableQty: number;
  unit: string | null;
}

export interface Confirmation {
  date: string;
  qty: number;
  unit: string | null;
}

export interface ApiCall {
  api: string;
  ok: boolean;
  skipped?: boolean;
  durationMs?: number;
  retrievedAt?: string;
  request?: { method: string; path: string; body?: unknown };
  error?: { kind: string; status: number | null; message: string };
  raw?: unknown;
}

export interface AvailabilityEvidence extends ApiCall {
  periods?: Period[];
  unit?: string | null;
  mrpArea?: string;
}

export interface AtpEvidence extends ApiCall {
  confirmations?: Confirmation[];
  totalConfirmed?: number;
  confirmedByRequestedDate?: number;
  lastConfirmationDate?: string | null;
}

export interface PlannedSupplyEvidence extends ApiCall {
  projection?: { date: string; projectedAvailableInventory: number }[];
  plannedOrders?: { quantity: number; availabilityDate: string }[];
}

export interface RequestInput {
  material: string;
  plant: string;
  quantity: number | null;
  unit: string;
  requestedDate: string | null;
  mrpArea?: string;
}

export interface Outcome {
  requestedQty: number;
  requestedDate: string;
  unit: string;
  confirmedQty: number | null;
  confirmedOnTimeQty: number | null;
  confirmedDate: string | null;
  shortfallQty: number | null;
  availableOnRequestedDate: number | null;
  nextAvailable: { date: string; source: string } | null;
  partialShipment: { nowQty: number; nowDate: string; laterQty: number; laterDate: string | null; unconfirmedQty: number } | null;
  coverage: 'full_on_time' | 'full_late' | 'partial' | 'none' | 'unverified';
}

export interface Assessment {
  id: string;
  status: 'assessed';
  createdAt: string;
  dataSource: 'mock' | 'live';
  system: string;
  input: RequestInput;
  rating: Rating;
  headline: string;
  drivers: Driver[];
  assumptions: string[];
  recommendedAction: string;
  outcome: Outcome;
  evidence: { availability: AvailabilityEvidence; atp: AtpEvidence; plannedSupply: PlannedSupplyEvidence };
  disclaimer: string;
}

export interface AvailabilityLookup {
  id: string;
  createdAt: string;
  dataSource: 'mock' | 'live';
  input: RequestInput;
  availableToday: number | null;
  evidence: AvailabilityEvidence;
}

export interface PlannedSupplyLookup {
  id: string;
  createdAt: string;
  dataSource: 'mock' | 'live';
  input: RequestInput;
  evidence: PlannedSupplyEvidence;
}

export type ChatContext = Partial<Pick<RequestInput, 'material' | 'plant' | 'quantity' | 'unit' | 'requestedDate'>>;

export interface ChatReply {
  engine: 'ai-core' | 'rules';
  responseText: string;
  assessments: Assessment[];
  availability: AvailabilityLookup[];
  plannedSupply: PlannedSupplyLookup[];
  context: ChatContext;
  aiError?: string;
  timestamp: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  at: string;
  engine?: ChatReply['engine'];
  assessments?: Assessment[];
  availability?: AvailabilityLookup[];
  plannedSupply?: PlannedSupplyLookup[];
  notice?: string;
  error?: boolean;
}

export interface SampleMaterial {
  material: string;
  plant: string;
  description: string;
  unit: string;
  scenario: string;
  exampleQuantity: number;
  exampleDate: string;
}

export interface Status {
  app: string;
  version: string;
  system: string;
  sap: { mode: 'mock' | 'destination' | 'direct'; target: string; auth?: string; system: string };
  omp: { mode: string; target: string };
  ai: { configured: boolean; model: string };
  rules: { gapTolerancePct: number };
  sampleMaterials: SampleMaterial[];
}

export interface ConnectivityResult {
  sap: Status['sap'];
  checkedAt: string;
  checks: { api: string; ok: boolean; durationMs: number; entitySets?: string[]; error?: string }[];
}

export interface AuditEntry {
  at: string;
  type: string;
  correlationId?: string;
  channel?: string;
  dataSource?: string;
  input?: Partial<RequestInput>;
  rating?: Rating;
  headline?: string;
  calls?: { api: string; ok: boolean; skipped?: boolean; durationMs?: number; error?: string }[];
  checks?: ConnectivityResult['checks'];
}
