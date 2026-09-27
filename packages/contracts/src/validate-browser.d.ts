export interface ContractValidationError {
  instancePath: string;
  keyword: string;
  message?: string;
}

export interface ContractValidationResult {
  valid: boolean;
  errors: ContractValidationError[];
}

export function validateContract(name: string, value: unknown): ContractValidationResult;
