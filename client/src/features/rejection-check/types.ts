export type RejectionDocumentRole = 'tender' | 'bid';

export type RejectionDocumentTabId = 'tender' | string;

export type RejectionDocumentSource = 'upload' | 'technical-plan';

export type RejectionCheckStep = 'documents' | 'items' | 'results';

export type RejectionResultTab = 'analysis' | 'custom' | 'identity';

export type RejectionCheckResultTab = 'rejection' | 'typo' | 'logic' | 'identity';

export type IdentityCheckCategory =
  | 'person'
  | 'org'
  | 'project'
  | 'contact'
  | 'region'
  | 'english'
  | 'punctuation'
  | 'custom';

export type RejectionExtractionStatus = 'idle' | 'running' | 'success' | 'error';

export type RejectionExtractionSource = 'ai' | 'technical-plan';

export type RejectionCheckRunStatus = 'idle' | 'running' | 'success' | 'error';

export type RejectionFindingType = 'invalidBid' | 'rejectionItem';

export type RejectionFindingSeverity = 'high' | 'medium' | 'low';

export type RejectionBackgroundTaskType = 'rejection-items-extraction' | 'rejection-check-run';

export type RejectionBackgroundTaskStatus = 'running' | 'success' | 'error';

export interface RejectionBackgroundTaskState {
  task_id: string;
  type: RejectionBackgroundTaskType;
  status: RejectionBackgroundTaskStatus;
  progress: number;
  logs: string[];
  started_at: string;
  updated_at: string;
  error?: string;
}

export interface RejectionDocumentContent {
  id: string;
  role: RejectionDocumentRole;
  fileName: string;
  content: string;
  source: RejectionDocumentSource;
  parserLabel?: string;
  importedAt: string;
}

export interface RejectionCheckWorkspaceState {
  tenderDocument: RejectionDocumentContent | null;
  tenderDocuments: RejectionDocumentContent[];
  bidDocuments: RejectionDocumentContent[];
  activeDocumentTab: RejectionDocumentTabId;
  step?: RejectionCheckStep;
  activeResultTab?: RejectionResultTab;
  activeCheckResultTab?: RejectionCheckResultTab;
  invalidBidAndRejectionItems?: RejectionExtractionState;
  customCheckItems?: string;
  identityExtraKeywords?: string;
  checkOptions?: RejectionCheckOptions;
  rejectionCheckResult?: RejectionCheckResultState;
  typoCheckResult?: TypoCheckResultState;
  logicCheckResult?: LogicCheckResultState;
  identityCheckResult?: IdentityCheckResultState;
  extractionTask?: RejectionBackgroundTaskState;
  checkTask?: RejectionBackgroundTaskState;
}

export type RejectionCheckWorkspacePatch = Omit<Partial<RejectionCheckWorkspaceState>,
  'rejectionCheckResult' | 'typoCheckResult' | 'logicCheckResult' | 'identityCheckResult'> & {
  rejectionCheckResult?: Partial<RejectionCheckResultState>;
  typoCheckResult?: Partial<TypoCheckResultState>;
  logicCheckResult?: Partial<LogicCheckResultState>;
  identityCheckResult?: Partial<IdentityCheckResultState>;
};

export interface RejectionCheckOptions {
  rejectionCheck: boolean;
  typoCheck: boolean;
  logicCheck: boolean;
  identityCheck: boolean;
}

export interface RejectionExtractionState {
  status: RejectionExtractionStatus;
  content: string;
  source?: RejectionExtractionSource;
  tenderSignature?: string;
  updatedAt?: string;
  error?: string;
}

export interface RejectionCheckFinding {
  id: string;
  bidDocumentId: string;
  type: RejectionFindingType;
  severity: RejectionFindingSeverity;
  title: string;
  summary: string;
  requirement: string;
  bidEvidence: string;
  riskReason: string;
  suggestion: string;
}

export interface RejectionCheckResultState {
  status: RejectionCheckRunStatus;
  findings: RejectionCheckFinding[];
  inputSignature?: string;
  activeFindingId?: string;
  progressMessage?: string;
  updatedAt?: string;
  error?: string;
}

export interface TypoCheckFinding {
  id: string;
  bidDocumentId: string;
  wrongText: string;
  correctText: string;
  originalExcerpt: string;
  reason: string;
  locationHint?: string;
}

export interface TypoCheckResultState {
  status: RejectionCheckRunStatus;
  findings: TypoCheckFinding[];
  inputSignature?: string;
  activeFindingId?: string;
  progressMessage?: string;
  updatedAt?: string;
  error?: string;
}

export interface LogicCheckFinding {
  id: string;
  bidDocumentId: string;
  title: string;
  originalText: string;
  locationHint: string;
  fallacyReason: string;
  suggestion: string;
}

export interface LogicCheckResultState {
  status: RejectionCheckRunStatus;
  findings: LogicCheckFinding[];
  inputSignature?: string;
  activeFindingId?: string;
  progressMessage?: string;
  updatedAt?: string;
  error?: string;
}

export interface IdentityCheckFinding {
  id: string;
  bidDocumentId: string;
  category: IdentityCheckCategory;
  matchedText: string;
  originalExcerpt: string;
  locationHint: string;
  riskReason: string;
  suggestion: string;
}

export interface IdentityCheckResultState {
  status: RejectionCheckRunStatus;
  findings: IdentityCheckFinding[];
  inputSignature?: string;
  activeFindingId?: string;
  progressMessage?: string;
  updatedAt?: string;
  error?: string;
}

export interface RejectionRiskItem {
  id: string;
  title: string;
  source: string;
  suggestion: string;
  severity: 'low' | 'medium' | 'high';
}

export interface RejectionCheckReport {
  passed: boolean;
  risks: RejectionRiskItem[];
}
