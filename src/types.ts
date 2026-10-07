export type ScanMode = "lr" | "serpentine";
export type BoundaryPolicy = "discard";

export interface DitherRequest {
  matrix: number[][];
  mode: ScanMode;
  boundaryPolicy?: BoundaryPolicy;
}

export interface ActualReceiver {
  row: number;
  col: number;
  weight: number;
  share: number;
}

export interface PixelRecord {
  row: number;
  col: number;
  scanIndex: number;
  original: number;
  receivedError: number;
  workingValue: number;
  output: 0 | 255;
  pixelError: number;
  actualReceivers: ActualReceiver[];
}

export interface ErrorSummary {
  originalSum: number;
  outputSum: number;
  sumDifference: number;
  discardedErrorSum: number;
  distributedErrorSum: number;
  blackPixels: number;
  whitePixels: number;
  originalAverage: number;
  outputAverage: number;
  tolerance: number;
  accountDifference: number;
  accountBalanced: boolean;
}

export interface DitherResult {
  width: number;
  height: number;
  mode: ScanMode;
  boundaryPolicy: BoundaryPolicy;
  ruleVersion: string;
  output: number[][];
  pixels: PixelRecord[];
  summary: ErrorSummary;
  calculationComplete: boolean;
  traceComplete: boolean;
  traceBudget: number | null;
  traceTruncated: boolean;
  truncationReason: string | null;
}
