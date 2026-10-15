#!/bin/bash
# Long-running service for the R1 test device (linuxserver custom-services.d): Telnet on
# port 23 with the system login, so MapTerm's Telnet support can be tested. The login shell
# is the fake IOS CLI, as over SSH.
exec busybox-extras telnetd -F -p 23 -l /bin/login
