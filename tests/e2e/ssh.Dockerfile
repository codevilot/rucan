FROM rust:1-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ssux-agent ./crates/ssux-agent
COPY packages/protocol ./packages/protocol
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --locked --release -p ssux-agent \
    && cp /src/target/release/ssux-agent /ssux-agent

FROM scratch AS artifact
COPY --from=builder /ssux-agent /ssux-agent

FROM alpine:3.22 AS remote
RUN apk add --no-cache openssh \
    && adduser -D ssux \
    && passwd -d ssux \
    && mkdir -p /home/ssux/.ssh /run/sshd \
    && chown -R ssux:ssux /home/ssux/.ssh \
    && chmod 700 /home/ssux/.ssh
CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=no"]

FROM remote AS remote-tmux
RUN apk add --no-cache tmux
