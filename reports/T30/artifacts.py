"""Extract consumer requests and sanitize ephemeral transport secrets without changing IDs or behavioral evidence."""
from pathlib import Path
import hashlib
import json
import sys
import zipfile

root = Path(__file__).resolve().parent
ledger = root / 'trace-redaction.json'
redactions = json.loads(ledger.read_text(encoding='utf-8')) if '--sanitize' in sys.argv and ledger.exists() else []
processed = 0
for trace in root.rglob('trace.zip'):
    if 'gpu-recovery-fix' in trace.relative_to(root).parts:
        continue
    with zipfile.ZipFile(trace) as archive:
        entries = [(entry, archive.read(entry.filename)) for entry in archive.infolist()]
    for entry, data in entries:
        if entry.filename == 'test.trace':
            for line in data.decode('utf-8').splitlines():
                event = json.loads(line)
                for attachment in event.get('attachments', []):
                    if attachment.get('name') in ['device-loss-canvas-before', 'device-loss-canvas-after', 'device-loss-surface-observations']:
                        content = next(blob for info, blob in entries if info.filename == attachment['file'])
                        suffix = '.json' if attachment.get('contentType') == 'application/json' else '.png'
                        (trace.parent / (attachment['name'] + suffix)).write_bytes(content)
    secrets = set()
    previews = []
    for entry, data in entries:
        if entry.filename.endswith('.network'):
            for line in data.decode('utf-8').splitlines():
                event = json.loads(line)
                snapshot = event.get('snapshot', {})
                request = snapshot.get('request', {})
                for message in [request, snapshot.get('response', {})]:
                    for header in message.get('headers', []):
                        if header.get('name', '').lower() in ['cookie', 'set-cookie', 'x-csrf-token', 'authorization']:
                            value = header.get('value', '')
                            secrets.add(value)
                            if header.get('name', '').lower() in ['cookie', 'set-cookie']:
                                for segment in value.split(';'):
                                    if '=' in segment and segment.strip().lower().startswith('weblabel_session='):
                                        secrets.add(segment.split('=', 1)[1].strip())
                    for cookie in message.get('cookies', []):
                        secrets.add(cookie.get('value', ''))
                if request.get('url', '').endswith('/api/ai/previews'):
                    file = request.get('postData', {}).get('_file')
                    if file:
                        original = next(blob for info, blob in entries if info.filename == file)
                        previews.append({'request': json.loads(original), 'status': snapshot.get('response', {}).get('status'), 'trace': str(trace.relative_to(root))})
        if entry.filename.startswith('resources/'):
            try:
                value = json.loads(data)
            except (ValueError, UnicodeDecodeError):
                continue
            def collect(value):
                if isinstance(value, dict):
                    for key, child in value.items():
                        if key in ['password', 'csrf_token'] and isinstance(child, str):
                            secrets.add(child)
                        else:
                            collect(child)
                elif isinstance(value, list):
                    for child in value:
                        collect(child)
            collect(value)
    if previews:
        (trace.parent / 'preview-requests.json').write_text(json.dumps(previews, indent=2), encoding='utf-8')
    secrets.discard('')
    secrets.discard('[REDACTED_EPHEMERAL_TEST_AUTH]')
    if '--sanitize' not in sys.argv:
        continue
    if not secrets:
        continue
    previous = hashlib.sha256(trace.read_bytes()).hexdigest()
    temporary = trace.with_suffix('.sanitized.zip')
    replacements = 0
    with zipfile.ZipFile(temporary, 'w', compression=zipfile.ZIP_DEFLATED) as output:
        for entry, data in entries:
            try:
                text = data.decode('utf-8')
            except UnicodeDecodeError:
                output.writestr(entry, data)
                continue
            for secret in sorted(secrets, key=len, reverse=True):
                occurrences = text.count(secret)
                if occurrences:
                    text = text.replace(secret, '[REDACTED_EPHEMERAL_TEST_AUTH]')
                    replacements += occurrences
            output.writestr(entry, text.encode('utf-8'))
    temporary.replace(trace)
    redactions.append({'trace': str(trace.relative_to(root)), 'previous_sha256': previous, 'sanitized_sha256': hashlib.sha256(trace.read_bytes()).hexdigest(), 'replacements': replacements, 'operation_run_revision_ids_preserved': True})
    processed += 1
if '--sanitize' in sys.argv:
    ledger.write_text(json.dumps(redactions, indent=2), encoding='utf-8')
print(json.dumps({'traces': sum('gpu-recovery-fix' not in trace.relative_to(root).parts for trace in root.rglob('trace.zip')), 'sanitized': processed, 'mode': 'sanitize' if '--sanitize' in sys.argv else 'extract'}, indent=2))
