FROM rust:1-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/rucan-agent ./crates/rucan-agent
COPY packages/protocol ./packages/protocol
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --locked --release -p rucan-agent \
    && cp /src/target/release/rucan-agent /rucan-agent

FROM scratch AS artifact
COPY --from=builder /rucan-agent /rucan-agent

FROM alpine:3.22 AS remote
RUN apk add --no-cache openssh \
    && adduser -D rucan \
    && passwd -d rucan \
    && mkdir -p /home/rucan/.ssh /run/sshd \
    && chown -R rucan:rucan /home/rucan/.ssh \
    && chmod 700 /home/rucan/.ssh
CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=no"]

FROM remote AS remote-tmux
RUN apk add --no-cache tmux
