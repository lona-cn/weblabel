# Build context is the expanded Linux x64 portable bundle, never the checkout.
# Base digest: https://hub.docker.com/v2/repositories/library/debian/tags/trixie-slim
FROM --platform=linux/amd64 debian:trixie-slim@sha256:62bd423aeee912639ca8ee681c2b762cb3e25137e0a92b20be455898a9f034ad

RUN apt-get update \
    && apt-get install -y --no-install-recommends tini curl ca-certificates libgcc-s1 libstdc++6 \
    && useradd --create-home --uid 1000 --user-group weblabel \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt/weblabel
COPY --chown=root:root release/ ./release/
# Executing the real runtime doctor verifies loader/architecture and every v2 hash.
# Missing native libraries or an incompatible release are build failures.
RUN ./release/weblabel doctor --build-dir /opt/weblabel/release --mode runtime \
    && chmod -R a-w release && chmod 0555 release/weblabel \
    && mkdir -p /data/tmp && chown -R 1000:1000 /data && chmod 0700 /data /data/tmp

ENV TMPDIR=/data/tmp
VOLUME ["/data"]
# Preserve the former portable image's numeric data ownership across the cutover.
USER 1000:1000
# Native Linux host networking, one loopback origin; no published/public ports.
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=5s --timeout=5s --start-period=30s --retries=6 CMD ["/usr/bin/curl", "--fail", "--silent", "--show-error", "--max-time", "2", "http://127.0.0.1:48100/ready"]
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["/opt/weblabel/release/weblabel", "serve", "--build-dir", "/opt/weblabel/release", "--data-dir", "/data"]
