#!/bin/bash
# Runs at container start (linuxserver custom-cont-init.d): make the fake IOS CLI the
# login shell of the SSH user.
install -m 755 /fake-ios.sh /usr/local/bin/fake-ios
grep -qx /usr/local/bin/fake-ios /etc/shells || echo /usr/local/bin/fake-ios >> /etc/shells
sed -i "s#^\(${USER_NAME:-admin}:.*:\)[^:]*\$#\1/usr/local/bin/fake-ios#" /etc/passwd
# R1 also serves Telnet when the telnetd service is mounted (see docker-compose.yml).
if [ -e /custom-services.d/telnetd ]; then apk add --no-cache busybox-extras >/dev/null; fi
