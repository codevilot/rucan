FROM rust:1-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/tman-agent ./crates/tman-agent
COPY packages/protocol ./packages/protocol
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --locked --release -p tman-agent \
    && cp /src/target/release/tman-agent /tman-agent

FROM scratch AS artifact
COPY --from=builder /tman-agent /tman-agent

FROM alpine:3.22 AS remote
RUN apk add --no-cache openssh \
    && adduser -D tman \
    && passwd -d tman \
    && mkdir -p /home/tman/.ssh /run/sshd \
    && chown -R tman:tman /home/tman/.ssh \
    && chmod 700 /home/tman/.ssh
CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=no"]

FROM remote AS remote-tmux
RUN apk add --no-cache tmux
