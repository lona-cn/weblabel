# Build context MUST be the expanded Linux x64 release bundle, not the repository.
# docker build --platform linux/amd64 -f <repo>/Dockerfile <dist>/bundle
# Ubuntu 24.04 builds require glibc 2.39; Debian Trixie supplies glibc 2.41.
FROM --platform=linux/amd64 node:24.16.0-trixie-slim@sha256:45fbb3ca3b6c7e6646cd2889d0ac7bf314bb180036da792221fc2f48fe4d43fb

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini procps \
    && test -x /usr/bin/tini && test -x /bin/kill && command -v ps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/weblabel
COPY --chown=root:root release/ ./release/
COPY --chown=root:root scripts/ ./scripts/
COPY --chown=root:root release/migrations/ ./crates/weblabel-api/migrations/
# Validate exact Node, release hashes, ELF architecture and actual ldd resolution.
# A missing shared library is a build failure, never an ignored warning.
RUN node --input-type=module -e 'import assert from "node:assert/strict"; import fs from "node:fs"; import {spawnSync} from "node:child_process"; import {requireNode,files} from "./scripts/build.mjs"; import {validateRelease} from "./scripts/start-local.mjs"; requireNode(); assert.equal(process.platform,"linux"); assert.equal(process.arch,"x64"); const {manifest,api}=validateRelease("/opt/weblabel/release"); assert.match(manifest.source_commit,/^[0-9a-f]{40}$/); assert.deepEqual(files("/opt/weblabel/release").filter(p=>p!=="release.json"),manifest.files.map(f=>f.path).sort()); const h=Buffer.alloc(64),fd=fs.openSync(api,"r"); try{assert.equal(fs.readSync(fd,h,0,64,0),64)}finally{fs.closeSync(fd)} assert.equal(h.subarray(0,6).toString("hex"),"7f454c460201"); assert.equal(h.readUInt16LE(18),62); const r=spawnSync("ldd",[api],{encoding:"utf8",timeout:30000}); process.stdout.write(r.stdout??""); process.stderr.write(r.stderr??""); assert.equal(r.error,undefined); assert.equal(r.status,0); assert.doesNotMatch((r.stdout??"")+(r.stderr??""),/not found/i);' \
    && chmod -R a-w release scripts crates \
    && chmod 0555 release/api/weblabel-api \
    && mkdir -p /data/tmp && chown -R node:node /data && chmod 0700 /data /data/tmp

ENV NODE_ENV=production TMPDIR=/data/tmp
VOLUME ["/data"]
USER node
# Native Linux host networking is required. Do not publish ports or change binds.
# UI http://127.0.0.1:48100; native API http://127.0.0.1:48101.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=10s --start-period=30s --retries=6 CMD ["node", "--input-type=module", "-e", "for(const [url,status] of [['http://127.0.0.1:48100/',200],['http://127.0.0.1:48100/api/session',401],['http://127.0.0.1:48101/health',204]]) { const r=await fetch(url,{signal:AbortSignal.timeout(2500),redirect:'error'}); if(r.status!==status)process.exit(1); await r.arrayBuffer(); }"]
# Tini is always present as PID 1. Preserve the launcher's real signal exit 130.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "/opt/weblabel/scripts/start-local.mjs", "--build-dir", "/opt/weblabel/release", "--data-dir", "/data"]
