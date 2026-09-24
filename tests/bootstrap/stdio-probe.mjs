let pending = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) {
  pending += chunk;
  let newline;
  while ((newline = pending.indexOf('\n')) !== -1) {
    const line = pending.slice(0, newline).replace(/\r$/, '');
    pending = pending.slice(newline + 1);
    try {
      const request = JSON.parse(line);
      if (request.protocol_version !== 1 || request.kind !== 'request' || request.method !== 'probe') {
        throw new Error('unsupported probe request');
      }
      process.stdout.write(`${JSON.stringify({
        protocol_version: 1,
        id: request.id,
        kind: 'response',
        method: 'probe',
        payload: { runtime_version: process.version },
      })}\n`);
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      process.stdin.destroy();
      break;
    }
  }
}
if (pending.length > 0 && process.exitCode !== 1) {
  process.stderr.write('incomplete NDJSON line\n');
  process.exitCode = 1;
}
