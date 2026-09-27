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

printf '%sREADY %s\n' "$SYSMON_PREFIX" "$SSH_CONNECTION"
while IFS=' ' read -r operation job_id payload; do
  [ "$operation" != QUIT ] || break
  [ "$operation" = RUN ] || continue
  case "$job_id" in ''|*[!0-9]*) continue ;; esac
  command_text=$(printf '%s' "$payload" | base64 -d) || exit 1
  sh -c "$runner" sysmonitor "$command_text" "$SYSMON_PREFIX" "$job_id" < /dev/null
  result=$?
  printf '\n%sEND %s %s\n' "$SYSMON_PREFIX" "$job_id" "$result"
  printf '\n%sEND %s %s\n' "$SYSMON_PREFIX" "$job_id" "$result" >&2
done
