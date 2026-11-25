FROM rust:1-alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates/ssui-agent ./crates/ssui-agent
COPY packages/protocol ./packages/protocol
RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --locked --release -p ssui-agent \
    && cp /src/target/release/ssui-agent /ssui-agent

FROM scratch AS artifact
COPY --from=builder /ssui-agent /ssui-agent

FROM alpine:3.22 AS remote
RUN apk add --no-cache openssh \
    && adduser -D ssui \
    && passwd -d ssui \
    && mkdir -p /home/ssui/.ssh /run/sshd \
    && chown -R ssui:ssui /home/ssui/.ssh \
    && chmod 700 /home/ssui/.ssh
CMD ["sh", "-c", "ssh-keygen -A && exec /usr/sbin/sshd -D -e -o PasswordAuthentication=no -o KbdInteractiveAuthentication=no -o PermitRootLogin=no"]

FROM remote AS remote-tmux
RUN apk add --no-cache tmux
