if [ "$SYSMON_REQUIRE_LINUX" = 1 ] && [ "$(uname -s)" != Linux ]; then
  printf '%sNONLINUX\n' "$SYSMON_PREFIX"
  exit 65
fi
umask 077
work=$(mktemp -d "${TMPDIR:-/tmp}/sysmonitor.XXXXXXXX") || exit 1
grouped=0
command -v setsid >/dev/null 2>&1 && grouped=1

kill_command() {
  case "$1" in ''|0|*[!0-9]*) return ;; esac
  if [ "$grouped" = 1 ]; then kill -KILL -- "-$1" 2>/dev/null; fi
  kill -KILL "$1" 2>/dev/null || :
}

cancel_job() {
  [ -f "$work/$1.job" ] || return
  touch "$work/$1.cancel"
  if [ ! -f "$work/$1.job" ]; then
    rm -f "$work/$1.cancel"
    return
  fi
  if [ -f "$work/$1.pid" ]; then
    { IFS= read -r cancel_pid < "$work/$1.pid"; } 2>/dev/null || return
    kill_command "$cancel_pid"
  fi
}

cleanup() {
  trap - EXIT HUP INT TERM
  for job_file in "$work"/*.job; do
    [ -f "$job_file" ] || continue
    job_id=${job_file##*/}
    cancel_job "${job_id%.job}"
  done
  wait
  rm -rf "$work"
}
trap cleanup EXIT
trap 'exit 0' HUP INT TERM

run_job() (
  trap - EXIT HUP INT TERM
  job_id=$1
  limit=$2
  active_pid=
  cleanup_job() {
    if [ -n "$active_pid" ]; then
      kill_command "$active_pid"
      wait "$active_pid" 2>/dev/null
    fi
    if [ "$work/$job_id.job" -ef "$work/output-lock" ]; then rm -f "$work/output-lock"; fi
    rm -f "$work/$job_id.out" "$work/$job_id.err" "$work/$job_id.pid" "$work/$job_id.job" "$work/$job_id.cancel"
  }
  trap cleanup_job EXIT
  trap 'exit 0' HUP INT TERM
  command_text=$(printf '%s' "$3" | base64 -d) || exit 1
  # Bound temporary output even if a command produces an unexpected amount.
  ulimit -f "$((limit / 512 + 1))" 2>/dev/null || :
  if [ "$grouped" = 1 ]; then
    setsid sh -c "$command_text" > "$work/$job_id.out" 2> "$work/$job_id.err" &
  else
    sh -c "$command_text" > "$work/$job_id.out" 2> "$work/$job_id.err" &
  fi
  job_pid=$!
  active_pid=$job_pid
  printf '%s\n' "$job_pid" > "$work/$job_id.pid"
  [ ! -f "$work/$job_id.cancel" ] || cancel_job "$job_id"
  wait "$job_pid" 2>/dev/null
  result=$?
  active_pid=
  rm -f "$work/$job_id.pid"
  if [ ! -f "$work/$job_id.cancel" ]; then
    bytes=$(wc -c < "$work/$job_id.out")
    err_bytes=$(wc -c < "$work/$job_id.err")
    limited=0
    if [ "$bytes" -gt "$limit" ] || [ "$err_bytes" -gt "$limit" ]; then limited=1; fi
    # Only result emission is serialized; commands run independently.
    while ! ln "$work/$job_id.job" "$work/output-lock" 2>/dev/null; do
      [ ! -f "$work/$job_id.cancel" ] || exit 0
      sleep 0.01
    done
    [ ! -f "$work/$job_id.cancel" ] || exit 0
    printf '%sBEGIN %s %s %s\n' "$SYSMON_PREFIX" "$job_id" "$result" "$limited"
    head -c "$limit" "$work/$job_id.out" | base64 | tr -d '\n'
    printf '\n'
    head -c "$limit" "$work/$job_id.err" | base64 | tr -d '\n'
    printf '\n%sEND %s\n' "$SYSMON_PREFIX" "$job_id"
  fi
)

printf '%sREADY %s\n' "$SYSMON_PREFIX" "$SSH_CONNECTION"
while IFS=' ' read -r operation job_id limit payload; do
  case "$job_id" in ''|*[!0-9]*) [ "$operation" = QUIT ] && break; continue ;; esac
  case "$operation" in
    RUN)
      case "$limit" in ''|*[!0-9]*) continue ;; esac
      touch "$work/$job_id.job"
      run_job "$job_id" "$limit" "$payload" &
      ;;
    CANCEL) cancel_job "$job_id" ;;
  esac
done
