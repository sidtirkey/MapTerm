#!/bin/bash
# A small imitation of a Cisco IOS command line, used as the login shell of the
# "fake-ios" test container. Covers what MapTerm has to cope with on real gear:
# ">" / "#" / "(config)#" prompts, enable with a password, a --More-- pager,
# [confirm] questions and "% Invalid input" errors, and CDP / LLDP neighbor tables read from
# /neighbors/<hostname>.cdp.txt and .lldp.txt (absent file = protocol not enabled).
# Enable password: cisco
HOST=$(hostname)
# Each lab device's serial number (and, for the Catalyst-like core-sw, base MAC), as real
# devices print them in "show version"; neighbor discovery uses them to tell devices apart.
case "$HOST" in
  R1) SERIAL=FTX2201A0R1 ;;
  R2) SERIAL=FGL2304B0R2 ;;
  core-sw) SERIAL=FOC2311X0CS; BASE_MAC=00:aa:bb:cc:00:03 ;;
  *) SERIAL=FTX0000A000 ;;
esac
ENABLE_SECRET=cisco
mode=user   # user | priv | conf | if
len=24      # lines per page; "terminal length 0" turns paging off

prompt() {
  case $mode in
    user) printf '%s>' "$HOST" ;;
    priv) printf '%s#' "$HOST" ;;
    conf) printf '%s(config)#' "$HOST" ;;
    if)   printf '%s(config-if)#' "$HOST" ;;
  esac
}
invalid() { printf "%% Invalid input detected at '^' marker.\n\n"; }
need_priv() { [ "$mode" = user ] && { invalid; return 1; }; return 0; }

# Print stdin through a --More-- pager, like IOS does.
page() {
  local n=0 key
  while IFS= read -r l; do
    if [ "$len" -gt 0 ] && [ "$n" -ge $((len - 1)) ]; then
      printf ' --More-- '
      IFS= read -rsn1 key </dev/tty
      printf '\b\b\b\b\b\b\b\b\b\b          \b\b\b\b\b\b\b\b\b\b'
      [ "$key" = q ] && return
      n=0
    fi
    printf '%s\n' "$l"; n=$((n + 1))
  done
}

show_version() {
  {
    echo "Cisco IOS Software, Fake-IOS Software (MAPTERM-TEST), Version 15.9(3)M, RELEASE SOFTWARE"
    echo "Technical Support: http://www.example.com/techsupport"
    echo ""
    echo "$HOST uptime is 3 weeks, 2 days, 4 hours, 11 minutes"
    echo "System image file is \"flash:fake-ios.bin\""
    for i in $(seq 1 30); do echo "Feature line $i: enabled"; done
    echo ""
    echo "Processor board ID $SERIAL"
    if [ -n "$BASE_MAC" ]; then
      echo "Base Ethernet MAC Address          : $BASE_MAC"
      echo "System Serial Number               : $SERIAL"
    fi
    echo ""
    echo "Configuration register is 0x2102"
  } | page
}
# "show cdp neighbors detail" / "show lldp neighbors detail" (and abbreviations like
# "sh cdp nei det"), from this device's neighbor file.
neighbors() {
  local file="/neighbors/$HOST.$1.txt"
  if [ -f "$file" ]; then page < "$file"; else printf '%% %s is not enabled\n' "${1^^}"; fi
}

show_ip_int_brief() {
  printf '%-22s %-15s %-4s %-7s %-21s %s\n' Interface IP-Address OK? Method Status Protocol
  printf '%-22s %-15s %-4s %-7s %-21s %s\n' GigabitEthernet0/0 10.0.0.1 YES NVRAM up up
  printf '%-22s %-15s %-4s %-7s %-21s %s\n' GigabitEthernet0/1 10.0.1.1 YES NVRAM up up
  printf '%-22s %-15s %-4s %-7s %-21s %s\n' GigabitEthernet0/2 unassigned YES unset "administratively down" down
}

trap '' INT
while true; do
  prompt
  IFS= read -r line || exit 0
  line=${line%$'\r'}
  cmd=$(echo "$line" | tr -s ' ' | sed 's/^ //; s/ $//')
  [ -z "$cmd" ] && continue
  # "do <exec command>" from config modes
  if [ "$mode" = conf ] || [ "$mode" = if ]; then
    case $cmd in do\ *) cmd=${cmd#do }; saved=$mode; mode=priv ;; *) saved= ;; esac
  else saved=; fi

  case "$mode:$cmd" in
    user:en|user:ena|user:enable)
      printf 'Password: '; IFS= read -rs pw; echo
      if [ "${pw%$'\r'}" = "$ENABLE_SECRET" ]; then mode=priv; else printf '%% Bad secrets\n\n'; fi ;;
    priv:disable) mode=user ;;
    *:"terminal length "*|*:"term len "*|*:"term length "*) len=${cmd##* } ;;
    user:sh\ ver*|user:show\ ver*|priv:sh\ ver*|priv:show\ ver*) show_version ;;
    *:"sh ip int br"*|*:"show ip interface brief"*|*:"show ip int brief"*) show_ip_int_brief ;;
    user:sh*\ cdp\ nei*\ det*|priv:sh*\ cdp\ nei*\ det*) neighbors cdp ;;
    user:sh*\ lldp\ nei*\ det*|priv:sh*\ lldp\ nei*\ det*) neighbors lldp ;;
    *:"sh run"*|*:"show run"*|*:"show running-config"*)
      need_priv && { printf 'Building configuration...\n\n'; printf 'hostname %s\n!\ninterface GigabitEthernet0/0\n ip address 10.0.0.1 255.255.255.0\n!\nend\n\n' "$HOST" | page; } ;;
    priv:"conf t"|priv:"configure terminal"|priv:config*)
      echo "Enter configuration commands, one per line.  End with CNTL/Z."; mode=conf ;;
    conf:int*|conf:interface*|if:int*|if:interface*) mode=if ;;
    conf:"hostname "*) HOST=${cmd#hostname } ;;
    if:exit) mode=conf ;;
    conf:exit|if:end|conf:end) mode=priv ;;
    conf:*|if:*) ;;   # any other configuration line is accepted silently
    priv:wr|priv:write|priv:"write memory"|priv:"copy run start"|priv:"copy running-config startup-config")
      printf 'Building configuration...\n[OK]\n' ;;
    priv:reload)
      printf 'Proceed with reload? [confirm]'; IFS= read -rsn1 k; echo; echo "Reload cancelled (this is a test device)." ;;
    *:exit|*:logout|*:quit) exit 0 ;;
    *) invalid ;;
  esac
  [ -n "$saved" ] && mode=$saved
done
