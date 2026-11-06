if [ "$SYSMON_REQUIRE_LINUX" = 1 ] && [ "$(uname -s)" != Linux ]; then
  printf '%sNONLINUX\n' "$SYSMON_PREFIX"
  exit 65
fi

runner='
command_text=$1
prefix=$2
request_id=$3
if { IFS= read -r stat < "/proc/$$/stat"; } 2>/dev/null &&
   { IFS= read -r boot < /proc/sys/kernel/random/boot_id; } 2>/dev/null; then
  fields=${stat##*) }
  set -- $fields
  shift 19
  printf "%sSTART %s %s %s %s\n" "$prefix" "$request_id" "$$" "$1" "$boot"
else
  printf "%sSTART %s - - -\n" "$prefix" "$request_id"
fi
exec sh -c "$command_text"
'

timeout_available=0
if command -v timeout > /dev/null 2>&1; then
  timeout -k 1 0.01 sleep 1 < /dev/null > /dev/null 2>&1
  [ "$?" != 124 ] || timeout_available=1
fi
run_command() {
  if [ "$timeout_available" = 1 ]; then
    timeout -k 1 "$budget" sh -c "$runner" sysmonitor "$command_text" "$SYSMON_PREFIX" "$job_id"
  else
    sh -c "$runner" sysmonitor "$command_text" "$SYSMON_PREFIX" "$job_id"
  fi
}
finish_request() {
  printf '\n%sEND %s %s\n' "$SYSMON_PREFIX" "$job_id" "$1"
  printf '\n%sEND %s %s\n' "$SYSMON_PREFIX" "$job_id" "$1" >&2
}
printf '%sREADY %s %s\n' "$SYSMON_PREFIX" "$timeout_available" "$SSH_CONNECTION"
while IFS=' ' read -r operation job_id payload budget input_payload; do
  [ "$operation" != QUIT ] || break
  [ "$operation" = RUN ] || continue
  case "$job_id" in ''|*[!0-9]*) continue ;; esac
  case "$budget" in
    ''|.|*[!0-9.]*|*.*.*)
      printf 'Invalid timeout budget: %s\n' "$budget" >&2
      finish_request 2
      continue
      ;;
  esac
  command_text=$(printf '%s' "$payload" | base64 -d) || exit 1
  if [ -n "$input_payload" ]; then
    printf '%s' "$input_payload" | base64 -d | run_command
  else
    run_command < /dev/null
  fi
  finish_request "$?"
done
