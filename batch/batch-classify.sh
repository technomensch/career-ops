#!/usr/bin/env bash
# batch/batch-classify.sh — pure helper functions for classifying a dead
# batch worker as environmentally interrupted vs. a genuine logical failure.
# Sourced by batch-runner.sh; no side effects, no `main`, safe to source
# standalone for testing.

# True (exit 0) if exit_code indicates the process was killed by a signal
# (128 + signal number), excluding 130 (SIGINT) -- that's the user's own
# Ctrl-C and must still abort normally rather than being retried.
is_signal_killed() {
  local exit_code="$1"
  (( exit_code >= 128 && exit_code != 130 ))
}

# True (exit 0) if the worker log contains a known interruption signature
# -- laptop sleep or a generic network-disruption error. Phrase list starts
# narrow (the actually-observed message plus common Node network error
# codes) and is expected to grow from real usage.
is_interruption_signature_log() {
  local log_file="$1"
  grep -Eiq '(computer went to sleep|network (is )?unreachable|connection reset|econnreset|etimedout|enotfound|getaddrinfo|socket hang up)' "$log_file"
}

# Extract the last ```json fenced block from a worker log. Prints empty
# string if none found. This is the one authoritative result object a
# worker emits on completion (batch-prompt.md Step 6) -- not arbitrary
# text anywhere else in the log.
extract_worker_result_json() {
  local log_file="$1"
  awk '
    /^```json[[:space:]]*$/ { in_block=1; block=""; next }
    in_block && /^```[[:space:]]*$/ { in_block=0; last=block; next }
    in_block { block = block $0 "\n" }
    END { printf "%s", last }
  ' "$log_file" 2>/dev/null || true
}

# True (exit 0) if the log contains a parseable JSON object with a string
# `status` field -- i.e. the worker reasoned to a conclusion and
# self-reported it, regardless of exit code. False means the log just
# stops mid-stream with nothing authoritative.
has_worker_terminal_verdict() {
  local log_file="$1"
  local json
  json=$(extract_worker_result_json "$log_file")
  [[ -n "$json" ]] || return 1
  printf '%s' "$json" | node -e '
    let data = "";
    process.stdin.on("data", d => data += d);
    process.stdin.on("end", () => {
      try {
        const obj = JSON.parse(data);
        process.exit(typeof obj.status === "string" ? 0 : 1);
      } catch {
        process.exit(1);
      }
    });
  ' 2>/dev/null
}
