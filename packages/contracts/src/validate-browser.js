import Ajv from 'ajv';
import runEvent from '../generated/run_event.schema.json';
import suggestionSet from '../generated/suggestion_set.schema.json';
import bootstrapStatus from '../generated/bootstrap_status.schema.json';

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat('uint64', { type: 'number', validate: (value) => Number.isSafeInteger(value) && value >= 0 });
ajv.addFormat('double', { type: 'number', validate: Number.isFinite });
const validators = new Map([
  ['bootstrap_status', ajv.compile(bootstrapStatus)],
  ['run_event', ajv.compile(runEvent)],
  ['suggestion_set', ajv.compile(suggestionSet)],
]);

export function validateContract(name, value) {
  const validate = validators.get(name);
  if (!validate) throw new RangeError(`unknown generated contract: ${name}`);
  const valid = validate(value);
  return {
    valid,
    errors: valid ? [] : (validate.errors ?? []).map(({ instancePath, keyword, message }) => ({ instancePath, keyword, message })),
  };
}
