# Multi-stage Rust build. Pure-Rust TLS (rustls) → no OpenSSL system deps.
# Build with low parallelism on RAM-tight hosts:
#   docker build --build-arg CARGO_BUILD_JOBS=1 -t qs-v2-api .
FROM rust:1-slim-bookworm AS build
WORKDIR /app
ARG CARGO_BUILD_JOBS=1
ENV CARGO_BUILD_JOBS=${CARGO_BUILD_JOBS} \
    CARGO_NET_RETRY=5 \
    CARGO_INCREMENTAL=0

# Cache dependencies against a dummy main so source edits don't re-fetch/rebuild crates.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main() { println!("stub"); }' > src/main.rs \
    && cargo build --release || true
# Real sources.
COPY src ./src
RUN touch src/main.rs && cargo build --release

FROM debian:bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=build /app/target/release/queryschema-v2 /usr/local/bin/queryschema-v2
ENV PORT=3010
EXPOSE 3010
CMD ["queryschema-v2"]
