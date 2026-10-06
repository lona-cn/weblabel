"""Sanitize only ephemeral test authentication; retain behavioral IDs and PNG bytes."""
from pathlib import Path
import hashlib
import json
import zipfile
root = Path(__file__).resolve().parent
receipts = []
for trace in root.glob('browser-artifacts/**/trace.zip'):
    with zipfile.ZipFile(trace) as archive:
        entries = [(entry, archive.read(entry.filename)) for entry in archive.infolist()]
    secrets = set()
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
    for entry, data in entries:
        if entry.filename.endswith('.network'):
            for line in data.decode().splitlines():
                snapshot = json.loads(line).get('snapshot', {})
                for message in [snapshot.get('request', {}), snapshot.get('response', {})]:
                    for header in message.get('headers', []):
                        if header.get('name', '').lower() in ['cookie', 'set-cookie', 'x-csrf-token', 'authorization']:
                            value = header.get('value', '')
                            secrets.add(value)
                            for segment in value.split(';'):
                                if segment.strip().startswith('weblabel_session='):
                                    secrets.add(segment.split('=', 1)[1].strip())
                    for cookie in message.get('cookies', []):
                        secrets.add(cookie.get('value', ''))
        if entry.filename.startswith('resources/'):
            try:
                collect(json.loads(data))
            except (ValueError, UnicodeDecodeError):
                pass
    secrets.discard('')
    approved = {'device-loss-canvas-before', 'device-loss-canvas-after', 'device-loss-surface-observations', 'native-session-parity', 'long-alert-viewport-invariance', 'workbench-held-tools-and-real-resize'}
    blobs = {entry.filename: data for entry, data in entries}
    for line in blobs.get('test.trace', b'').decode().splitlines():
        for attachment in json.loads(line).get('attachments', []):
            name = attachment.get('name')
            if name not in approved:
                continue
            data = blobs[attachment['file']]
            suffix = '.png' if attachment['contentType'] == 'image/png' else '.json'
            if suffix == '.json':
                text = data.decode()
                for secret in sorted(secrets, key=len, reverse=True):
                    text = text.replace(secret, '[REDACTED_EPHEMERAL_TEST_AUTH]')
                data = text.encode()
            (trace.parent / (name + suffix)).write_bytes(data)
    before = hashlib.sha256(trace.read_bytes()).hexdigest()
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
                replacements += text.count(secret)
                text = text.replace(secret, '[REDACTED_EPHEMERAL_TEST_AUTH]')
            output.writestr(entry, text.encode())
    temporary.replace(trace)
    receipts.append({'trace': str(trace.relative_to(root)), 'before_sha256': before, 'after_sha256': hashlib.sha256(trace.read_bytes()).hexdigest(), 'replacements': replacements, 'ids_and_png_evidence_preserved': True})
(root / 'trace-redaction.json').write_text(json.dumps(receipts, indent=2), encoding='utf-8')
print(json.dumps({'traces_sanitized':len(receipts)}))
