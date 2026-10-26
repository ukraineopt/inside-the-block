# Stage 1: the QUIC sidecar (sender/), a ~250-line Rust program on quinn + rustls.
FROM rust:1.91-slim-bookworm AS sender
WORKDIR /src
COPY sender/Cargo.toml sender/Cargo.lock ./
COPY sender/src ./src
RUN cargo build --release --locked

# Stage 2: the experiment. Zero runtime npm dependencies: Node 24 runs the TypeScript sources directly.
FROM node:24.11.1-bookworm-slim
WORKDIR /app
COPY --from=sender /src/target/release/tpu-send /usr/local/bin/tpu-send
COPY package.json tsconfig.json ./
COPY src ./src
COPY test ./test
ENV DATA_DIR=/app/data KEYPAIR_PATH=/keys/burner.json NODE_NO_WARNINGS=1
USER node
ENTRYPOINT ["node", "src/main.ts"]
CMD ["all"]
