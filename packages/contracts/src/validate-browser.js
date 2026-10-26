import * as generatedValidators from './browser-validators.generated.js';
import { browserContractNames } from './browser-contracts.js';

const validators = new Map(browserContractNames.map((name) => [name, generatedValidators[name]]));

export function validateContract(name, value) {
  const validate = validators.get(name);
  if (!validate) throw new RangeError(`unknown generated contract: ${name}`);
  const valid = validate(value);
  return {
    valid,
    errors: valid ? [] : (validate.errors ?? []).map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message })),
  };
}
