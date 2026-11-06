processes=$(ps -eo pid=,user:32=,%cpu=,rss=,lstart=,args=) || exit $?
gpu_status=0
gpu_processes=
if [ "$1" = 1 ] && command -v nvidia-smi > /dev/null 2>&1; then
  gpu_processes=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null) || gpu_status=$?
fi

{
  printf '%s\n' "$gpu_processes"
  printf '__SYSMON_PROCESS_ROWS__\n'
  printf '%s\n' "$processes"
} | awk -v gpu_status="$gpu_status" '
function offer(kind, pid, value,    n, i, previous) {
  n = sizes[kind]
  if (n == 100) {
    previous = ranks[kind, n]
    if (value < scores[kind, previous] || (value == scores[kind, previous] && pid > previous)) return
  } else n++
  i = n
  while (i > 1) {
    previous = ranks[kind, i - 1]
    if (value < scores[kind, previous] || (value == scores[kind, previous] && pid > previous)) break
    ranks[kind, i] = previous
    i--
  }
  ranks[kind, i] = pid
  scores[kind, pid] = value
  sizes[kind] = n
}
$0 == "__SYSMON_PROCESS_ROWS__" { processes = 1; next }
!processes {
  if (gpu_status == 0 && split($0, fields, ",") == 2) {
    gsub(/^[ \t]+|[ \t]+$/, "", fields[1])
    gsub(/^[ \t]+|[ \t]+$/, "", fields[2])
    if (fields[1] ~ /^[0-9]+$/ && fields[2] ~ /^[0-9]+([.][0-9]+)?$/) gpu[fields[1] + 0] += fields[2]
  }
  next
}
NF { observed++ }
$1 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+([.][0-9]+)?$/ && $4 ~ /^[0-9]+$/ && NF >= 10 {
  parsed++
  if ($4 * 1024 <= 1000000 && $3 <= 0) next
  pid = $1 + 0
  if (pid in rows) next
  rows[pid] = $0
  total++
  offer(1, pid, $3 + 0)
  offer(2, pid, $4 + 0)
  if (gpu_status == 0) offer(3, pid, gpu[pid] + 0)
}
END {
  if (observed && !parsed) exit 65
  printf "__SYSMON_PROCESSES__ %d %d\n", total, gpu_status
  for (kind = 1; kind <= 3; kind++) {
    for (i = 1; i <= sizes[kind]; i++) {
      pid = ranks[kind, i]
      if (!seen[pid]++) print rows[pid]
    }
  }
}'
