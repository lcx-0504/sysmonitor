gpu_enabled=$1
refresh_interval=$2
proc=${SYSMON_PROC_ROOT:-/proc}
tab=$(printf '\t')
stat_reader='
function uptime_text(    file, line, fields) {
  file = proc "/uptime"
  if ((getline line < file) <= 0) { close(file); return "" }
  close(file)
  split(line, fields, " ")
  return (fields[1] ~ /^[0-9]+([.][0-9]+)?$/) ? fields[1] : ""
}
function read_uptime(    text) {
  text = uptime_text()
  return text == "" ? -1 : text + 0
}
function read_stat(file,    line, part, fields) {
  if ((getline line < file) <= 0) { close(file); return 0 }
  while ((getline part < file) > 0) line = line "\n" part
  close(file)
  stat_pid = line
  sub(/[ \t].*/, "", stat_pid)
  sub(/^.*\) /, "", line)
  if (stat_pid !~ /^[0-9]+$/ || split(line, fields, " ") < 20) return 0
  if (fields[12] !~ /^[0-9]+$/ || fields[13] !~ /^[0-9]+$/ || fields[20] !~ /^[0-9]+$/) return 0
  stat_pid += 0
  stat_ticks = fields[12] + fields[13]
  stat_start = fields[20] + 0
  return 1
}
'
baseline=$(printf '%s\n' "$proc"/[0-9]* | awk -v proc="$proc" "$stat_reader"'
BEGIN { print uptime_text() }
read_stat($0 "/stat") { printf "%.0f %.0f %.0f\n", stat_pid, stat_start, stat_ticks }
')
clock_ticks=$(getconf CLK_TCK 2>/dev/null)
case $clock_ticks in ''|*[!0-9]*|0) clock_ticks=100 ;; esac

processes=$(ps -eo pid=,ppid=,uid=,user:32=,rss=,lstart=,args=)
ps_status=$?
[ "$ps_status" != 127 ] || exit 127
[ "$ps_status" = 0 ] || exit 65
gpu_status=0
gpu_processes=
if [ "$gpu_enabled" = 1 ] && command -v nvidia-smi > /dev/null 2>&1; then
  gpu_processes=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null) || gpu_status=$?
fi
user_id=
tmux_panes=
screen_sessions=
if command -v tmux > /dev/null 2>&1 || command -v screen > /dev/null 2>&1; then
  user_id=$(id -u 2>/dev/null)
  if command -v tmux > /dev/null 2>&1; then
    tmux_panes=$(tmux list-panes -a -F "#{pane_pid}${tab}#{session_name}" 2>/dev/null) || tmux_panes=
  fi
  if command -v screen > /dev/null 2>&1; then
    screen_sessions=$(screen -ls 2>/dev/null)
  fi
fi

started=${baseline%%[!0-9.]*}
delay=$(awk -v proc="$proc" -v started="$started" -v interval="$refresh_interval" "$stat_reader"'BEGIN {
  window = interval / 2
  if (!(window > 0) || window > 1) window = 1
  now = read_uptime()
  if (started != "" && now >= 0 && window - (now - started) > 0) printf "%.2f\n", window - (now - started)
}')
if [ -n "$delay" ]; then
  sleep "$delay" 2> /dev/null || sleep 1
fi

