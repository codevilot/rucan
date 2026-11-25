# Performance methodology

Run `pnpm poc` from a development checkout with Rust and Bash, Zsh and Vim installed. The probe builds a debug PTY harness before timing. Each case measures wall-clock time from child spawn through terminal parsing and checks a screen marker. Vim must enter and exit the alternate buffer. The rapid-output case must show the last line and respect the scrollback cap. Fixture startup, intentional Vim delay, parsing and I/O are included in the reported duration.

For the future agent, record OS, kernel, CPU, memory, terminal and runtime versions. Use release builds and report sample counts and p50/p95 across warm and cold runs. Sample idle CPU and resident memory with 1, 10 and 50 sessions. Record descriptors before and after attach/detach loops. Measure PTY throughput, slow-consumer queue limits, directory listing latency and reconnect recovery independently. Separate network round trips from local switching and input-to-render latency. Measure bounded resource behavior over a sustained run before drawing conclusions.

## Phase 0 reference run

Apple M1, macOS 26.5.2, Node 22.22.1, Rust 1.91.1. Single run with an 80×24 viewport and a 1,000-line scrollback cap. Other validation jobs were running concurrently.

| Case         | PTY bytes |  Wall time |
| ------------ | --------: | ---------: |
| Bash         |        11 |   621.1 ms |
| Zsh          |        10 |    36.3 ms |
| Vim          |     2,135 |   210.6 ms |
| Rapid output |   170,000 | 4,651.2 ms |

The probe waits for the parser callback after each read. The rapid case reached the last line and stayed within the scrollback cap. Treat the timing as an end-to-end fixture result. Future throughput benchmarks should separately measure generation, PTY reads, parsing and display. Test bounded batches before choosing a client update cadence.

## Native agent measurements

Run `pnpm benchmark` to build a release agent and measure local Unix socket operations. The harness runs real idle PTY sessions at counts of 1, 10 and 50. It measures 35 attach/snapshot/detach and connect/handshake/snapshot cycles, 15 interactive input samples, and a two-second idle CPU window. The one-session case also measures directory browsing and a roughly 1.45 MiB shell output fixture. Timings end at IPC decode, before physical terminal display.

Apple M1, macOS 26.5.2, Node 22.22.1, Rust 1.91.1, 80×24 PTYs. These are results from one local run.

| Sessions | Agent startup |  Idle RSS | Switch p95 | Reconnect p95 | Input to snapshot p95 |
| -------: | ------------: | --------: | ---------: | ------------: | --------------------: |
|        1 |     545.54 ms | 2,768 KiB |    1.39 ms |       1.31 ms |               4.56 ms |
|       10 |      17.38 ms | 4,448 KiB |    0.93 ms |       1.00 ms |               0.91 ms |
|       50 |      14.82 ms | 8,480 KiB |    1.70 ms |       3.13 ms |               4.38 ms |

The first startup ran the newly built executable. Empty-agent RSS ranged from 2,240 to 2,272 KiB. No idle CPU time was visible at the reporting precision of `ps` in the two-second samples. The output fixture yielded 9,030 KiB/s from create through the final parsed marker. Listing a 1,000-entry directory with the current 500-entry limit took 10.61 ms at p95. The numbers exclude network RTT, SSH reconnect, terminal presentation, and long-duration resource stability.

Set `SSUX_BENCH_SOAK_SECONDS=30` to repeat attach, snapshot and detach in the 50-session case. A separate 30-second run completed 1,079 cycles. The agent had 162 file descriptors before and after. RSS changed from 7,296 KiB before the loop to 5,936 KiB after it. This run checks short-term cleanup and does not establish overnight stability.