{
  printf '%s\n' "$baseline"
  printf '__SYSMON_GPU__\n'
  printf '%s\n' "$gpu_processes"
  printf '__SYSMON_TMUX__\n'
  printf '%s\n' "$tmux_panes"
  printf '__SYSMON_SCREEN__\n'
  printf '%s\n' "$screen_sessions"
  printf '__SYSMON_PS__\n'
  printf '%s\n' "$processes"
} | awk -v proc="$proc" -v clock_ticks="$clock_ticks" -v gpu_enabled="$gpu_enabled" -v gpu_status="$gpu_status" -v user_id="$user_id" "$stat_reader"'
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
function session_of(pid,    depth) {
  for (depth = 0; depth < 64 && pid > 1; depth++) {
    if (pid in tmux) return "tmux\t" tmux[pid]
    if (pid in screen) return "screen\t" screen[pid]
    if (!(pid in parent)) return ""
    pid = parent[pid]
  }
  return ""
}
BEGIN { section = "baseline" }
$0 == "__SYSMON_GPU__" { section = "gpu"; next }
$0 == "__SYSMON_TMUX__" { section = "tmux"; next }
$0 == "__SYSMON_SCREEN__" { section = "screen"; next }
$0 == "__SYSMON_PS__" { section = "ps"; next }
section == "baseline" {
  if (!baseline_started) { started = $1; baseline_started = 1 }
  else if (NF == 3) { base_start[$1] = $2; base_ticks[$1] = $3 }
  next
}
section == "gpu" {
  if (gpu_status == 0 && split($0, fields, ",") == 2) {
    gsub(/^[ \t]+|[ \t]+$/, "", fields[1])
    gsub(/^[ \t]+|[ \t]+$/, "", fields[2])
    if (fields[1] ~ /^[0-9]+$/ && fields[2] ~ /^[0-9]+([.][0-9]+)?$/) gpu[fields[1] + 0] += fields[2]
  }
  next
}
section == "tmux" {
  separator = index($0, "\t")
  pane = substr($0, 1, separator - 1)
  if (separator > 1 && separator < length($0) && pane ~ /^[0-9]+$/) tmux[pane + 0] = substr($0, separator + 1)
  next
}
section == "screen" {
  if (split($0, fields, "\t") >= 3 && fields[1] == "" && fields[2] ~ /^[0-9]+[.]./) {
    server = fields[2]
    sub(/[.].*/, "", server)
    screen[server + 0] = fields[2]
  }
  next
}
NF { observed++ }
$1 ~ /^[0-9]+$/ && $2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $5 ~ /^[0-9]+$/ && NF >= 11 {
  parsed++
  pid = $1 + 0
  parent[pid] = $2 + 0
  if (pid in rss) next
  owner[pid] = $3
  user[pid] = $4
  rss[pid] = $5 + 0
  line = $0
  sub(/^[ \t]*[0-9]+[ \t]+[0-9]+[ \t]+[0-9]+[ \t]+[^ \t]+[ \t]+/, "", line)
  rest[pid] = line
  order[++count] = pid
}
END {
  if (observed && !parsed) exit 65
  finished = read_uptime()
  if (started !~ /^[0-9]+([.][0-9]+)?$/ || finished < 0) {
    print "Process CPU sampling requires " proc "/uptime" > "/dev/stderr"
    exit 1
  }
  window = finished - started
  for (i = 1; i <= count; i++) {
    pid = order[i]
    if (!read_stat(proc "/" pid "/stat") || stat_pid != pid) continue
    if ((pid in base_start) && base_start[pid] == stat_start) {
      elapsed = window
      ticks = stat_ticks - base_ticks[pid]
    } else {
      elapsed = finished - stat_start / clock_ticks
      ticks = stat_ticks
    }
    usage = (elapsed > 0 && ticks > 0) ? int(ticks / clock_ticks / elapsed * 1000 + 0.5) / 10 : 0
    if (rss[pid] * 1024 <= 1000000 && usage <= 0) continue
    cpu[pid] = usage
    total++
    if (usage > 0) offer(1, pid, usage)
    offer(2, pid, rss[pid])
    if (gpu_enabled == 1 && gpu_status == 0 && gpu[pid] > 0) offer(3, pid, gpu[pid])
  }
  printf "__SYSMON_PROCESSES__ %d %d\n", total, gpu_status
  for (kind = 1; kind <= 3; kind++) {
    for (i = 1; i <= sizes[kind]; i++) {
      pid = ranks[kind, i]
      if (seen[pid]++) continue
      printf "%d %s %.1f %s\n", pid, user[pid], cpu[pid], rest[pid]
      selected[++selected_count] = pid
    }
  }
  print "__SYSMON_SESSIONS__"
  if (user_id == "") exit
  for (i = 1; i <= selected_count; i++) {
    pid = selected[i]
    if (owner[pid] != user_id) continue
    session = session_of(pid)
    if (session != "") print pid "\t" session
  }
}'
